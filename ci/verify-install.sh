#!/usr/bin/env bash
# Exercise Release's offline install command in a disposable deployment.
set -euo pipefail
if [[ "${1:-}" != --inside ]]; then
    output="$(realpath -e "${1:?build output directory}")"
    release="$(realpath -e "${2:?pinned Release checkout}")"
    source_dir="$(cd "$(dirname "$0")/.." && pwd)"
    image="$(cat "$output/ci-image.txt")"
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
    exec docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
        --user "$(id -u):$(id -g)" --env HOME=/tmp/installer-home \
        --tmpfs "/var/lib/autolife-ota:mode=0700,uid=$(id -u),gid=$(id -g)" \
        --mount "type=bind,source=$release,target=/release,readonly" \
        --mount "type=bind,source=$source_dir/ci,target=/checks,readonly" \
        --mount "type=bind,source=$source_dir/packaging,target=/packaging,readonly" \
        --mount "type=bind,source=$output/publication,target=/original,readonly" \
        "$image" bash /checks/verify-install.sh --inside
fi

export XDG_CONFIG_HOME="$HOME/.config" AUTOLIFE_STATE_DIR=/tmp/installer-sdk-state
root=/tmp/deployment
mkdir -p "$HOME" "$root/config" /tmp/manager
python -m venv "$root/env"
printf 'AUTOLIFE_ROBOT_VERSION=robot_v2_4\nROBOT_ID=ci-fixture\n' > "$root/config/robot.env"
# Only the service-manager boundary is simulated. Refuse all service starts.
cat > /tmp/manager/systemctl <<'SYSTEMCTL'
#!/bin/bash
set -eu
case " $* " in
    *" show "*) for unit in "$@"; do
        if [[ "$unit" == *.service ]]; then
            printf 'Id=%s\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nUnitFileState=\n\n' "$unit"
        fi
    done ;;
    *" daemon-reload "*) : ;;
    *) echo "Unexpected service-manager command: $*" >&2; exit 1 ;;
esac
SYSTEMCTL
chmod +x /tmp/manager/systemctl
export PATH="/tmp/manager:$PATH"
cd /original
sha256sum -c SHA256SUMS
archives=(*.tar.gz)
[[ ${#archives[@]} == 1 && -f "${archives[0]}" ]]
/usr/bin/python3 /release/release.py install --root "$root" --yes --non-interactive "/original/${archives[0]}"
"$root/env/bin/python" -I - <<'PY'
import json
from importlib.metadata import distribution
from pathlib import Path
rules = json.loads(Path('/packaging/installation.json').read_text())
proof = json.loads(Path('/original/delivery-manifest.json').read_text())
wheels, = [step for step in rules['steps'] if step['action'] == 'install_wheels']
for name in wheels['distributions']:
    actual = distribution(name).version
    if actual != proof['delivery']['release_version']:
        raise ValueError(f'Installed {name} version differs: {actual}')
    print(f'Offline Release installation passed for {name} {actual}')
PY
