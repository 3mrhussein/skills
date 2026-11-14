#!/bin/bash
# Builds the moro CLI from this clone, puts `moro` on the PATH and hands over to
# `moro bootstrap`. Rerun it after a pull to rebuild and relink. Flags (--yes, --agents <agent…>) go to bootstrap.
set -eu

fail() {
  echo "$1" >&2
  exit 1
}

# The checks use only builtins, so a missing tool is named, not a "command not found".
command -v node >/dev/null 2>&1 || fail "node is missing. Install node 22.20 or newer, then rerun ./install.sh."
command -v git >/dev/null 2>&1 || fail "git is missing. Install git, then rerun ./install.sh."

version="$(node -p 'process.versions.node')"
IFS=. read -r major minor _ <<<"$version"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 20 ]; }; then
  fail "node $version is too old. Install node 22.20 or newer, then rerun ./install.sh."
fi

root="$(cd "${0%/*}" && pwd)"
cd "$root/cli"
npm ci
npm run build
npm link
# The commit the build came from, for moro's "rerun ./install.sh" hint.
git -C "$root" rev-parse HEAD >dist/built-from

# `npm link` may put moro in a global bin that isn't on this shell's PATH yet.
if ! command -v moro >/dev/null 2>&1; then
  PATH="$(npm prefix -g)/bin:$PATH"
  export PATH
fi
cd "$root"
exec moro bootstrap "$@"
