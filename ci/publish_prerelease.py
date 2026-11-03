"""Publish an unchanged, qualified main original through the pinned Release API client."""
import argparse
import importlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile


def failure_detail(error):
    """Only fixed local identity errors may expose their field; never server bodies."""
    message = str(error)
    if re.fullmatch(r'Declared original delivery identity mismatch: [A-Za-z0-9_.-]{1,100}', message):
        return message
    return type(error).__name__


def stage(name):
    print('Publication stage: ' + name, file=sys.stderr, flush=True)


def validated(directory):
    # Share the GitHub publisher's full identity/hash/consumer validation. A
    # candidate or development original cannot acquire formal qualification.
    script = """
const {validate}=require(process.argv[1]);
const e=process.env;
const result=validate(process.argv[2], {ref:e.GITHUB_REF,eventName:e.GITHUB_EVENT_NAME,
  sha:e.GITHUB_SHA,runId:Number(e.GITHUB_RUN_ID)});
process.stdout.write(JSON.stringify(result));
"""
    result = subprocess.run(['node', '-e', script, str(Path(__file__).resolve().with_name('publish.cjs')),
                             str(Path(directory).resolve())], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def load_release(root):
    sys.path.insert(0, str(Path(root).resolve()))
    return importlib.import_module('autolife_release.ota.component_versions')


def publish(directory, release_tools, manifest_output=None):
    token = os.environ.pop('AUTOLIFE_PUBLISH_TOKEN', '')
    url = os.environ.get('AUTOLIFE_PUBLISH_URL', '').rstrip('/')
    if not token or not url:
        raise ValueError('Release server credentials are unavailable')
    if manifest_output is not None:
        manifest_output = Path(manifest_output).resolve()
        if manifest_output.is_relative_to(Path(directory).resolve()) or manifest_output.exists():
            raise ValueError('Manifest snapshot needs a fresh path outside the sealed original')
    stage('validate-original')
    checked = validated(directory)
    directory = Path(directory).resolve()
    original, = [directory/name for name in checked['names'] if name.endswith('.tar.gz')]
    version = checked['proof']['delivery']['release_version']
    stage('load-release-client')
    versions = load_release(release_tools)
    with tempfile.TemporaryDirectory(prefix='gmr-prerelease-') as temporary:
        work = Path(temporary)
        token_file = work/'token'
        token_file.touch(mode=0o600)
        token_file.write_text(token)
        config = work/'publisher.toml'
        config.write_text('[publish]\nbackend = "api"\nurl = '+json.dumps(url)+
                          '\ntoken_file = '+json.dumps(str(token_file))+'\n')
        repository = work/'repository'
        stage('import-original')
        manifest = versions.create(repository, 'gmr', original,
                                   delivery_metadata=directory/'delivery-manifest.json')
        identity = manifest['component_release']
        if identity['qualification'] != 'formal' or identity['version'] != version:
            raise ValueError('Release import changed the main Pre-release identity')
        # The existing Release client owns upload, checksum verification and
        # registration. No accept/overwrite/system-channel operation is exposed.
        stage('server-publication')
        state = versions.publish(repository, 'gmr', version, config, journal_dir=work/'journals')
        if state.get('phase') != 'committed' or state.get('delivery', {}).get('status') != 'verified':
            raise ValueError('Release server has not verified the publication')
        if manifest_output is not None:
            stage('save-manifest; server publication already verified')
            manifest_output.parent.mkdir(parents=True, exist_ok=True)
            manifest_output.write_bytes(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode() + b'\n')
    result = dict(component='gmr', version=version, channel='dev', qualification='formal',
                  label='Pre-release', github_tag=checked['tag'])
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as out:
            out.write(f"### GMR Pre-release uploaded\n\n`{version}` · component `dev` · qualification `formal`\n\n")
            out.write(f"```bash\njust component show gmr {version} --json\n")
            out.write(f"just download gmr --version {version} --channel dev\n")
            out.write(f"just install --component gmr --version {version} --channel dev --yes\n```\n")
            out.write('\nOriginal bytes preserved. Component acceptance and system alpha/stable are unchanged.\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--release-tools', required=True)
    parser.add_argument('--manifest-output', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(publish(args.directory, args.release_tools, args.manifest_output)))
    except Exception as error:
        # Neither token-bearing requests nor arbitrary server bodies enter logs.
        print('Pre-release publication refused or incomplete: ' + failure_detail(error), file=sys.stderr)
        sys.exit(1)
