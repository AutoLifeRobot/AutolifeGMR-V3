"""Build a wheel from selected versioned inputs in a writable temporary directory."""
import os
from pathlib import Path
import shutil
import subprocess
import sys


def build(root, work, output, version, inputs, version_file=None):
    stage = work/'source'
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', *inputs], cwd=root).decode().split('\0')
    for name in filter(None, names):
        source, target = root/name, stage/name
        if source.is_symlink() or not source.is_file():
            raise ValueError('Missing or linked package input: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    if version_file:
        path = stage/version_file
        import re
        text, count = re.subn(r'^__version__\s*=.*$', f'__version__ = "{version}"', path.read_text(), flags=re.M)
        if count != 1:
            raise ValueError('Expected one core package version')
        path.write_text(text)
    subprocess.run([sys.executable, '-m', 'pip', 'wheel', '--no-deps', '--no-index', '--no-build-isolation',
                    '--wheel-dir', str(output), '.'], cwd=stage, check=True,
                   env=dict(os.environ, AUTOLIFE_PACKAGE_VERSION=version))
