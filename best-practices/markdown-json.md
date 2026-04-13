# Markdown & JSON Best Practices

## Overview
Markdown should be readable in raw form and consistent in rendered form. JSON should be valid, predictable, and easy for machines and humans to consume.

## Key Principles
- Optimize for clarity and consistency.
- Keep structure stable for automation.
- Avoid ambiguity in naming and formatting.
- Validate early with linters/schemas.
- Treat docs and data as versioned artifacts.

## Best Practices

### 1) Use clear heading hierarchy in Markdown
**DO**
```markdown
# API Guide

## Authentication
### Token Refresh
```

**DON'T**
```markdown
# API Guide
#### Token Refresh
## Authentication
```

### 2) Prefer descriptive links and concise lists
**DO**
```markdown
- Review the [deployment runbook](./DEPLOYMENT.md).
- Open a ticket with the incident template.
```

**DON'T**
```markdown
- Click [here](./DEPLOYMENT.md).
- Do stuff.
```

### 3) Keep Markdown code fences typed
**DO**
````markdown
```json
{ "service": "billing", "enabled": true }
```
````

**DON'T**
````markdown
```
{ "service": "billing", "enabled": true }
```
````


### 4) Use valid JSON with consistent types
**DO**
```json
{
  "retryCount": 3,
  "enabled": true,
  "regions": ["us-east-1", "eu-west-1"]
}
```

**DON'T**
```json
{
  "retryCount": "3",
  "enabled": "yes",
  "regions": "us-east-1,eu-west-1"
}
```

### 5) Standardize key naming and timestamps
**DO**
```json
{
  "userId": "u_123",
  "createdAt": "2026-01-20T10:15:00Z"
}
```

**DON'T**
```json
{
  "user_id": "u_123",
  "created_at": "01/20/2026 10:15 AM"
}
```

### 6) Validate JSON with schema where possible
**DO**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["service", "port"],
  "properties": {
    "service": { "type": "string" },
    "port": { "type": "integer", "minimum": 1, "maximum": 65535 }
  }
}
```

**DON'T**
```json
{
  "service": "api",
  "port": "sometimes-a-string"
}
```

## Common Mistakes
- Skipping heading levels and producing hard-to-scan docs.
- Inconsistent bullet and table formatting.
- Using comments in strict JSON (not supported).
- Changing key names or types without versioning.
- Storing date/time values in locale-specific formats.

## Checklist
- [ ] Markdown uses consistent heading levels and link style.
- [ ] Code fences include language hints.
- [ ] JSON is pretty-printed and syntactically valid.
- [ ] Key names and value types are consistent.
- [ ] Dates/times use ISO 8601 (UTC where appropriate).
- [ ] JSON schema or validation checks run in CI.