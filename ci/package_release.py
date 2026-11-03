"""Produce a wheel plus an Arm-style standalone component archive."""
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

from common import development_source

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build_identity():
    now = datetime.now(timezone.utc)
    version = (ROOT/'VERSION').read_text().strip()
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('VERSION must contain a three-part product version')
    kind = os.environ.get('AUTOLIFE_DELIVERY_KIND', 'local')
    ci = any(os.environ.get(key, '').lower() == 'true' for key in ('CI', 'GITHUB_ACTIONS'))
    if kind not in {'local', 'candidate', 'formal', 'development'} or (ci and kind == 'local'):
        raise ValueError('CI requires an explicit candidate/formal/development delivery identity')
    development_name = ''
    if kind == 'local':
        number, run, attempt = 0, 0, 0
        release_version = version + now.strftime('+build0.local.%Y%m%dt%H%M%S%fz')
    else:
        values = [os.environ.get(key, '') for key in
                  ('AUTOLIFE_BUILD_NUMBER', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')]
        if not all(re.fullmatch(r'[1-9][0-9]*', value) for value in values):
            raise ValueError('Build number, run ID and attempt must be positive integers')
        number, run, attempt = map(int, values)
        if kind == 'formal' and (os.environ.get('GITHUB_REF') != 'refs/heads/main' or
                                os.environ.get('GITHUB_EVENT_NAME') not in {'push', 'workflow_dispatch'}):
            raise ValueError('Formal packages require a main release event')
        if kind == 'candidate' and not all(re.fullmatch(r'[a-f0-9]{40}', os.environ.get(key, ''))
                                         for key in ('AUTOLIFE_DELIVERY_HEAD_SHA', 'AUTOLIFE_DELIVERY_BASE_SHA')):
            raise ValueError('Candidate requires exact PR head and base SHA')
        release_version = f'{version}+build{number}'
        if kind == 'development':
            ref = os.environ.get('GITHUB_REF', '')
            source = os.environ.get('GITHUB_SHA', '')
            development_name = os.environ.get('AUTOLIFE_DEVELOPMENT_NAME', '')
            if not development_source(os.environ.get('GITHUB_EVENT_NAME'), ref):
                raise ValueError('Development requires a manual branch build or an ISO branch push')
            if (not re.fullmatch('[a-f0-9]{40}', source) or len(development_name) > 240 or
                    not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*-\d{8}T\d{9}Z-' + source[:8], development_name)):
                raise ValueError('Invalid development package name/source identity')
            if number != run:
                raise ValueError('Development build number must equal run ID')
            release_version = f'{version}+dev.{run}'
    # Release qualified 原包的 build_id 使用 buildN；交付类别由 kind 表达。
    return dict(build_id=f'build{number}' if kind in {'candidate', 'formal'} else f'{kind}.{number}', kind=kind, base_version=version,
                build_number=number, run_id=run, run_attempt=attempt, release_version=release_version,
                head_sha=os.environ.get('AUTOLIFE_DELIVERY_HEAD_SHA', ''),
                base_sha=os.environ.get('AUTOLIFE_DELIVERY_BASE_SHA', ''),
                development_name=development_name,
                source_ref=os.environ.get('GITHUB_REF', ''),
                built_at=now.isoformat().replace('+00:00', 'Z'))


def write_bundle(output, wheel, metadata, supplements, assets, source_root=ROOT):
    files = {'wheels/' + wheel.name: wheel, **supplements}
    rules = json.loads((source_root/'packaging/installation.json').read_text())
    prefixes = [step['source'] + '/' for step in rules['steps'] if 'source' in step]
    inventory = {}
    for name, source in sorted(files.items()):
        if sum(name.startswith(prefix) for prefix in prefixes) != 1:
            raise ValueError('Installation rules must cover each file exactly once: ' + name)
        if source.is_symlink() or not source.is_file():
            raise ValueError(f'Package input must be a regular file: {source}')
        inventory[name] = {'sha256': digest(source), 'size': source.stat().st_size}
    manifest = dict(**metadata, small_assets_bytes=assets,
                    files=inventory, installation=rules)
    data = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    if metadata.get('kind') == 'development':
        archive = output/(metadata['development_name'] + '.tar.gz')
    else:
        archive = output/f"autolife-gmr-{metadata['version'].replace('+', '-')}-ubuntu24-x64.tar.gz"
    with tarfile.open(archive, 'x:gz') as tar:
        for name, source in sorted(files.items()):
            info = tarfile.TarInfo('gmr/' + name)
            info.size = inventory[name]['size']
            info.mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
            with source.open('rb') as stream:
                tar.addfile(info, stream)
        info = tarfile.TarInfo('gmr/manifest.json')
        info.size, info.mode = len(data), 0o644
        tar.addfile(info, io.BytesIO(data))
    return archive
