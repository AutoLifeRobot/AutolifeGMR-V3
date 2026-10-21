# Docker CI for AutolifeGMR-V3

This public repository is the approved runner exception: every GMR job uses
GitHub-hosted `ubuntu-24.04`, while dependency installation, tests and packaging
remain inside the existing job-owned Docker container. Other AutoLife repositories
keep their self-hosted policy. No host Python, Conda, Bun, just, gh or apt
installation is used.

- `.github/scripts/ci-container.sh`: unique container and checkout, client-side
  `docker cp`, exact event SHA, bounded cleanup and real exit-status evidence.
- `ci-common.sh`: container-only dependency/LFS helpers.
- `ci-task.sh`: original per-job functional gates and build commands.
- Checkout uses a run/attempt/job/matrix-specific path. Only that path and the
  owned container are cleaned; never prune Docker or change a shared environment.
- Existing dist/test-results artifact names are unchanged. A separate CI evidence
  artifact records image identity, logs and command/copy/cleanup exit codes.
- Ubuntu24 native wheels retain their platform checks inside the build container.
- Ordinary host requirements: Actions runner Node, Bash/coreutils, Git and Docker.
  Docker daemon must be accessible; container creation failure is not a test PASS.
- Git LFS is fetched inside Docker for the exact event SHA, then fsck is required.
  A read-only job token is supplied only to that exec and is not stored in outputs.

## Public container image source

Public base images are pulled directly from their official registries: Docker Hub
(`docker.io`) and NVIDIA NGC (`nvcr.io`) where applicable. Repository names, version
tags and existing digests stay unchanged; tags without a digest remain tag-based.
Company images stay on GHCR. No public registry proxy or automatic mirror fallback
is selected by these workflows. Package repositories and functional gates are
unchanged; registry failures remain failures.

## Slow-network budgets

CI bootstrap asset downloads allow a 120-second connection, up to 3,600 seconds
per transfer and a 7,200-second retry window, retaining the original retry count
and SHA256 checks. Explicit short build/job limits are widened for VPN downloads;
protocol, device-close, test-hang and owned-resource cleanup deadlines are unchanged.
A slower download never changes a functional failure into a pass.
