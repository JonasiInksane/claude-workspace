---
paths:
  - "app/**"
  - "src/**"
  - "components/**"
---

# Next.js rules

These load when Claude reads or edits app code. Project-specific facts (version, router,
package manager, commands) live in CLAUDE.md.

## Version and router
- Check the installed Next.js version (`node_modules/next/package.json`) before using an API
  you remember. Behaviour around caching, `params` and middleware changes between majors.
- App Router (`app/` or `src/app/`): no Pages Router patterns (`getServerSideProps`,
  `getStaticProps`, `next/router`). Use `next/navigation` in client components.
- Next.js 15 and later: `params`, `searchParams`, `cookies()` and `headers()` are async.
  Await them.
- Next.js 16 renamed `middleware.ts` to `proxy.ts`. Edit whichever file the project has.

## Server and client components
- Components are Server Components by default. Add `"use client"` only to files that need
  state, effects, event handlers or browser APIs. Keep those files small and low in the tree;
  pass server-fetched data down as props.
- Never import server-only code (database clients, `fs`, secrets, admin SDKs) into a client
  component. Mark such modules with `import "server-only"` so a wrong import fails the build.
- Props passed from a server to a client component must be serializable: no functions
  (except Server Actions) and no class instances.

## Data and mutations
- Fetch data in Server Components or the data layer, not in `useEffect`, unless the data
  is truly client-only.
- Mutations go through Server Actions (`"use server"`) or route handlers, following the
  project's existing pattern. Validate input on the server and check auth inside every action.
- After a mutation, revalidate what changed (for example `revalidatePath`) or redirect, using
  the caching APIs of the installed version.

## Routing files
- Use `loading.tsx`, `error.tsx` (a client component) and `not-found.tsx` for those states.
- `(group)` folders are route groups and don't appear in the URL. `[slug]` folders are
  dynamic segments.
- Set titles and descriptions with the `metadata` export or `generateMetadata`, not `<head>`.

## Environment variables
- Only `NEXT_PUBLIC_` variables reach the browser, and their values are inlined at build
  time. Never give a secret that prefix. Rebuild after changing one.
- Read secrets only in server code. Don't read `.env*` files; the names are in `.env.example`.

## Assets and styling
- Use `next/image` for images and `next/link` for internal links.
- Follow the project's styling system (Tailwind, CSS modules, ...). Don't add a second one.
- Don't hand-edit generated UI kit files if CLAUDE.md says they are generated.
