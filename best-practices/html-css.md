# HTML & CSS Best Practices

## Overview
Great frontend markup and styling are semantic, accessible, responsive, and maintainable. Write HTML that describes meaning and CSS that scales cleanly.

## Key Principles
- Use semantic HTML first; style second.
- Design with accessibility from the start.
- Build mobile-first and responsive layouts.
- Keep CSS predictable and component-oriented.
- Minimize specificity wars and global side effects.

## Best Practices

### 1) Use semantic structure
**DO**
```html
<header>
  <h1>Order Dashboard</h1>
</header>
<main>
  <section aria-labelledby="recent-orders">
    <h2 id="recent-orders">Recent Orders</h2>
  </section>
</main>
```

**DON'T**
```html
<div class="header">Order Dashboard</div>
<div class="main">
  <div class="title">Recent Orders</div>
</div>
```

### 2) Always provide accessible labels
**DO**
```html
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required />
```

**DON'T**
```html
<input placeholder="Email" />
```

### 3) Prefer responsive layout systems
**DO**
```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 1rem;
}
```

**DON'T**
```css
.card { width: 320px; float: left; margin-right: 16px; }
```

### 4) Keep CSS specificity low
**DO**
```css
.button { padding: 0.5rem 1rem; }
.button--primary { background: #1d4ed8; color: white; }
```

**DON'T**
```css
body div.page main section .actions .button.primary {
  background: blue !important;
}
```

### 5) Respect motion and contrast preferences
**DO**
```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

**DON'T**
```css
.loader { animation: spin 300ms linear infinite; }
```

### 6) Optimize media delivery
**DO**
```html
<img
  src="/images/product-800.jpg"
  srcset="/images/product-400.jpg 400w, /images/product-800.jpg 800w"
  sizes="(max-width: 600px) 100vw, 50vw"
  alt="Blue running shoe"
  loading="lazy"
/>
```

**DON'T**
```html
<img src="/images/product-original-5000px.jpg">
```

## Common Mistakes
- Using generic `div`/`span` for everything.
- Missing form labels and keyboard focus styles.
- Pixel-fixed layouts that break on small screens.
- Excessive `!important` usage.
- Large unoptimized images and webfonts.

## Checklist
- [ ] Landmarks (`header`, `main`, `nav`, `footer`) are used appropriately.
- [ ] Inputs have labels, errors, and keyboard-friendly behavior.
- [ ] Layout is responsive across common breakpoints.
- [ ] CSS classes are reusable and low-specificity.
- [ ] Color contrast and focus states are accessible.
- [ ] Images/fonts are optimized and lazy-loaded where appropriate.