"""Install the verified original outside the source checkout and test its runtime payload."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from common import digest, verify_archive, write

ROOT = Path(__file__).resolve().parents[1]


def verify(archive, report):
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        package, meta = verify_archive(archive, work/'original')
        wheel, = (package/'wheels').glob('*.whl')
        subprocess.run([sys.executable, '-m', 'venv', '--without-pip', work/'env'], check=True)
        python = work/'env/bin/python'
        subprocess.run([sys.executable, '-m', 'pip', '--python', str(python), 'install', '--no-index',
                        '--no-deps', str(wheel)], check=True, cwd=work)
        # Deployment libraries (including ROS) can be shared; the application is always
        # imported from this fresh environment. Never add the producer checkout.
        libraries = [Path(p).resolve() for p in sys.path if p and
                     ('site-packages' in Path(p).parts or 'dist-packages' in Path(p).parts)
                     and not Path(p).resolve().is_relative_to(ROOT)]
        lib, = (work/'env/lib').glob('python*/site-packages')
        (lib/'runtime.pth').write_text(''.join(str(p)+'\n' for p in libraries))
        env = {k: v for k, v in os.environ.items() if k not in {'PYTHONPATH','AUTOLIFE_CONFIG_DIR'}}
        env['AUTOLIFE_TEST_PACKAGE'] = str(package)
        env['AUTOLIFE_TEST_VERSION'] = meta['version']
        shutil.copyfile(ROOT/'ci/installed_test.py', work/'installed_test.py')
        subprocess.run([python, '-I', work/'installed_test.py'], cwd=work, env=env, check=True)
        write(report, dict(status='passed', source_sha=meta['source_sha'], installed_package='passed',
                           archive_sha256=digest(archive), inputs_sha256=digest(ROOT/'ci/inputs.lock.json'),
                           scope='offline installed wheel and packaged resources', hardware='unverified'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    verify(args.archive, args.report)
