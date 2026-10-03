#!/bin/sh
# Commit only after the leak scan passes.
# This machine's git does not launch hooks, so do not call git commit directly
# on a public repo. CI runs the same scan if a hook is skipped.
set -eu
root=$(git rev-parse --show-toplevel)
cd "$root"
node scripts/leak-scan.mjs . --staged
exec git \
  -c user.name="${GIT_AUTHOR_NAME:-Amperstrand}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-141745238+Amperstrand@users.noreply.github.com}" \
  commit "$@"
