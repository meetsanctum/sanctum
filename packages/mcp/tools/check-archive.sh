#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$1"
destination="$(cd "$1" && pwd)"
version="$(jq -r .version package.json)"

# pnpm rewrites workspace versions as it packs the connector.
pnpm pack --pack-destination "$destination"
tarball="$destination/connector.tgz"
mv "$destination/meetsanctum-mcp-$version.tgz" "$tarball"

listed="$(tar -tzf "$tarball" | LC_ALL=C sort | tr '\n' ' ')"
expected="package/LICENSE package/README.md package/dist/cli.js package/package.json "
if [ "$listed" != "$expected" ]; then
  echo "::error::The package holds: $listed"
  exit 1
fi
if tar -xzOf "$tarball" package/dist/cli.js | grep -E '(from |import\()"@meetsanctum/' >/dev/null; then
  echo "::error::dist/cli.js imports a workspace package instead of bundling it"
  exit 1
fi

# Install outside the workspace so a missing dependency cannot resolve there.
install_dir="$(mktemp -d "$destination/install.XXXXXX")"
trap 'rm -rf "$install_dir"' EXIT
cd "$install_dir"
npm install --ignore-scripts --no-audit --no-fund "$tarball"
installed_version="$(node_modules/.bin/sanctum-mcp --version)"
if [ "$installed_version" != "$version" ]; then
  echo "::error::The installed connector reports $installed_version, expected $version"
  exit 1
fi
