#!/usr/bin/env bash
set -euo pipefail
mode=${1:?}; output=${2:?}; inputs=${3:?}
node --test ci/tests/*.test.cjs
if [[ "$mode" == quick ]]; then
    bash ci/source_test.sh quick
    exit 0
fi
# Keep runtime dependencies and the candidate application in distinct environments.
python -m venv --without-pip --system-site-packages "$output/runtime"
runtime="$output/runtime/bin/python"
library="$("$runtime" -c 'import sysconfig;print(sysconfig.get_path("purelib"))')"
python -c 'import site; print("\n".join(site.getsitepackages()))' > "$library/ci-runtime.pth"
export PATH="$output/runtime/bin:$PATH"

if [[ "$mode" != consumer ]]; then
    bash ci/source_test.sh full
    python ci/build.py --output "$output/artifacts"
    python - "$output/artifacts/source.json" <<'PY'
import json, subprocess, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps(dict(status='passed', source_sha=subprocess.check_output(
    ['git','rev-parse','HEAD'],text=True).strip(), hardware='unverified'))+'\n')
PY
fi
python ci/verify.py "$output"/artifacts/*.tar.gz --report "$output/artifacts/consumer.json"
