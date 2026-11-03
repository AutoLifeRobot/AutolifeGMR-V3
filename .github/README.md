# GMR delivery

This repository follows AutolifeFlow-V3 at revision 267a8cf. The Release component ID is `gmr`. The library wheel includes robot XML, meshes and IK configs. The installed check loads the S2 model and steps MuJoCo on CPU. The GMR installation policy stops ChatMotion when replacing its library and declares no GMR service.

## Build and verify

Run `just local-check /tmp/gmr-quick` or `just local-ci /tmp/gmr-full` with a fresh output directory. The self-hosted Linux x64 runner needs Docker and access to the pinned SDK CI image in GHCR. For components using SDK wheels, provide a read-only GitHub token for the locked SDK assets. The source and installed-package tests run offline.

To build the archive directly on Ubuntu 24.04 x86_64 with CPython 3.12 and the build tools installed, run `just package ubuntu24-x64`. `AUTOLIFE_OUTPUT_DIR` can select an empty directory. The tar contains its wheel, a checksummed inventory and Release installation rules.

## Branches and publication

Feature pushes and draft PRs get quick checks. Ready same-repository `candidate/*` PRs to `main` get full qualification. Every main push rebuilds the formal original, publishes a GitHub Pre-release and uploads the verified bytes to the component dev catalog. Manual Development freezes the selected branch SHA and runs an independent installed consumer. Set `upload=false` for artifact-only validation.

The ISO work is prepared on `feat/v3-release-iso`. For remote Development rollout, the default branch must host the trusted controller, and selected branches must have the matching thin Development workflow. These workflows target `main` as the trusted default and formal branch. Configure read access for the pinned SDK image and private Release helper, `BINARY_ARTIFACTS_TOKEN` for private cross-repository reads and a `RELEASE_PUBLISH_KEY` scoped to `component/gmr/dev` for upload. Component owner acceptance and system promotion are separate operations.
