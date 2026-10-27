#!/usr/bin/env sh
# Install everything (first run) and launch the digital twin.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
exec node scripts/start.mjs "$@"
