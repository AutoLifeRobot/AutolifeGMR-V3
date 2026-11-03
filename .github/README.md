# GMR delivery

This repository follows AutolifeFlow-V3 at revision 267a8cf. The Release component ID is `gmr`. The library wheel includes robot XML, meshes and IK configs. The installed check loads the S2 model and steps MuJoCo on CPU. The GMR installation policy stops ChatMotion when replacing its library and declares no GMR service.

## Build and verify

Run `just local-check /tmp/gmr-quick` or `just local-ci /tmp/gmr-full` with a fresh output directory. The self-hosted Linux x64 runner needs Docker and access to the pinned SDK CI image in GHCR. GMR builds and verifies its library without an SDK release download. The source and installed-package tests run offline.

To build the archive directly on Ubuntu 24.04 x86_64 with CPython 3.12 and the build tools installed, run `just package ubuntu24-x64`. `AUTOLIFE_OUTPUT_DIR` can select an empty directory. The tar contains its wheel, a checksummed inventory and Release installation rules.

## Branches and publication

Pushes to `feat/v3-release-iso` build a full development original. CI tests the installed wheel and packaged resources, then attaches the sealed tar, delivery manifest and checksums for 30 days. A separate integration job can import that exact artifact and exercise the offline installer when the repository variable `ISO_VERIFY_WITH_RELEASE=true`. Only this optional ISO integration job needs the pinned Release main checkout. Its service-manager calls are simulated. This push has no server upload step. Other feature pushes and draft PRs get quick checks. Ready same-repository `candidate/*` PRs to `main` get full qualification. Every main push rebuilds the formal original, publishes a GitHub Pre-release and uploads the verified bytes to the component dev catalog. Manual Development freezes the selected branch SHA and runs an independent installed consumer. Set `upload=false` for artifact-only validation.

The ISO work is prepared on `feat/v3-release-iso`. For remote Development rollout, the default branch must host the trusted controller, and selected branches must have the matching thin Development workflow. These workflows target `main` as the trusted default and formal branch. Configure read access for the pinned SDK image and private Release helper, `BINARY_ARTIFACTS_TOKEN` for private cross-repository reads and a `RELEASE_PUBLISH_KEY` scoped to `component/gmr/dev` for upload. Release imports and publication use the pinned AutolifeRelease-V3 main revision 4ce9a02. Formal component versions are immutable. System promotion is a separate operator action.

Download the Actions artifact, unzip it and run `sha256sum -c SHA256SUMS`. The archive installs with `just install /absolute/path/to/original.tar.gz --yes` on a prepared robot. An authorized operator may publish those same bytes from Release main with `just component publish gmr /absolute/path/to/original.tar.gz --delivery-metadata /absolute/path/to/delivery-manifest.json --yes`.
