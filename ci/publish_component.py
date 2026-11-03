"""Publish the exact qualified original using the pinned AutolifeRelease-V3 main client."""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

COMPONENT = 'gmr'
RELEASE_SHA = '4ce9a02f8cdc129c0fbf6099f318eed2c6d2375a'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def development_original(directory, control_path):
    """Compare the three downloaded attachments to the separately admitted producer control."""
    require(control_path.is_file() and not control_path.is_symlink() and control_path.stat().st_size <= 1024**2,
            'Invalid producer control')
    control = json.loads(control_path.read_text())
    delivery = control['delivery']
    require(control['schema'] == 'autolife.development-control/1' and control['upload'] is True
            and control['component'] == COMPONENT and control['repository'] == os.environ['GITHUB_REPOSITORY']
            and delivery['kind'] == 'development', 'Development control does not authorize this upload')
    files = list(directory.iterdir())
    require(len(files) == 3 and all(f.is_file() and not f.is_symlink() for f in files), 'Unexpected attachments')
    original, = (f for f in files if f.name.endswith('.tar.gz'))
    proof, sums = directory/'delivery-manifest.json', directory/'SHA256SUMS'
    require(proof.stat().st_size <= 1024**2 and sums.stat().st_size < 8192, 'Oversized attachment')
    original_hash = digest(original)
    expected = dict(schema='autolife.component-delivery/1', component=COMPONENT, version=delivery['version'],
                    source_sha=delivery['source_sha'], tree_sha=control['tree_sha'], source_dirty=False,
                    delivery=delivery, files=[dict(path=original.name, sha256=original_hash, size=original.stat().st_size)])
    require(json.loads(proof.read_text()) == expected, 'Original differs from admitted development source')
    require(sums.read_text() == f'{original_hash}  {original.name}\n{digest(proof)}  delivery-manifest.json\n',
            'Checksum inventory differs')
    return original, delivery['release_version']


def formal_original(directory):
    script = """
const result = require(process.argv[1]).validate(process.argv[2], {
  ref: process.env.GITHUB_REF, eventName: process.env.GITHUB_EVENT_NAME,
  sha: process.env.GITHUB_SHA, runId: Number(process.env.GITHUB_RUN_ID)
});
process.stdout.write(JSON.stringify(result));
"""
    checked = json.loads(subprocess.check_output(
        ['node', '-e', script, str(Path(__file__).with_name('publish.cjs').resolve()), str(directory)], text=True))
    name, = [n for n in checked['names'] if n.endswith('.tar.gz')]
    return directory/name, checked['proof']['delivery']['release_version']


def load_release(root):
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root)
    require(sha == RELEASE_SHA and not dirty, 'Expected a clean checkout of the pinned Release main commit')
    sys.path.insert(0, str(root))
    return importlib.import_module('autolife_release.ota.component_versions')


def publish(directory, release_root, control):
    directory = directory.resolve()
    original, version = development_original(directory, control) if control else formal_original(directory)
    kind = 'development' if control else 'formal'
    versions = load_release(release_root.resolve())
    url = os.environ['AUTOLIFE_PUBLISH_URL'].rstrip('/')
    token = os.environ.pop('AUTOLIFE_PUBLISH_TOKEN')
    require(url and token, 'Publication credentials unavailable')
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        repository = work/'repository'
        manifest = versions.create(repository, COMPONENT, original, delivery_metadata=directory/'delivery-manifest.json')
        value = manifest['component_release']
        require((value['component'], value['qualification'], value['version']) == (COMPONENT, kind, version),
                'Release import changed the producer identity')
        token_path = work/'token'
        token_path.touch(mode=0o600)
        token_path.write_text(token)
        config = work/'publisher.toml'
        config.write_text('[publish]\nbackend = "api"\nurl = '+json.dumps(url)+
                          '\ntoken_file = '+json.dumps(str(token_path))+'\n')
        state = versions.publish(repository, COMPONENT, version, config, journal_dir=work/'journals')
        require(state['phase'] == 'committed' and state.get('delivery', {}).get('status') == 'verified'
                and re.fullmatch('[a-f0-9]{32}', state['id']), 'Server did not verify this original')
        return dict(component=COMPONENT, version=version, qualification=kind, channel='dev',
                    id=state['id'], phase=state['phase'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--release-tools', required=True, type=Path)
    parser.add_argument('--development-control', type=Path)
    args = parser.parse_args()
    try:
        result = publish(args.directory, args.release_tools, args.development_control)
        if not args.development_control and os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f"Published `{COMPONENT} {result['version']}` to the component dev catalog.\n")
        print(json.dumps(result))
    except Exception as error:
        # Server replies can contain private URLs or credentials.
        print('Component publication failed: '+type(error).__name__, file=sys.stderr)
        sys.exit(1)
