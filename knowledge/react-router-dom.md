# React Router DOM Best Practices (Data Router Pattern)

Prefer React Router's **data router APIs** for modern route-centric data loading and mutations.

## Router Setup

- Use `createBrowserRouter` + `RouterProvider` for web apps.
- Co-locate `loader`, `action`, and route elements.
- Type route data carefully and parse external input.

```tsx
// ✅ Do
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        loader: homeLoader,
        element: <HomePage />,
      },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
```

```tsx
// ❌ Don't (new apps)
// <BrowserRouter><Routes>...</Routes></BrowserRouter> for complex data/mutation flows
```

## Loaders and Actions

- Fetch in loaders, mutate in actions; avoid duplicate fetch Effects in components.
- Throw `Response` for HTTP-style errors; handle with `errorElement` and route error boundaries.
- Validate params/query/body before use.

```tsx
// ✅ Do
import { json, type LoaderFunctionArgs } from 'react-router-dom';

export async function projectLoader({ params }: LoaderFunctionArgs) {
  const id = params.projectId;
  if (!id) throw new Response('Missing projectId', { status: 400 });

  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) throw new Response('Project not found', { status: res.status });

  const project: Project = await res.json();
  return json({ project });
}
```

## Navigation and Links

- Prefer `<Link>`/`<NavLink>` over imperative navigation for standard flows.
- Use `useNavigate` for post-action redirects or guarded transitions.
- Preserve accessibility: meaningful link text and focus behavior.

## Pending UI and Optimistic UX

- Use `useNavigation()` to display pending states globally or per route.
- Use `<Form>` and fetchers for mutation flows without manual event plumbing.
- Avoid blocking UI with full-page spinners for small transitions.

## Route Module Organization

- Keep each route module self-contained:
  - route component
  - loader/action
  - local types/parsers
  - error boundary
- Split large route trees lazily where it improves startup performance.

## Common Pitfalls

- Fetching route data in component Effects instead of loaders.
- Ignoring aborted requests/navigation races.
- Unvalidated `params` causing runtime errors.
- Using unstable relative links in deeply nested routes.