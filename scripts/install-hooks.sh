#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
cd "$root"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "hooks path: $(git config core.hooksPath)"
