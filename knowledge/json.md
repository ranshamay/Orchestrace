# JSON Best Practices

JSON is a data interchange format; enforce consistency and schema discipline.

## Core Principles

- Keep JSON machine-friendly and predictable.
- Validate shape and types at ingestion boundaries.
- Use stable keys and avoid ambiguous value semantics.

## Do / Don't

### 1) Keep types consistent

```json
{
  "retryCount": 3,
  "enabled": true,
  "service": "worker"
}
```

```json
{
  "retryCount": "3",
  "enabled": "yes",
  "service": 42
}
```

### 2) Use explicit nullability semantics

```json
{
  "description": null,
  "tags": []
}
```

```json
{
  "description": "",
  "tags": null
}
```

### 3) Version external payloads

```json
{
  "schemaVersion": 1,
  "data": {
    "id": "abc123"
  }
}
```

```json
{
  "data": {
    "id": "abc123"
  }
}
```

## Pitfalls

- Trailing comments (invalid in strict JSON).
- Floating-point assumptions for money/precision-sensitive values.
- Breaking consumers with unannounced key renames.

## Performance Notes

- Avoid deeply nested structures when flat structures suffice.
- Large payloads: paginate/stream rather than loading all at once.
- Compress payloads in networked systems when appropriate.

## Practical Checklist

- [ ] JSON schema or runtime validator exists for external data.
- [ ] Field names are stable and documented.
- [ ] Null vs empty value rules are explicit.
- [ ] Example payloads included in related docs/API specs.