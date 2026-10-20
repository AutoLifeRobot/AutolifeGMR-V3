# Self-hosted CI for AutolifeGMR-V3

Linux jobs require explicit `self-hosted` labels and Docker access. No GitHub-hosted
fallback or host Python, Conda, Bun, just, gh or apt installation is used.

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
