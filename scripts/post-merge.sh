#!/bin/bash
# Runs automatically after a task is merged. Stdin is closed (EOF on read),
# so every command must be non-interactive. Keep this fast — the user is
# waiting on it.
set -e

# Idempotently install/refresh node_modules. `npm install` is a no-op when
# package-lock.json and node_modules already match, and pulls in any new
# deps a merged task added.
# --legacy-peer-deps is required because @wagmi/connectors@5.11.2 declares a
# strict peer on @wagmi/core@2.21.2 while the project pins @wagmi/core@^3.4.2
# (see package.json). The lockfile and existing node_modules were resolved
# this way already; npm@9+ enforces peer deps by default and would fail
# without this flag.
npm install --no-audit --no-fund --prefer-offline --legacy-peer-deps
