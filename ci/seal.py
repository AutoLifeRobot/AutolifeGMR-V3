"""Seal the exact original after both source and installed-package gates pass."""
import argparse
import os
from pathlib import Path
import re
import shutil
from common import development_source, digest, read, require, write


def seal(directory, lock_path):
    directory = Path(directory)
    require(all(p.is_file() and not p.is_symlink() for p in directory.iterdir()),
            'Qualification inputs must be regular files without links or directories')
    meta = read(directory/'build-metadata.json')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', meta.get('requirements', {}).get('ci_image_id', '')),
            'Qualification requires the actual immutable CI image ID')
    require(meta['kind'] in {'candidate', 'formal', 'development'} and meta['source_dirty'] is False,
            'Only clean candidate/formal/development builds can be qualified')
    require(meta['run_id'] == int(os.environ['GITHUB_RUN_ID']) and
            meta['run_attempt'] == int(os.environ['GITHUB_RUN_ATTEMPT']) and
            meta['source_sha'] == os.environ['GITHUB_SHA'], 'Build identity differs from this run')
    require(meta['requirements']['inputs_sha256'] == digest(lock_path), 'Producer used another input lock')
    for name in ('source', 'consumer'):
        report = read(directory/f'{name}.json')
        require(report['status'] == 'passed' and report['source_sha'] == meta['source_sha'],
                name + ' validation has not passed for this source')
    consumer = read(directory/'consumer.json')
    originals = list(directory.glob('*.tar.gz'))
    require(len(originals) == 1 and consumer['archive_sha256'] == digest(originals[0]),
            'Consumer did not test this original archive')
    require(consumer['inputs_sha256'] == digest(lock_path), 'Consumer used another SDK lock')
    require(consumer.get('installed_package') == 'passed', 'Installed component check is mandatory')
    for name, entry in meta['artifacts'].items():
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*\.whl', name) is not None,
                'Unsafe producer wheel filename')
        require(digest(directory/name) == entry['sha256'], 'Producer wheel changed')
    if meta['kind'] == 'formal':
        require(os.environ.get('GITHUB_REF') == 'refs/heads/main', 'Formal qualification requires main')
    delivery = dict(kind=meta['kind'], release_version=meta['version'], source_sha=meta['source_sha'],
                    source_ref=os.environ.get('GITHUB_REF', ''),
                    run_id=meta['run_id'], build_number=meta['build_number'], run_attempt=meta['run_attempt'])
    if meta['kind'] == 'candidate':
        require(all(re.fullmatch('[a-f0-9]{40}', meta[k]) for k in ('head_sha','base_sha')),
                'Candidate PR identity is missing')
        delivery.update(head_sha=meta['head_sha'], base_sha=meta['base_sha'],
                        repository=os.environ['GITHUB_REPOSITORY'],
                        pull_number=int(os.environ['AUTOLIFE_DELIVERY_PR_NUMBER']),
                        head_ref=os.environ['AUTOLIFE_DELIVERY_HEAD_REF'], base_ref='main',
                        source_event=os.environ['GITHUB_EVENT_NAME'])
    if meta['kind'] == 'development':
        ref = os.environ.get('GITHUB_REF', '')
        require(development_source(os.environ.get('GITHUB_EVENT_NAME'), ref) and meta.get('source_ref') == ref,
                'Development qualification requires the original branch event')
        name = meta.get('development_name', '')
        require(len(name) <= 240 and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*-\d{8}T\d{9}Z-' + meta['source_sha'][:8], name)
                and originals[0].name == name + '.tar.gz', 'Development original name/source mismatch')
        delivery.update(name=name, source_ref=ref)
    (directory/'inputs.lock.json').write_bytes(Path(lock_path).read_bytes())
    names = {originals[0].name, 'build-metadata.json', 'source.json', 'consumer.json', 'inputs.lock.json', *meta['artifacts']}
    require({p.name for p in directory.iterdir() if p.is_file()} <= names | {'SHA256SUMS'},
            'Unexpected public artifact; choose a fresh output directory')
    proof = dict(schema='autolife.component-delivery/1', component='gmr', version=meta['base_version'],
                 source_sha=meta['source_sha'], tree_sha=meta['tree_sha'], source_dirty=False,
                 platform='ubuntu24-x64', delivery=delivery,
                 files=[dict(path=n, sha256=digest(directory/n), size=(directory/n).stat().st_size) for n in sorted(names)])
    write(directory/'delivery-manifest.json', proof)
    names.add('delivery-manifest.json')
    (directory/'SHA256SUMS').write_text(''.join(f'{digest(directory/n)}  {n}\n' for n in sorted(names)))
    return proof


def seal_publication(directory, lock_path, output):
    """Validate all build products, then export wheel-free final attachments.

    The build directory retains its wheels and complete qualification inventory.
    Metadata keeps wheel hashes as build evidence; public files/SHA256SUMS list
    only exported files. The original tar (including its wheel) stays unchanged.
    """
    directory, output = Path(directory).resolve(), Path(output).resolve()
    require(output != directory and not output.is_relative_to(directory),
            'Publication output must be outside the build directory')
    require(not output.exists(), 'Publication output must be a fresh directory')
    proof = seal(directory, lock_path)
    files = [entry for entry in proof['files'] if not entry['path'].endswith('.whl')]
    if proof['delivery']['kind'] == 'development':
        files = [item for item in files if item['path'].endswith('.tar.gz')]
        # Match the three-file Development download. The source and consumer reports
        # were checked above and are retained in the job's build directory.
        proof['delivery'].update(version=proof['version'], source_event=os.environ['GITHUB_EVENT_NAME'])
    output.mkdir(parents=True, exist_ok=False)
    for entry in files:
        target = output/entry['path']
        shutil.copyfile(directory/entry['path'], target)
        require(target.stat().st_size == entry['size'] and digest(target) == entry['sha256'],
                'Build evidence changed while exporting: ' + entry['path'])
    proof = dict(proof, files=files)
    write(output/'delivery-manifest.json', proof)
    names = {entry['path'] for entry in files} | {'delivery-manifest.json'}
    (output/'SHA256SUMS').write_text(''.join(f'{digest(output/name)}  {name}\n' for name in sorted(names)))
    return proof


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory'); parser.add_argument('--lock', default='ci/inputs.lock.json')
    parser.add_argument('--output', required=True, help='Fresh final attachment directory outside build products')
    args=parser.parse_args(); seal_publication(args.directory,args.lock,args.output)
