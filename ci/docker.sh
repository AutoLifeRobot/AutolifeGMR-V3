#!/usr/bin/env bash
# One Docker entrypoint for local and Actions checks. Only job-owned containers are removed.
set -euo pipefail
component_ci_mode="${1:?quick|full|consumer|image}"
component_ci_output="$(realpath -m "${2:?absolute output directory}")"
component_ci_tools="$(cd "$(dirname "$0")/.." && pwd)"
component_ci_source="$(realpath "${3:-$component_ci_tools}")"
[[ "$component_ci_output" != "$component_ci_source" && "$component_ci_output" != "$component_ci_source/"* && "$component_ci_output" != "$component_ci_tools" && "$component_ci_output" != "$component_ci_tools/"* ]] || { echo 'Output must be outside the checkout' >&2; exit 2; }
for tool in docker git sha256sum; do command -v "$tool" >/dev/null; done
mkdir -p "$component_ci_output"
component_ci_base="$(sed -n 's/.*"base_image": "\([^"]*\)".*/\1/p' "$component_ci_tools/ci/inputs.lock.json")"
[[ "$component_ci_base" =~ ^ghcr.io/autoliferobot/autolife-sdk-v3-ci@sha256:[a-f0-9]{64}$ ]]
component_ci_key="$(cat "$component_ci_tools/ci/image/Dockerfile" "$component_ci_tools/ci/build-requirements.txt" "$component_ci_tools/ci/inputs.lock.json" | sha256sum | cut -d' ' -f1)"
component_ci_image="autolife-gmr-ci:$component_ci_key"
docker build --build-arg "BASE_IMAGE=$component_ci_base" -f "$component_ci_tools/ci/image/Dockerfile" -t "$component_ci_image" "$component_ci_tools"
component_ci_image="$(docker image inspect --format '{{.Id}}' "$component_ci_image")"
printf '%s\n' "$component_ci_image" > "$component_ci_output/ci-image.txt"
export AUTOLIFE_CI_IMAGE_ID="$component_ci_image"
if [[ "$component_ci_mode" == image ]]; then printf '%s\n' "$component_ci_image" > "$component_ci_output/image.txt"; exit 0; fi
[[ "$component_ci_mode" == quick || "$component_ci_mode" == full || "$component_ci_mode" == consumer ]]
component_ci_cache="${AUTOLIFE_COMPONENT_INPUT_CACHE:-$HOME/.cache/autolife/gmr-inputs}"
mkdir -p "$component_ci_cache"
component_ci_cache="$(realpath "$component_ci_cache")"
component_ci_name="gmr-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$-$RANDOM"
trap 'docker rm -f "$component_ci_name" >/dev/null 2>&1 || true' EXIT
# git status runs LFS clean filters even for inspection. Keep their object/tmp
# storage writable without permitting changes to the checkout or its Git index.
component_ci_mounts=(--mount "type=bind,source=$component_ci_tools,target=/controller,readonly" --user "$(id -u):$(id -g)" --mount "type=bind,source=$component_ci_source,target=/source,readonly" --mount "type=bind,source=$component_ci_output,target=/output" --workdir /source --env HOME=/tmp --env TMPDIR=/tmp --env GIT_CONFIG_COUNT=2 --env GIT_CONFIG_KEY_0=safe.directory --env GIT_CONFIG_VALUE_0=/source --env GIT_CONFIG_KEY_1=lfs.storage --env GIT_CONFIG_VALUE_1=/tmp/gmr-lfs --env GIT_OPTIONAL_LOCKS=0)
component_ci_env=()
for key in AUTOLIFE_CI_IMAGE_ID CI GITHUB_ACTIONS GITHUB_SHA GITHUB_REF GITHUB_EVENT_NAME GITHUB_RUN_ID GITHUB_RUN_NUMBER GITHUB_RUN_ATTEMPT AUTOLIFE_DELIVERY_KIND AUTOLIFE_BUILD_NUMBER AUTOLIFE_DELIVERY_HEAD_SHA AUTOLIFE_DELIVERY_BASE_SHA AUTOLIFE_DEVELOPMENT_NAME GITHUB_REPOSITORY AUTOLIFE_DELIVERY_PR_NUMBER AUTOLIFE_DELIVERY_HEAD_REF; do
    [[ -v "$key" ]] && component_ci_env+=(--env "$key")
done
# Software validation runs offline inside the job container.
# No host networking, device passthrough, credentials or Docker socket.
docker run --rm --name "$component_ci_name" --network none "${component_ci_mounts[@]}" --mount "type=bind,source=$component_ci_cache,target=/inputs,readonly" "${component_ci_env[@]}" "$component_ci_image" bash ci/container.sh "$component_ci_mode" /output /inputs
