# Shell Best Practices

Shell scripts are powerful but fragile. Optimize for safety, portability, and debuggability.

## Core Principles

- Fail early and loudly.
- Quote everything unless you intentionally want word splitting.
- Keep scripts idempotent and explicit.

## Do / Don't

### 1) Use strict mode and predictable IFS

```bash
# ✅ Do
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

```bash
# ❌ Don't
#!/bin/bash
# default loose behavior
```

### 2) Quote variable expansions

```bash
# ✅ Do
rm -rf -- "$target_dir"
cp -- "$src" "$dest"
```

```bash
# ❌ Don't
rm -rf $target_dir
cp $src $dest
```

### 3) Use robust loops

```bash
# ✅ Do
while IFS= read -r file; do
  echo "Processing: $file"
done < <(find . -type f -name "*.ts")
```

```bash
# ❌ Don't
for file in $(find . -type f -name "*.ts"); do
  echo "$file"
done
```

## Pitfalls

- Using `[` when `[[` is safer for string tests in Bash.
- Ignoring command exit codes in pipelines without `pipefail`.
- Dangerous `rm -rf` without guardrails.

## Performance Notes

- Prefer built-in shell features over spawning many subprocesses.
- Batch operations (`xargs -0 -n`) for large file sets.
- Use dedicated tools (`rg`, `jq`) for complex text/JSON processing.

## Practical Checklist

- [ ] `set -euo pipefail` enabled.
- [ ] Variables quoted.
- [ ] Destructive commands guarded and logged.
- [ ] Script re-run behavior is safe.