"""Export version-bound software evidence and an owner acceptance template."""
import argparse
import hashlib
import json
from pathlib import Path


def canonical(value):
    # 与 Release component_versions.manifest_bytes 保持完全一致，包含末尾换行。
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def generate(manifest_path, qualification_directory, output):
    manifest = json.loads(Path(manifest_path).read_text())
    release = manifest['component_release']
    if release['component'] != 'gmr' or release['qualification'] != 'formal':
        raise ValueError('Only a published formal GMR version can prepare acceptance materials')
    proof = release['delivery_metadata']
    delivery = proof['delivery']
    archive = manifest['components']['gmr']['archive']
    files = {item['path']: item for item in proof['files']}
    root = Path(qualification_directory).resolve()
    reports = {}
    for name in ('source.json', 'consumer.json'):
        path = root/name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing regular qualification report: ' + name)
        data = path.read_bytes()
        entry = files[name]
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Qualification report differs from published evidence: ' + name)
        report = json.loads(data)
        if report['status'] != 'passed' or report['source_sha'] != proof['source_sha']:
            raise ValueError('Qualification report did not pass for this source: ' + name)
        reports[name] = report
    consumer = reports['consumer.json']
    if (consumer['archive_sha256'] != archive['sha256'] or consumer.get('installed_package') != 'passed' or
            delivery['kind'] != 'formal' or delivery['release_version'] != release['version']):
        raise ValueError('Published original and qualified consumer identity differ')
    manifest_data = canonical(manifest)
    binding = dict(component='gmr', version=release['version'], candidate=manifest['candidate'],
                   manifest_sha256=hashlib.sha256(manifest_data).hexdigest())
    software = dict(**binding, status='passed', scope='software-only',
                    source_sha=proof['source_sha'], delivery=delivery,
                    archive_sha256=archive['sha256'], reports=reports,
                    hardware='unverified', systemd_manager='unverified', external_business_platform='unverified',
                    owner_review_required=True)
    template = dict(**binding, status='pending', scope='component-owner-acceptance',
                    software_evidence='software-verification.json',
                    reviewer='', results=[], note='Record actual acceptance before setting status=passed.')
    output = Path(output).resolve()
    if output == root or output.is_relative_to(root):
        raise ValueError('Acceptance materials must be outside the sealed original directory')
    if output.exists() and any(output.iterdir()):
        raise ValueError('Acceptance output must be empty; do not overwrite evidence')
    output.mkdir(parents=True, exist_ok=True)
    entries = {'component-manifest.json': manifest_data,
               'software-verification.json': canonical(software),
               'acceptance-report.template.json': canonical(template)}
    instructions = (
        f"GMR {release['version']}\nCandidate: {binding['candidate']}\nManifest SHA256: {binding['manifest_sha256']}\n\n"
        'software-verification.json records only the completed CI software scope. Hardware, real systemd manager and external platform are unverified.\n'
        'The component owner must decide whether that scope is sufficient. CI does not register acceptance.\n'
        'For additional acceptance, copy acceptance-report.template.json to acceptance-report.json, record actual results and set status=passed only after passing.\n\n'
        f"After owner review, use the appropriate completed report:\njust component accept gmr {release['version']} <REPORT.json> --yes\n"
        'The publishing token needs component/gmr/dev write permission and the accept capability.\n')
    entries['README.txt'] = instructions.encode()
    for name, data in entries.items():
        (output/name).write_bytes(data)
    (output/'SHA256SUMS').write_text(''.join(
        f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(entries.items())))
    return binding


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--qualification-directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(generate(args.manifest, args.qualification_directory, args.output)))
