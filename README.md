# SQLite Wasm OPFS Demo

Small Bun + Vite demo showing `@sqlite.org/sqlite-wasm` running in the browser with SQLite persistence backed by OPFS.

## What it does

- Boots SQLite inside a `SharedWorker`.
- Reuses one SQLite runtime across tabs from the same origin while they remain open.
- Prefers SQLite's standard `opfs` VFS when it is available.
- Falls back to SQLite's `opfs-sahpool` VFS when `SharedArrayBuffer` is unavailable, which keeps OPFS persistence working on browsers like Chrome Mobile for Android.
- Seeds a small sample table and exposes a compact SQL runner UI with result rows, timings, and recent activity.

## SharedWorker implications

Moving SQLite from a dedicated `Worker` into a `SharedWorker` changes the operational model in a few important ways:

- The browser must support `SharedWorker`. This demo now reports an initialization error instead of silently falling back to a dedicated worker when that API is missing.
- All tabs on the same origin talk to the same SQLite connection. That is useful for cache reuse and shared state, but one tab can now affect another tab's live session.
- Requests are serialized through one queue inside the shared worker. This avoids concurrent access to a single SQLite connection, but it also means a long-running statement in one tab blocks work from the others.
- The worker keeps exactly one active database handle for this app. Re-initializing with a different filename would repoint the shared runtime for every connected tab.
- Per-tab teardown must only disconnect that tab's `MessagePort`. Closing the SQLite connection on unmount would otherwise disrupt every connected client.

## OPFS fallback details

SQLite documents two distinct OPFS-backed VFS options:

- `opfs`
  - Worker-only.
  - Activated automatically when the browser has the required APIs.
  - Can be detected with `sqlite3.capi.sqlite3_vfs_find("opfs")` or `sqlite3.oo1.OpfsDb`.
  - Requires `SharedArrayBuffer`, which in practice means cross-origin isolation via COOP/COEP headers.
- `opfs-sahpool`
  - Also OPFS-backed and worker-only.
  - Does **not** require COOP/COEP headers.
  - Must be installed explicitly with `await sqlite3.installOpfsSAHPoolVfs()`.
  - Database names for this VFS must use absolute paths like `'/opfs-demo.db'`.
  - Trades away some concurrency/filesystem transparency, but still provides OPFS persistence.

This demo now does exactly that:

1. Initialize SQLite in a shared worker.
2. Check whether the standard `opfs` VFS is registered.
3. Use `opfs` when present.
4. Otherwise install `opfs-sahpool` and open the database with that VFS.
5. Fall back to `:memory:` only if both OPFS-backed modes fail.

## Official SQLite references

- Persistent storage overview:
  - https://sqlite.org/wasm/doc/trunk/persistence.md
- Worker1/promiser API background:
  - https://sqlite.org/wasm/doc/trunk/api-worker1.md
- OO1 API docs including `OpfsDb`:
  - https://sqlite.org/wasm/doc/trunk/api-oo1.md

Key sections from the persistence docs relevant to this repo:

- `opfs` requires `SharedArrayBuffer` and therefore COOP/COEP:
  - https://sqlite.org/wasm/doc/trunk/persistence.md#coop-coep-http-headers
- `opfs-sahpool` does not require COOP/COEP:
  - https://sqlite.org/wasm/doc/trunk/persistence.md#opfs-syncaccesshandle-pool-vfs

## Requirements

- Bun
- A browser with SQLite WASM support
- For the preferred `opfs` mode:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

Those headers are configured in `vite.config.ts` for both `dev` and `preview`. Browsers that cannot use the regular `opfs` VFS can still persist through the `opfs-sahpool` fallback.

## Run locally

```bash
bun install
bun run dev
```

Then open the local Vite URL in a supported browser.

## Testing On Android

When testing on an Android device over USB, do not load the Vite dev server from a plain LAN IP like `http://192.168.x.x:5173`. In that setup the page may not be treated as a secure/trustworthy context, which can leave OPFS APIs unavailable in the shared worker.

Instead, use `adb reverse` and open the app on the phone via `127.0.0.1`:

```bash
adb reverse tcp:5173 tcp:5173
```

Then open:

```text
http://127.0.0.1:5173
```

This is the recommended way to test the OPFS and `opfs-sahpool` paths on a USB-connected Android device during development.

## Scripts

```bash
bun run dev
bun run build
bun run preview
bun run lint
```

## Project files

- `src/App.tsx`: UI and shared worker client wiring
- `src/sqlite-protocol.ts`: request/response types shared by the UI and worker
- `src/sqlite-shared-worker.ts`: shared worker boot, VFS selection, and SQL execution
- `src/App.css`: page-level layout and component styling
- `src/index.css`: global theme and typography
- `vite.config.ts`: Vite config and COOP/COEP headers
