# Wheel release contract

> **Pending verification: `simplify/wheel-release` (2026-10-16).**
> This branch has not been tested end to end. Full build, installation and integration
> verification, plus further debugging, are pending until the base image is ready.
> Existing local checks are partial evidence only; this branch is not qualified for deployment.

`release-package.json` declares package `gmr`, its application distributions, build inputs,
optional runtime files, explicit model assets, service names and runtime package prerequisites.
The shared builder invokes `packaging/build-release.sh` from this existing checkout.
It does not clone or switch source. This repo owns its compiler commands and dependency pins.
The result contains `manifest.json`, `wheels/`, optional `runtime.tar.gz` and optional `assets/`.
Release checks hashes and gives changed application wheels unique release versions; unchanged
producer inputs reuse their completed package. Dependency wheels keep upstream versions.

The target must already have Python 3.12 in `$AUTOLIFE_ROOT/env` and the required host/ROS libraries.
The default root is `~/autolife-v3`. Pip installs wheels into that environment. External runtime
files go into `$AUTOLIFE_ROOT/runtime/gmr/`; existing `config/` and `data/` are operator-owned.
The client does not provision Conda, the OS, configuration or hardware.

Service units in `packaging/services/` and their launcher in `packaging/bin/` belong to this repo.
Release renders only `@AUTOLIFE_ROOT@` and installs user units. Operator systemd drop-ins stay in place.
Updates never stop, start or enable a unit. Stop affected services explicitly before installation.

For source development, keep a checkout anywhere, set `AUTOLIFE_ROOT` when the deployment is
not `~/autolife-v3`, stop its installed service, then run this repo's `just dev` command.
Python source uses a process-local import path; native producers build incrementally.
SDK source overrides remain explicit through `AUTOLIFE_SDK_SOURCE`. No editable install or
source synchronization helper changes the installed wheel. Ctrl-C leaves services stopped.
SDK and GMR are libraries; run the consuming application's dev command.
