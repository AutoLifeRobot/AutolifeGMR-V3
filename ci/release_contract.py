"""Import exact sealed bytes with the pinned Release client, without publishing."""
import argparse
import importlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile

RELEASE_SHA = 'c8af90f1f573ebaa0112f01d0d3ece495ead4c80'


def verify(directory, release_tools):
    directory, release_tools = Path(directory).resolve(), Path(release_tools).resolve()
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=release_tools, text=True).strip()
    if actual != RELEASE_SHA or subprocess.check_output(
            ['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=release_tools, text=True).strip():
        raise ValueError('Release contract requires the clean pinned client checkout')
    sys.path.insert(0, str(release_tools))
    versions = importlib.import_module('autolife_release.ota.component_versions')
    rejection = importlib.import_module('autolife_release.core.common').Error
    proof_path = directory/'delivery-manifest.json'
    proof = json.loads(proof_path.read_text())
    archives = [entry for entry in proof['files'] if entry['path'].endswith('.tar.gz')]
    if len(archives) != 1 or Path(archives[0]['path']).name != archives[0]['path']:
        raise ValueError('Expected one safe original filename')
    archive = directory/archives[0]['path']
    if archive.is_symlink() or not archive.is_file() or proof_path.is_symlink():
        raise ValueError('Original and proof must be regular files')
    with tempfile.TemporaryDirectory(prefix='gmr-release-contract-') as temporary:
        root = Path(temporary)
        manifest = versions.create(root/'repository', 'gmr', archive, delivery_metadata=proof_path)
        identity = manifest['component_release']
        if (identity['qualification'], identity['version']) != (
                proof['delivery']['kind'], proof['delivery']['release_version']):
            raise ValueError('Release changed the producer identity')
        # Exercise real Release rejection paths against the same original, not mocks.
        changed = json.loads(proof_path.read_text())
        changed['delivery']['source_ref'] = 'refs/heads/contract-wrong-source'
        bad_proof = root/'wrong-source.json'
        bad_proof.write_text(json.dumps(changed))
        try:
            versions.create(root/'wrong-source', 'gmr', archive, delivery_metadata=bad_proof)
        except rejection:
            pass
        else:
            raise ValueError('Release accepted a changed source ref')
        changed = json.loads(proof_path.read_text())
        entry = next(e for e in changed['files'] if e['path'] == archive.name)
        entry['sha256'] = '0'*64
        bad_proof.write_text(json.dumps(changed))
        try:
            versions.create(root/'wrong-digest', 'gmr', archive, delivery_metadata=bad_proof)
        except rejection:
            pass
        else:
            raise ValueError('Release accepted changed original evidence')
        # Keep a readable tar but change its actual bytes; unchanged evidence must fail.
        tampered = root/'tampered'/archive.name
        tampered.parent.mkdir()
        shutil.copyfile(archive, tampered)
        with tampered.open('ab') as stream:
            stream.write(b'changed-original')
        try:
            versions.create(root/'wrong-bytes', 'gmr', tampered, delivery_metadata=proof_path)
        except rejection:
            pass
        else:
            raise ValueError('Release accepted changed original bytes')
    return dict(status='passed', release_sha=actual, component='gmr',
                version=identity['version'], qualification=identity['qualification'],
                scope='offline-real-original-import-and-rejection; no API publication or hardware acceptance')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--release-tools', required=True)
    args = parser.parse_args()
    result = verify(args.directory, args.release_tools)
    print(json.dumps(result, sort_keys=True))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write('\n### Release import contract: passed\n\n'
                          + json.dumps(result, sort_keys=True) + '\n')
