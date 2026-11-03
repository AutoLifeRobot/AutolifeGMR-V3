"""Small verified-file helpers shared by GMR CI entrypoints."""
import hashlib
import json
from pathlib import Path
import tarfile


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def extract(archive, destination):
    destination = Path(destination)
    with tarfile.open(archive) as tar:
        names = set()
        for member in tar.getmembers():
            path = Path(member.name)
            require(not path.is_absolute() and '..' not in path.parts and member.name not in names,
                    'Unsafe or duplicate archive member: ' + member.name)
            require(member.isfile() or member.isdir(), 'Archive links/devices are not permitted')
            names.add(member.name)
        tar.extractall(destination, filter='data')


def verify_archive(archive, destination):
    extract(archive, destination)
    package = Path(destination)/'gmr'
    manifest = read(package/'manifest.json')
    require(manifest.get('component') == 'gmr' and manifest.get('compiled') is False,
            'Expected the GMR original')
    actual = {p.relative_to(package).as_posix() for p in package.rglob('*') if p.is_file()}
    require(actual == set(manifest['files']) | {'manifest.json'}, 'Archive inventory differs')
    for name, entry in manifest['files'].items():
        path = package/name
        require(path.stat().st_size == entry['size'] and digest(path) == entry['sha256'],
                'Archive checksum mismatch: ' + name)
    return package, manifest
