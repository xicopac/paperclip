#!/usr/bin/env bash
set -euo pipefail

# build-npm.sh — Build the paperclipai CLI package for npm publishing.
#
# Uses esbuild to bundle all workspace code into a single file,
# keeping external npm dependencies as regular package dependencies.
#
# Usage:
#   ./scripts/build-npm.sh               # full build
#   ./scripts/build-npm.sh --skip-checks  # skip forbidden-token check (CI without token list)
#
# Environment:
#   PAPERCLIP_README_ASSET_REF=<sha|tag>  # pin README image assets instead of the current HEAD
#   PAPERCLIP_RELEASE_REUSE_UI_DIST=1     # reuse an existing ui/dist instead of rebuilding the UI

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
DIST_DIR="$CLI_DIR/dist"

skip_checks=false
skip_typecheck=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) skip_checks=true ;;
    --skip-typecheck) skip_typecheck=true ;;
  esac
done

echo "==> Building paperclipai for npm"

# ── Step 1: Forbidden token check ──────────────────────────────────────────────
if [ "$skip_checks" = false ]; then
  echo "  [1/7] Running forbidden token check..."
  node "$REPO_ROOT/scripts/check-forbidden-tokens.mjs"
else
  echo "  [1/7] Skipping forbidden token check (--skip-checks)"
fi

# ── Step 2: TypeScript type-check ──────────────────────────────────────────────
if [ "$skip_typecheck" = false ]; then
  echo "  [2/7] Type-checking..."
  cd "$REPO_ROOT"
  corepack pnpm -r typecheck
else
  echo "  [2/7] Skipping type-check (--skip-typecheck)"
fi

# ── Step 3: Stage the generated server publish artifacts ───────────────────────
# `scripts/prepare-bundled-package.mjs` copies each package's `files` entries
# verbatim, and server declares `ui-dist` and `skills`. Both are generated and
# gitignored, and no `build` script emits them, so whoever packages
# @paperclipai/server after this script has to find them already staged. The
# release flow does the same staging in its Step 2/7 before calling this script;
# PAPERCLIP_RELEASE_REUSE_UI_DIST=1 (set by release.sh) makes that path reuse the
# ui/dist it just built instead of rebuilding it here.
echo "  [3/7] Staging server UI dist + bundled skills..."
cd "$REPO_ROOT"

# prepare-server-ui-dist.sh calls bare `pnpm`. On a machine where pnpm exists only
# through corepack, provision a shim for this script's lifetime, mirroring the
# git-install path in cli/src/commands/install.ts.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  pnpm_shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-build-npm-pnpm.XXXXXX")"
  corepack enable pnpm --install-directory "$pnpm_shim_dir" >/dev/null
  PATH="$pnpm_shim_dir:$PATH"
  export PATH
fi

bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done

# ── Step 4: Bundle CLI with esbuild ────────────────────────────────────────────
echo "  [4/7] Bundling CLI with esbuild..."
cd "$CLI_DIR"
rm -rf dist

node --input-type=module -e "
import esbuild from 'esbuild';
import config from './esbuild.config.mjs';
await esbuild.build(config);
"

chmod +x dist/index.js

# ── Step 5: Validate bundled entrypoint syntax ─────────────────────────────────
echo "  [5/7] Verifying bundled entrypoint syntax..."
node --check "$DIST_DIR/index.js"

# ── Step 6: Back up dev package.json, generate publishable one ─────────────────
echo "  [6/7] Generating publishable package.json..."
cp "$CLI_DIR/package.json" "$CLI_DIR/package.dev.json"
node "$REPO_ROOT/scripts/generate-npm-package-json.mjs"

# Copy the root README so npm shows the repo README on the package page, but
# rewrite repository-relative image assets because npm resolves README links
# under the package's `repository.directory` (`cli`), not the repository root.
README_ASSET_REF="${PAPERCLIP_README_ASSET_REF:-}"
if [ -z "$README_ASSET_REF" ]; then
  README_ASSET_REF="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
README_ASSET_REF="${README_ASSET_REF:-master}"
node "$REPO_ROOT/scripts/prepare-npm-readme.mjs" \
  "$REPO_ROOT/README.md" \
  "$CLI_DIR/README.md" \
  "$README_ASSET_REF"

# ── Step 7: Summary ───────────────────────────────────────────────────────────
BUNDLE_SIZE=$(wc -c < "$DIST_DIR/index.js" | xargs)
echo "  [7/7] Build verification..."
echo ""
echo "Build complete."
echo "  Bundle: cli/dist/index.js (${BUNDLE_SIZE} bytes)"
echo "  Source map: cli/dist/index.js.map"
echo ""
echo "To preview:   cd cli && npm pack --dry-run"
echo "To publish:   cd cli && npm publish --access public"
echo "To restore:   mv cli/package.dev.json cli/package.json"
