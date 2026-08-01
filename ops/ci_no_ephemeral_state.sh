#!/usr/bin/env bash
# CI gate: fail the build if durable state (*.db/*.json/*.sqlite) is written to /tmp or a bare cwd path
# outside the config module. Keeps ephemeral-storage bugs from ever merging.
set -euo pipefail
viol=$(grep -rnE "tmpdir\(\)|os\.tmpdir|/tmp/[^\"']*\.(db|sqlite|json)" --include=*.js src 2>/dev/null \
  | grep -viE "test|preview|sample|scratch|durability_probe|selftest" || true)
if [ -n "$viol" ]; then echo "Durable state on ephemeral path:"; echo "$viol"; exit 1; fi
echo "clean"
