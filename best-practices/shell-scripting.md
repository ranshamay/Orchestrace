# Shell Scripting Best Practices

## Overview
Reliable shell scripts should be safe, readable, and portable enough for CI/CD and ops workflows. Favor defensive scripting over quick hacks.

## Key Principles
- Fail fast and loudly.
- Quote variables and handle whitespace correctly.
- Validate inputs and dependencies early.
- Keep scripts idempotent when possible.
- Log intent and errors for observability.

## Best Practices

### 1) Start with strict mode
**DO**
```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

**DON'T**
```bash
#!/bin/bash
# no strict mode
```

### 2) Quote variable expansions
**DO**
```bash
rm -f -- "$target_file"
cp -- "$source" "$destination"
```

**DON'T**
```bash
rm -f $target_file
cp $source $destination
```

### 3) Validate required tools and arguments
**DO**
```bash
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
: "${ENVIRONMENT:?ENVIRONMENT must be set}"
```

**DON'T**
```bash
jq '.name' config.json
# assumes ENVIRONMENT exists
```

### 4) Use functions for structure
**DO**
```bash
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
backup_file() {
  local file="$1"
  cp -- "$file" "$file.bak"
}
```

**DON'T**
```bash
echo "start"
cp "$1" "$1.bak"
echo "done"
# repeated in many places
```

### 5) Clean up with traps
**DO**
```bash
tmp_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT
```

**DON'T**
```bash
tmp_dir=/tmp/my-script
mkdir -p "$tmp_dir"
# may leak temp files on failure
```

### 6) Prefer `$(...)` and test command exit codes
**DO**
```bash
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if grep -q "READY" status.txt; then
  echo "ready"
fi
```

**DON'T**
```bash
current_branch=`git rev-parse --abbrev-ref HEAD`
if [ "$(grep READY status.txt)" != "" ]; then
  echo "ready"
fi
```

## Common Mistakes
- Ignoring non-zero exit codes.
- Unquoted variables causing globbing/word-splitting bugs.
- Parsing human-readable command output that changes format.
- Hardcoded temp paths and missing cleanup.
- Mixing Bash-specific features in scripts intended for POSIX `sh`.

## Checklist
- [ ] Script includes shebang and strict mode.
- [ ] All variable expansions are quoted unless intentionally split.
- [ ] Required commands and env vars are validated.
- [ ] Side effects are logged and errors are explicit.
- [ ] Temporary files are cleaned up with `trap`.
- [ ] Script has been tested with representative inputs/failures.