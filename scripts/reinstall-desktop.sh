#!/usr/bin/env bash
# Rebuild dsh-intelligent-ui and install it into the desktop profile.
#
# The plugin is installed as a packed tarball, never as a directory link: a
# linked source tree exposes its own node_modules (the @deepseek-ai packages
# kept for typechecking) to the Loader, which resolves those copies instead of
# the runtime's and then fails on their uninstalled transitive peers.
#
# After a successful install the DeepSeek Harness app must be restarted: the
# running Host caches package metadata for the life of the process, so a new
# bundle never activates in place.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="$HOME/.dsh/genui-pkg"
TARBALL="$STAGING/dsh-intelligent-ui-0.1.0.tgz"

cd "$PROJECT"
echo "== check =="
pnpm run check

echo "== pack =="
rm -rf dist
mkdir -p "$STAGING"
pnpm pack --pack-destination "$STAGING" >/dev/null
ls -l "$TARBALL"

echo "== install into the desktop profile =="
dsh plugin --profile desktop remove dsh-intelligent-ui >/dev/null 2>&1 || true
dsh plugin --profile desktop add "$TARBALL"

echo
echo "Installed. Now restart DeepSeek Harness, then verify both halves:"
echo "  cordis_inspect_query client/Slots/listSubTree root=tool.call.toolview"
echo "    -> occupants must contain {registrant:\"dsh-intelligent-ui\", key:\"artifact\", active:true}"
echo "  cordis_inspect_query host/Tool/listTools"
echo "    -> must contain name:\"artifact\""
