#!/usr/bin/env bash
set -euo pipefail

# End-to-end configure smoke test for @rikology/adonisjs-audit-trail.
# Builds the package, scaffolds a fresh AdonisJS v7 app, installs the tarball,
# runs configure + migrations, and exercises the audit CLI commands.

LOCAL_PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="${E2E_DIR:-/tmp/adonisjs-audit-trail-e2e}"
PACK_DIR="${PACK_DIR:-/tmp/adonisjs-audit-trail-pack}"

rm -rf "$E2E_DIR" "$PACK_DIR"
mkdir -p "$PACK_DIR"

echo "==> Building package"
cd "$LOCAL_PKG_DIR"
npm run build

echo "==> Packing package"
npm pack --pack-destination "$PACK_DIR" >/dev/null
TARBALL=$(ls "$PACK_DIR"/*.tgz | head -n 1)

echo "==> Scaffolding fresh AdonisJS app"
npx --yes create-adonisjs@latest "$E2E_DIR" --kit="api" --pkg="npm"

cd "$E2E_DIR"
echo "==> Installing local package"
npm install "$TARBALL"

echo "==> Running configure with defaults"
# Send blank answers for the confirm prompts. The "yes" helper exits 141 (SIGPIPE)
# once the configure command closes stdin, which is expected.
yes '' | node ace configure @rikology/adonisjs-audit-trail || [ $? -eq 141 ]
echo "==> Running migrations"
node ace migration:run

echo "==> Smoke-test audit commands"
node ace audit:stats
node ace audit:verify --json

echo "==> E2E configure smoke test passed"

