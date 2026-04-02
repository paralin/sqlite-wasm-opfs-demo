# SQLite Wasm OPFS Demo

Small Bun + Vite demo showing `@sqlite.org/sqlite-wasm` running in the browser with SQLite persistence backed by OPFS.

## What it does

- Boots SQLite in a dedicated worker via the Worker1 promiser API.
- Opens `file:opfs-demo.db?vfs=opfs` so the database persists across reloads.
- Seeds a tiny sample table on first run.
- Exposes a compact SQL runner UI with result table, timings, and recent activity.

## Requirements

- Bun
- A browser with OPFS support
- Cross-origin isolation headers:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

Those headers are configured in [vite.config.ts](/Users/cjs/repos/sqlite-wasm-opfs-demo/vite.config.ts) for both `dev` and `preview`.

## Run locally

```bash
bun install
bun run dev
```

Then open the local Vite URL in a supported browser.

## Scripts

```bash
bun run dev
bun run build
bun run preview
bun run lint
```

## Project files

- `src/App.tsx`: SQLite worker boot, OPFS database setup, and query runner UI
- `src/App.css`: page-level layout and component styling
- `src/index.css`: global theme and typography
- `vite.config.ts`: COOP/COEP headers and SQLite bundling config
