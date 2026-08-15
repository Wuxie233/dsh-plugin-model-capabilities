#!/usr/bin/env bash
# Deploy this plugin into the dsh profile's node_modules.
# Source of truth is this repo; the runtime copy is disposable (a dsh profile
# update/heal may remove it — just re-run this script).
# Host-half plugin: after deploying, restart dsh web to take effect.
set -euo pipefail
cd "$(dirname "$0")"
name=$(node -p "require('./package.json').name")
target="${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/$name"
rm -rf "$target"
mkdir -p "$target"
cp -r package.json lib "$target/"
echo "deployed: $name -> $target"
