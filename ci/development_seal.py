"""Bind an independent compiled consumer result to the default-branch source control."""
import argparse
from pathlib import Path
import shutil

from common import digest, read, require, write
from seal import seal


def publishable(directory, control_path, output, lock_path):
    directory, output = Path(directory), Path(output)
    control = read(control_path)
    delivery = control['delivery']
    require(control['schema'] == 'autolife.development-control/1' and control['component'] == 'gmr',
            'Expected trusted GMR control')
    require(delivery['kind'] == 'development' and delivery['release_version'] ==
            delivery['version'] + '+dev.' + str(delivery['run_id']), 'Invalid development version')
    meta = read(directory/'build-metadata.json')
    for key, expected in dict(kind='development', version=delivery['release_version'],
            base_version=delivery['version'], source_sha=delivery['source_sha'], tree_sha=control['tree_sha'],
            source_ref=delivery['source_ref'], run_id=delivery['run_id'], run_attempt=delivery['run_attempt'],
            source_dirty=False).items():
        require(type(meta.get(key)) is type(expected) and meta[key] == expected, 'Source control mismatch: '+key)
    require(meta['requirements']['inputs_sha256'] == digest(lock_path), 'Source inputs differ from trusted consumer lock')
    # The caller supplies source identity explicitly, not the controller's GITHUB_SHA.
    proof = seal(directory, lock_path)
    original, = directory.glob('*.tar.gz')
    result = dict(schema=proof['schema'], component='gmr', version=delivery['version'],
                  source_sha=delivery['source_sha'], tree_sha=control['tree_sha'], source_dirty=False,
                  delivery=delivery, files=[dict(path=original.name, sha256=digest(original), size=original.stat().st_size)])
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(original, output/original.name)
    write(output/'delivery-manifest.json', result)
    (output/'SHA256SUMS').write_text(''.join(f'{digest(output/name)}  {name}\n'
        for name in (original.name, 'delivery-manifest.json')))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory'); parser.add_argument('control'); parser.add_argument('output')
    parser.add_argument('--lock', default='ci/inputs.lock.json')
    args = parser.parse_args()
    publishable(args.directory, args.control, args.output, args.lock)
