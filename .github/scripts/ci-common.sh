#!/usr/bin/env bash
# Container-only helpers. Host installation and shared Conda state are forbidden.
set -Eeuo pipefail
ci_apt() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends "$@"
}
ci_user() {
    groupadd --gid 10001 ci
    useradd --uid 10001 --gid 10001 --home-dir /work/home --shell /bin/bash ci
    chown -R 10001:10001 /work
}
ci_python() {
    local flavor=$1 minor=$2; shift 2
    local -a deps=(ca-certificates curl git build-essential)
    if [[ "$flavor" == ubuntu || "$flavor" == jetpack ]]; then
        deps+=(python3 python3-dev python3-venv)
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends "${deps[@]}" "$@"
    if [[ -n "$minor" ]]; then
        python3 -c 'import sys; assert ".".join(map(str,sys.version_info[:2])) == sys.argv[1], sys.version' "$minor"
    fi
    python3 -m venv /work/venv
    ci_user
    python3 --version
}
ci_node() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates git
    ci_user
    node --version
}
ci_ubuntu_native() {
    . /etc/os-release
    if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || "$(uname -m)" != x86_64 ]]; then
        echo 'Native wheel requires Ubuntu 24.04 x86_64 inside its build container' >&2
        return 1
    fi
    python -c 'import sys; assert sys.version_info[:2] == (3,12), sys.version'
}
ci_just() {
    local archive=/tmp/just-1.58.0.tar.gz
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
        https://github.com/casey/just/releases/download/1.58.0/just-1.58.0-x86_64-unknown-linux-musl.tar.gz -o "$archive"
    echo "4a5cc2f53e6f0f8c59092a6cc38291eb729d46a7dd95d3ae582008881b84931d  $archive" | sha256sum --check -
    tar -xzf "$archive" -C /usr/local/bin just
    test "$(just --version)" = 'just 1.58.0'
    rm -f -- "$archive"
}
ci_publish_component() {
    export GH_REPO="$GITHUB_REPOSITORY"
    gh release create "$GITHUB_REF_NAME" dist/*.tar.gz dist/SHA256SUMS \
        --verify-tag --title "$GITHUB_REF_NAME" --generate-notes
}
ci_lfs() {
    : "${GH_TOKEN:?}"
    : "${GITHUB_SHA:?}"
    test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
    local auth_dir
    auth_dir=$(mktemp -d /work/lfs-auth.XXXXXX)
    trap 'rm -rf -- "$auth_dir"' RETURN
    cat > "$auth_dir/askpass" <<'ASK'
#!/bin/sh
case "$1" in *Username*) printf '%s\n' x-access-token ;; *) printf '%s\n' "$GH_TOKEN" ;; esac
ASK
    chmod 700 "$auth_dir/askpass"
    export GIT_ASKPASS="$auth_dir/askpass" GIT_TERMINAL_PROMPT=0
    git lfs install --local
    git lfs fetch origin "$GITHUB_SHA"
    git lfs checkout
    git lfs fsck
    rm -rf -- "$auth_dir"
    trap - RETURN
}
if [[ "${1:-}" == lfs ]]; then ci_lfs; fi
