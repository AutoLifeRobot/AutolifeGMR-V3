#!/usr/bin/env bash
# Host boundary: Bash/coreutils, Git and Docker only. No host dependency install.
set -Eeuo pipefail
[[ $# == 2 ]] || { echo 'usage: ci-container.sh IMAGE PROFILE' >&2; exit 64; }
image=$1
profile=$2
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/@:-]+$ && "$profile" =~ ^[a-z0-9-]+$ ]] || exit 64
: "${CI_OUTPUT:?Create a fresh job output directory first}"
: "${CI_SOURCE_REL:?Use the unique checkout path}"
: "${GITHUB_WORKSPACE:?}"
: "${GITHUB_SHA:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_RUN_ATTEMPT:?}"
for tool in docker git timeout mktemp; do command -v "$tool" >/dev/null; done
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ "$source_root" == "$GITHUB_WORKSPACE/$CI_SOURCE_REL" ]] || { echo 'Unexpected checkout location' >&2; exit 64; }
[[ -d "$CI_OUTPUT" && ! -L "$CI_OUTPUT" && ! -e "$CI_OUTPUT/ci" ]] || { echo 'Output must belong to a fresh job' >&2; exit 64; }
mkdir -m 700 "$CI_OUTPUT/ci"
actual_sha=$(git -C "$source_root" rev-parse HEAD)
[[ "$actual_sha" == "$GITHUB_SHA" ]] || { echo 'Checkout does not match the event SHA' >&2; exit 1; }
name="autolife-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-$(basename -- "$CI_OUTPUT")"
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || exit 64
created=0
started=0
cleanup() {
    local original=$? copy_rc=0 cleanup_rc=0 folder status output
    local result=$original
    # Cleanup must still remove the owned container if copying/logging fails.
    set +e
    trap - EXIT INT TERM
    if (( created )); then
        # Copy only declared outputs, even after test failure. Never copy HOME,
        # credentials, the source tree, environments or arbitrary container state.
        if (( started )); then
            for folder in dist test-results; do
                timeout 15s docker exec "$name" test -d "/work/src/$folder"
                status=$?
                if (( status == 0 )); then
                    mkdir -p "$CI_OUTPUT/$folder"
                    status=$?
                    if (( status == 0 )); then
                        timeout 60s docker cp "$name:/work/src/$folder/." "$CI_OUTPUT/$folder/"
                        status=$?
                    fi
                elif (( status == 1 )); then
                    status=0 # This job did not produce this optional output folder.
                fi
                if (( copy_rc == 0 && status != 0 )); then copy_rc=$status; fi
            done
        fi
        output=$(timeout 15s docker inspect --format '{{json .State}}' "$name" 2>&1)
        status=$?
        if (( status != 0 )); then cleanup_rc=$status; fi
        printf '%s\n' "$output" > "$CI_OUTPUT/ci/container-state.json"
        status=$?
        if (( cleanup_rc == 0 && status != 0 )); then cleanup_rc=$status; fi
        # Do not attach redirection to docker rm: missing/full evidence storage
        # must not prevent removal of this job's container.
        output=$(timeout 30s docker rm --force "$name" 2>&1)
        status=$?
        if (( cleanup_rc == 0 && status != 0 )); then cleanup_rc=$status; fi
        printf '%s\n' "$output" >> "$CI_OUTPUT/ci/cleanup.log"
        status=$?
        if (( cleanup_rc == 0 && status != 0 )); then cleanup_rc=$status; fi
    fi
    (( result != 0 || copy_rc == 0 )) || result=$copy_rc
    (( result != 0 || cleanup_rc == 0 )) || result=$cleanup_rc
    printf 'source_sha=%s\nprofile=%s\ncommand_exit=%s\ncopy_exit=%s\ncleanup_exit=%s\nexit_code=%s\n' \
        "$actual_sha" "$profile" "$original" "$copy_rc" "$cleanup_rc" "$result" > "$CI_OUTPUT/ci/result.env"
    status=$?
    if (( result == 0 && status != 0 )); then result=$status; fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# No bind mounts: Docker may run outside the runner service's mount namespace.
docker version > "$CI_OUTPUT/ci/docker-version.txt"
if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull --platform "${CI_DOCKER_PLATFORM:-linux/amd64}" "$image"
fi
docker image inspect --format '{{.Id}} {{json .RepoDigests}} {{.Os}}/{{.Architecture}}' "$image" > "$CI_OUTPUT/ci/image.txt"
docker create --name "$name" --platform "${CI_DOCKER_PLATFORM:-linux/amd64}" \
    --label "autolife.ci.run=$GITHUB_RUN_ID" \
    --entrypoint /bin/bash "$image" -c 'exec sleep infinity' > "$CI_OUTPUT/ci/container.id"
created=1
docker start "$name" >/dev/null
started=1
docker exec "$name" mkdir -p /work/src /work/home
# docker cp uses the client API and does not require a shared host path.
docker cp "$source_root/." "$name:/work/src/"
if [[ -d "$CI_OUTPUT/input" ]]; then
    docker exec "$name" mkdir -p /work/src/dist
    docker cp "$CI_OUTPUT/input/." "$name:/work/src/dist/"
fi
base_env=(-e CI=true -e HOME=/work/home -e PATH=/work/venv/bin:/work/home/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
for key in GITHUB_ACTIONS GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_RUN_NUMBER GITHUB_REF GITHUB_REF_NAME GITHUB_EVENT_NAME GITHUB_REPOSITORY CI_PYTHON_MINOR; do
    if [[ -v "$key" ]]; then base_env+=(-e "$key"); fi
done
write_logged_output() {
    local log=$1 line
    : > "$log" || return $?
    while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%s\n' "$line" || return $?
        # GitHub consumes the mask command; evidence must never retain its token.
        if [[ "$line" != ::add-mask::* ]]; then
            printf '%s\n' "$line" >> "$log" || return $?
        fi
    done
}
run_logged() {
    local log=$1; shift
    local -a statuses
    set +e
    "$@" 2>&1 | write_logged_output "$CI_OUTPUT/ci/$log"
    statuses=("${PIPESTATUS[@]}")
    set -e
    if (( statuses[0] != 0 )); then return "${statuses[0]}"; fi
    return "${statuses[1]}"
}
run_logged bootstrap.log docker exec -w /work/src "${base_env[@]}" "$name" \
    bash .github/scripts/ci-task.sh bootstrap "$profile"
if [[ "${CI_LFS:-false}" == true ]]; then
    : "${GH_TOKEN:?LFS fetch requires the job read-only token}"
    # Token exists only in this exec, not the container definition or build step.
    run_logged lfs.log docker exec --user 10001:10001 -w /work/src "${base_env[@]}" -e GH_TOKEN "$name" \
        bash .github/scripts/ci-common.sh lfs
fi
if [[ "${CI_SCOUT:-false}" == true && ( "$GITHUB_EVENT_NAME" == push || "$GITHUB_EVENT_NAME" == workflow_dispatch ) ]]; then
    run_logged scout.log docker exec --user 10001:10001 -w /work/src "${base_env[@]}" \
        -e ACTIONS_ID_TOKEN_REQUEST_URL -e ACTIONS_ID_TOKEN_REQUEST_TOKEN -e SCOUT_URL "$name" \
        bash .github/scripts/report_scout_source.sh
fi
secret_env=()
if [[ "${CI_PUBLISH:-false}" == true ]]; then
    : "${GH_TOKEN:?The existing tag publish operation requires its token}"
    secret_env=(-e GH_TOKEN)
fi
run_logged task.log docker exec --user 10001:10001 -w /work/src "${base_env[@]}" "${secret_env[@]}" "$name" \
    bash .github/scripts/ci-task.sh run "$profile"
