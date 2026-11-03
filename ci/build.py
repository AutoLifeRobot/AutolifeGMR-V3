"""Build the wheel and the independently installable component original."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

from component import COMPONENT, DISTRIBUTION, build_wheel, supplemental_files
from package_release import ROOT, build_identity, digest, write_bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=os.environ.get('AUTOLIFE_OUTPUT_DIR'))
    parser.add_argument('--platform', choices=['ubuntu24-x64'], default='ubuntu24-x64')
    args = parser.parse_args()
    release = platform.freedesktop_os_release()
    if (release['ID'], release['VERSION_ID'], platform.machine(), sys.version_info[:2],
            platform.python_implementation()) != ('ubuntu', '24.04', 'x86_64', (3, 12), 'CPython'):
        raise ValueError('Use Ubuntu 24.04 x86_64 and CPython 3.12')
    output = (args.output or ROOT/'dist'/datetime.now(timezone.utc).strftime('package-%Y%m%dT%H%M%S%fZ')).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('Choose a fresh output directory')
    identity = build_identity()
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT))
    if identity['kind'] != 'local' and (dirty or sha != os.environ.get('GITHUB_SHA')):
        raise ValueError('Delivery requires the exact clean source commit')
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        built = work/'artifacts'
        built.mkdir()
        build_wheel(ROOT, work, built, identity['release_version'])
        wheel, = built.glob('*.whl')
        if wheel.name.split('-')[:2] != [DISTRIBUTION.replace('-', '_'), identity['release_version']]:
            raise ValueError('Wheel identity differs from component delivery')
        supplements = supplemental_files(ROOT, work)
        lock = json.loads((ROOT/'ci/inputs.lock.json').read_text())
        metadata = dict(identity, version=identity['release_version'], component=COMPONENT,
                        compiled=COMPONENT == 'face-detection', platform=args.platform,
                        source_sha=sha, source_dirty=dirty,
                        tree_sha=subprocess.check_output(['git','rev-parse','HEAD^{tree}'], cwd=ROOT, text=True).strip(),
                        artifacts={wheel.name: dict(sha256=digest(wheel), size=wheel.stat().st_size)},
                        requirements=dict(ci_image_id=os.environ.get('AUTOLIFE_CI_IMAGE_ID', 'local-unverified'),
                                          inputs_sha256=digest(ROOT/'ci/inputs.lock.json'),
                                          ci_base_image=lock['base_image']))
        (built/'build-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
        write_bundle(built, wheel, metadata, supplements, 0)
        output.mkdir(parents=True, exist_ok=True)
        for path in built.iterdir():
            shutil.move(path, output/path.name)


if __name__ == '__main__':
    main()
