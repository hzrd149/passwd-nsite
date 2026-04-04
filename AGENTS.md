# AGENTS.md

## Purpose

This file gives coding agents the repo-specific context needed to work safely in `passwd-nsite`.

The app is a Vite + React + TypeScript project with:

- a small config UI in `src/pages/`
- a service-worker router in `src/router/`
- browser-side 7z archive tooling in `src/lib/7zip.ts`
- Tailwind CSS v4 imported from `src/index.css`

Prefer small, direct changes. Keep the router worker as small as possible.

## Rule Files

At the time this file was written, the repo does **not** contain:

- `.cursor/rules/`
- `.cursorrules`
- `.github/copilot-instructions.md`

If any of those files are added later, treat them as additional instructions and update this file.

## Package Manager

Use `pnpm` in this repository.

Evidence:

- `pnpm-lock.yaml` exists
- dependencies are already installed through pnpm

## Commands

Run commands from the repository root.

Install dependencies:

```bash
pnpm install
```

Start the dev server:

```bash
pnpm dev
```

Build for production:

```bash
pnpm build
```

Notes:

- `pnpm build` runs `tsc -b` and then `vite build`
- Vite emits the service worker as `dist/router.js`

Lint:

```bash
pnpm lint
```

Format:

```bash
pnpm format
```

Preview the production build:

```bash
pnpm preview
```

## Test Status

There is currently **no test runner configured**.

That means there is no supported command for:

- `pnpm test`
- watch mode tests
- coverage
- running a single test file
- running a single test case

If asked to run tests, say clearly that no automated test suite exists yet.

## Single-Test Guidance

There is currently **no supported single-test command**.

If tests are added later, update this file with:

- the main test command
- how to run a single file
- how to run a single test name pattern

Until then, the closest verification flow is:

```bash
pnpm lint
pnpm build
```

## Architecture

App shell:

- `src/App.tsx` does very light hash-based routing
- `#/` is the main config flow
- `#/debug` is the debug/archive tooling view

Main config UI:

- `src/pages/HomePage.tsx` is the main lock/unlock flow
- user-facing language should be about locking and unlocking the site
- avoid exposing router internals in normal UI copy

Debug UI:

- `src/pages/DebugPage.tsx` is intentionally separate
- keep debug features isolated from the main config experience

Router worker:

- `src/router/index.ts` is the service worker router
- keep it maximally small
- it should only read stored files, report current mode, and enable/disable routing
- it should not own archive processing, file writes, or MIME lookup logic

Shared storage:

- `src/router/storage.ts` owns IndexedDB access for stored files and mode
- config app code writes directly to storage
- router worker reads from storage directly

Archive tooling:

- `src/lib/7zip.ts` is heavy because it pulls in wasm and 7z runtime code
- do **not** eagerly import it into initial-load app code
- prefer `await import("../lib/7zip")` at call sites

## Build Notes

- `vite.config.ts` intentionally sets `build.minify = false`
- this is deliberate so generated output stays inspectable and modifiable
- do not change minification behavior unless the user asks

## TypeScript Rules

TypeScript is strict. Important settings include:

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noFallthroughCasesInSwitch: true`
- `verbatimModuleSyntax: true`
- `moduleResolution: "bundler"`

Practical implications:

- remove unused imports immediately
- prefer explicit unions for UI and state-machine phases
- keep switch statements exhaustive
- use `import type` for type-only imports
- do not rely on CommonJS patterns

## Code Style

Imports:

- React imports first
- local imports after
- `import type` for type-only imports
- keep imports relative; there is no path alias configured

Formatting:

- use Prettier via `pnpm format`
- double quotes, semicolons, trailing commas where Prettier adds them
- multi-line JSX when props or text become long
- do not hand-format against Prettier

Types:

- prefer explicit types for public helpers and stored data structures
- keep `unknown` errors normalized before showing messages
- preserve `mime` on each `RouterFileRecord`

Naming:

- React components: `PascalCase`
- types: `PascalCase`
- functions/variables: `camelCase`
- constants: `UPPER_SNAKE_CASE` for true constants, otherwise `camelCase`
- union states: short literals such as `"locked"`, `"unlocking"`, `"error"`

Comments:

- keep comments sparse
- only add comments when code is not already clear from structure and naming

## Error Handling

Use explicit `try`/`catch` around async operations that touch:

- fetch
- IndexedDB
- service worker registration or unregistration
- archive extraction

Normalize unknown errors like this:

```ts
error instanceof Error ? error.message : "Fallback message.";
```

Keep user-facing errors short and direct.

## Service Worker Guidance

Keep the worker focused on:

- `connect`
- `getStatus`
- `setMode`
- fetch interception for stored files

Avoid moving these concerns into the worker unless required:

- archive processing
- MIME lookup libraries
- file write orchestration
- UI progress reporting

The config app should own reset and unlock flows.

## Storage and Reset Guidance

When storing files:

- normalize file paths before saving them
- preserve `mime` on each stored file record
- strip shared root folders in the config app when appropriate

Current reset expectations:

- locking the site should unregister the worker
- locking the site should delete the router database
- reset behavior should be destructive when the UX expects a full lock/reset

## Verification Expectations

For most code changes, run:

```bash
pnpm lint
pnpm build
```

If you cannot run one of them, say so explicitly.

## Agent Behavior

- Prefer the smallest correct change.
- Do not add dependencies unless necessary.
- Do not move complexity into the router worker without a strong reason.
- Keep lazy-loading for heavy archive tooling.
- Preserve the current lock/unlock product language unless the user asks otherwise.
