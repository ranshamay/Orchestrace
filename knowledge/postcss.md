# PostCSS (Orchestrace UI)

PostCSS is used in `@orchestrace/ui` as a CSS processing pipeline with Tailwind CSS and Autoprefixer.

## Repository Reality

`packages/ui/postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

Installed in `packages/ui` dev dependencies:

- `postcss`
- `tailwindcss`
- `autoprefixer`

## Do / Don’t

### Do

- **Do** keep plugin configuration explicit and minimal.
- **Do** run PostCSS through Vite build/dev pipeline (default behavior in this setup).
- **Do** ensure Tailwind and Autoprefixer stay version-compatible with PostCSS.

### Don’t

- **Don’t** add overlapping plugins that duplicate transformations.
- **Don’t** introduce environment-specific CSS behavior without clear documentation.
- **Don’t** rely on implicit plugin order when order affects output.

## Common Pitfalls

- Plugin order mistakes when adding new PostCSS plugins.
- Version mismatches causing build-time warnings or broken transforms.
- Assuming PostCSS runs outside Vite in package scripts when it currently does not.

## Performance Advice

- Keep PostCSS plugin count low to reduce CSS transform time.
- Avoid broad, expensive custom transforms unless necessary.
- In CI, prefer shared dependency caches and Turbo task caching around build steps that include CSS compilation.

## Example Extension (Careful)

If adding another plugin, document why and expected output changes:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
    // cssnano: {}, // enable only when minification strategy is agreed
  },
}
```