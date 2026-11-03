set shell := ["bash", "-euo", "pipefail", "-c"]
python := env("PYTHON", "python3")
output := env("AUTOLIFE_OUTPUT_DIR", "dist")

default:
    @just --list

package platform="ubuntu24-x64":
    {{quote(python)}} ci/build.py --platform {{quote(platform)}}

local-check out:
    bash ci/docker.sh quick {{quote(out)}}

local-ci out:
    bash ci/docker.sh full {{quote(out)}}
