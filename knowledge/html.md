# HTML Best Practices

HTML should prioritize semantics, accessibility, and maintainability.

## Core Principles

- Use semantic elements (`header`, `main`, `nav`, `button`, etc.).
- Ensure keyboard and screen-reader accessibility by default.
- Keep structure meaningful; CSS handles visual concerns.

## Do / Don't

### 1) Use semantic controls

```html
<!-- ✅ Do -->
<button type="button" aria-label="Close dialog">×</button>
```

```html
<!-- ❌ Don't -->
<div onclick="closeDialog()">×</div>
```

### 2) Associate labels and inputs

```html
<!-- ✅ Do -->
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required />
```

```html
<!-- ❌ Don't -->
<input placeholder="Email" />
```

### 3) Preserve heading hierarchy

```html
<!-- ✅ Do -->
<h1>Settings</h1>
<h2>Profile</h2>
<h2>Security</h2>
```

```html
<!-- ❌ Don't -->
<h1>Settings</h1>
<h4>Profile</h4>
```

## Pitfalls

- Missing alt text on meaningful images.
- Clickable elements without keyboard interaction.
- Invalid nesting (e.g., interactive elements inside interactive elements).

## Performance Notes

- Defer non-critical scripts.
- Set image dimensions to reduce layout shift.
- Prefer native browser behavior over heavy JS re-implementation.

## Practical Checklist

- [ ] Landmarks (`header/main/footer/nav`) present.
- [ ] Form fields have labels and names.
- [ ] Interactive elements are keyboard accessible.
- [ ] ARIA used only when native semantics are insufficient.