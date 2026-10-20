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

Public base images use the DaoCloud accelerator at `m.daocloud.io`, preserving
the upstream repository, version tag and existing digest. Tags without a digest
remain tag-based. Its CDN may cross borders; this is not a Mainland-only network
guarantee. Company GHCR images remain on GHCR, and company credentials must not
be sent to the accelerator. Package repositories and functional gates are unchanged.
