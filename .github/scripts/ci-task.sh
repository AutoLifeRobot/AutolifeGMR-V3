#!/usr/bin/env bash
# Original build/test commands, executed only in the job-owned Docker container.
set -Eeuo pipefail
source .github/scripts/ci-common.sh
phase=${1:?}
profile=${2:?}
case "$phase:$profile" in
 bootstrap:wheel) ci_python ubuntu 3.12 ;;
 bootstrap:model) ci_python ubuntu 3.12 git-lfs libgl1 libegl1 ;;
 run:wheel)
    ci_ubuntu_native
    python -m pip install --upgrade pip setuptools packaging wheel mypy Cython
    python setup.py sdist bdist_wheel ;;
 run:model)
    python -m pip install 'mujoco==3.11.0' 'numpy==2.3.5'
    mkdir -p test-results
    git lfs fsck
    python -m unittest discover -s tests -p test_v3_assets.py -v 2>&1 | tee test-results/model.log ;;
 *) exit 64 ;;
esac
