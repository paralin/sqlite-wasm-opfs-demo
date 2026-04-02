import { useEffect, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import './App.css'
import type {
  ExecPayload,
  ExecResult,
  InitPayload,
  InitResult,
  SqlCell,
  SqliteFailure,
  SqliteRequest,
  SqliteRequestMap,
  SqliteResponseMap,
  SqliteSuccess,
  StorageMode,
} from './sqlite-protocol'

type ConnectionState = InitResult & {
  crossOriginIsolated: boolean
}

type ExecutionSummary = ExecResult & {
  sql: string
}

type SqliteWorkerClient = {
  close: () => Promise<SqliteResponseMap['close']>
  disconnect: () => Promise<SqliteResponseMap['disconnect']>
  exec: (payload: ExecPayload) => Promise<ExecResult>
  init: (payload: InitPayload) => Promise<InitResult>
  terminate: () => void
}

const DB_FILENAME = 'opfs-demo.db'

const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS demo_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO demo_tasks (title, status, priority, details) VALUES
    ('Warm OPFS cache', 'ready', 3, 'Confirms the shared-worker-backed database opens from OPFS.'),
    ('Inspect persistence', 'active', 5, 'Reload the page and the table stays put.'),
    ('Run ad hoc SQL', 'queued', 2, 'Use the editor below to query or mutate the database.');
`

const DEFAULT_QUERY = `
  SELECT id, title, status, priority, created_at
  FROM demo_tasks
  ORDER BY priority DESC, id ASC;
`.trim()

const EXAMPLES = [
  {
    label: 'Browse tasks',
    sql: DEFAULT_QUERY,
  },
  {
    label: 'Insert sample row',
    sql: `
      INSERT INTO demo_tasks (title, status, priority, details)
      VALUES (
        'Ship GitHub-ready demo @ ' || strftime('%H:%M:%f', 'now'),
        'active',
        4,
        'Added from the SQL runner.'
      );
    `.trim(),
  },
  {
    label: 'Status summary',
    sql: `
      SELECT status, COUNT(*) AS total, ROUND(AVG(priority), 2) AS avg_priority
      FROM demo_tasks
      GROUP BY status
      ORDER BY total DESC, status ASC;
    `.trim(),
  },
]

function formatCell(value: SqlCell) {
  if (value === null) {
    return 'NULL'
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (value instanceof Uint8Array || value instanceof Int8Array) {
    return `[${value.byteLength} byte blob]`
  }

  if (value instanceof ArrayBuffer) {
    return `[${value.byteLength} byte blob]`
  }

  return String(value)
}

function formatStorageMode(mode: StorageMode) {
  switch (mode) {
    case 'opfs':
      return 'OPFS'
    case 'opfs-sahpool':
      return 'OPFS SAH pool'
    case 'memory':
      return 'Memory'
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function createSqliteWorkerClient(): SqliteWorkerClient {
  if (typeof SharedWorker === 'undefined') {
    throw new Error(
      'SharedWorker is unavailable in this browser, so the shared SQLite runtime cannot start.',
    )
  }

  const worker = new SharedWorker(
    new URL('./sqlite-shared-worker.ts', import.meta.url),
    {
      name: 'sqlite-opfs-shared-worker',
      type: 'module',
    },
  )
  const { port } = worker
  port.start()
  let isTerminated = false
  let nextId = 1
  const pending = new Map<
    number,
    {
      reject: (error: Error) => void
      resolve: (value: unknown) => void
    }
  >()

  const rejectAll = (message: string) => {
    for (const { reject } of pending.values()) {
      reject(new Error(message))
    }

    pending.clear()
  }

  port.addEventListener('message', (event) => {
    const message = event.data as
      | SqliteSuccess<keyof SqliteResponseMap>
      | SqliteFailure
    const current = pending.get(message.id)

    if (!current) {
      return
    }

    pending.delete(message.id)

    if (message.success) {
      current.resolve(message.result)
      return
    }

    current.reject(new Error(message.error))
  })

  port.addEventListener('messageerror', () => {
    rejectAll('Shared SQLite worker emitted an unreadable message.')
  })

  const request = <K extends keyof SqliteRequestMap>(
    type: K,
    payload: SqliteRequestMap[K],
  ) =>
    new Promise<SqliteResponseMap[K]>((resolve, reject) => {
      if (isTerminated) {
        reject(new Error('SQLite shared worker connection is closed.'))
        return
      }

      const id = nextId++

      pending.set(id, {
        reject,
        resolve: (value) => resolve(value as SqliteResponseMap[K]),
      })

      port.postMessage({
        id,
        payload,
        type,
      } satisfies SqliteRequest<K>)
    })

  return {
    close: () => request('close', {}),
    disconnect: () => request('disconnect', {}),
    exec: (payload) => request('exec', payload),
    init: (payload) => request('init', payload),
    terminate: () => {
      if (isTerminated) {
        return
      }

      port.postMessage({
        id: -1,
        payload: {},
        type: 'disconnect',
      } satisfies SqliteRequest<'disconnect'>)
      rejectAll('SQLite shared worker connection closed.')
      isTerminated = true
      port.close()
    },
  }
}

async function executeSql(client: SqliteWorkerClient, sql: string) {
  const result = await client.exec({ sql })

  return {
    ...result,
    sql,
  } satisfies ExecutionSummary
}

function App() {
  const [client, setClient] = useState<SqliteWorkerClient | null>(null)
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [execution, setExecution] = useState<ExecutionSummary | null>(null)
  const [isBooting, setIsBooting] = useState(true)
  const [isRunning, setIsRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [query, setQuery] = useState(DEFAULT_QUERY)

  const pushLog = (message: string) => {
    const stamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    setLogs((current) => [`${stamp} ${message}`, ...current].slice(0, 8))
  }

  const runQuery = async (sql: string, activeClient: SqliteWorkerClient) => {
    setIsRunning(true)
    setErrorMessage(null)
    pushLog(`Running SQL: ${sql.split('\n')[0]?.trim() || 'statement'}`)

    try {
      const summary = await executeSql(activeClient, sql)
      setExecution(summary)
      pushLog(
        `Completed in ${summary.elapsedMs.toFixed(1)} ms with ${summary.rowCount} row${summary.rowCount === 1 ? '' : 's'}.`,
      )
    } catch (error) {
      const message = getErrorMessage(error)
      setErrorMessage(message)
      pushLog(`SQLite returned an error: ${message}`)
    } finally {
      setIsRunning(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let nextClient: SqliteWorkerClient | null = null

    const appendLog = (message: string) => {
      const stamp = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })

      setLogs((current) => [`${stamp} ${message}`, ...current].slice(0, 8))
    }

    const boot = async () => {
      setIsBooting(true)
      appendLog('Initializing the shared SQLite worker.')

      try {
        nextClient = createSqliteWorkerClient()
        const init = await nextClient.init({
          bootstrapSql: BOOTSTRAP_SQL,
          filename: DB_FILENAME,
        })

        if (cancelled) {
          return
        }

        setClient(nextClient)
        setConnection({
          ...init,
          crossOriginIsolated: window.crossOriginIsolated,
        })

        appendLog(
          `Opened ${init.filename} in the shared worker using ${formatStorageMode(init.storageMode)} (${init.vfs}).`,
        )

        setIsRunning(true)
        const initialExecution = await executeSql(nextClient, DEFAULT_QUERY)

        if (cancelled) {
          return
        }

        setExecution(initialExecution)
        appendLog(
          `Completed in ${initialExecution.elapsedMs.toFixed(1)} ms with ${initialExecution.rowCount} row${initialExecution.rowCount === 1 ? '' : 's'}.`,
        )
      } catch (error) {
        if (cancelled) {
          return
        }

        const message = getErrorMessage(error)
        setErrorMessage(message)
        appendLog(`Initialization failed: ${message}`)
      } finally {
        if (!cancelled) {
          setIsRunning(false)
          setIsBooting(false)
        }
      }
    }

    void boot()

    return () => {
      cancelled = true
      nextClient?.terminate()
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!client) {
      return
    }

    await runQuery(query, client)
  }

  const handleEditorKeyDown = async (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()

      if (client) {
        await runQuery(query, client)
      }
    }
  }

  return (
    <main className="shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">SQLite Wasm + OPFS</p>
          <h1>Browser-persisted SQL on top of Origin Private File System</h1>
          <p className="lede">
            A compact query runner for a shared-worker-backed SQLite database
            stored in
            <code> {DB_FILENAME} </code>
            so data survives page reloads, with automatic fallback to the OPFS
            SAH pool on browsers without `SharedArrayBuffer`, while reusing one
            SQLite runtime across tabs.
          </p>
        </div>
        <div className="meta-grid">
          <article className="meta-card">
            <span className="meta-label">Engine</span>
            <strong>{connection?.version ?? 'Starting...'}</strong>
            <span className="meta-hint">
              {connection ? `${connection.vfs} VFS` : 'Shared worker boot sequence'}
            </span>
          </article>
          <article className="meta-card">
            <span className="meta-label">Storage</span>
            <strong>
              {connection ? formatStorageMode(connection.storageMode) : 'Pending'}
            </strong>
            <span className="meta-hint">
              {connection?.persistent
                ? `${connection.filename} persists across reloads`
                : 'In-memory fallback'}
            </span>
          </article>
          <article className="meta-card">
            <span className="meta-label">Isolation</span>
            <strong>
              {connection?.crossOriginIsolated ? 'COOP/COEP on' : 'Fallback-safe'}
            </strong>
            <span className="meta-hint">
              {connection?.crossOriginIsolated
                ? 'Regular OPFS path can use SharedArrayBuffer.'
                : 'SAH pool can still keep OPFS persistence.'}
            </span>
          </article>
        </div>
      </section>

      <section className="workspace">
        <section className="panel runner-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Query Runner</p>
              <h2>Run SQL against the persistent database</h2>
            </div>
            <div className="panel-actions">
              {EXAMPLES.map((example) => (
                <button
                  key={example.label}
                  className="ghost-button"
                  type="button"
                  onClick={() => setQuery(example.sql)}
                >
                  {example.label}
                </button>
              ))}
            </div>
          </div>

          <form className="runner-form" onSubmit={handleSubmit}>
            <textarea
              aria-label="SQL editor"
              className="sql-editor"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => void handleEditorKeyDown(event)}
              spellCheck={false}
            />

            <div className="toolbar">
              <div className="toolbar-copy">
                <span>Run with Ctrl/Cmd + Enter.</span>
                <span>
                  Mode: <code>{connection ? formatStorageMode(connection.storageMode) : 'loading'}</code>
                </span>
              </div>
              <button
                className="primary-button"
                type="submit"
                disabled={!client || isBooting || isRunning}
              >
                {isBooting ? 'Starting...' : isRunning ? 'Running...' : 'Run SQL'}
              </button>
            </div>
          </form>

          {errorMessage ? (
            <div className="error-banner">
              <strong>SQLite error</strong>
              <p>{errorMessage}</p>
            </div>
          ) : null}

          <div className="result-bar">
            <div>
              <span className="result-label">Rows</span>
              <strong>{execution?.rowCount ?? 0}</strong>
            </div>
            <div>
              <span className="result-label">Elapsed</span>
              <strong>
                {execution ? `${execution.elapsedMs.toFixed(1)} ms` : '...'}
              </strong>
            </div>
            <div>
              <span className="result-label">Changes</span>
              <strong>{execution?.changeCount ?? '0'}</strong>
            </div>
            <div>
              <span className="result-label">Last insert rowid</span>
              <strong>
                {execution?.lastInsertRowId != null
                  ? execution.lastInsertRowId.toString()
                  : 'n/a'}
              </strong>
            </div>
          </div>

          <div className="table-wrap">
            {execution?.rows.length ? (
              <table>
                <thead>
                  <tr>
                    {execution.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {execution.rows.map((row, rowIndex) => (
                    <tr key={`${rowIndex}-${execution.sql.length}`}>
                      {execution.columns.map((column) => (
                        <td key={`${rowIndex}-${column}`}>
                          {formatCell(row[column] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">
                <p>No result rows for the last statement.</p>
                <span>
                  DDL and write statements still report timing, change count, and
                  last insert rowid above.
                </span>
              </div>
            )}
          </div>

          <section className="subpanel activity-card">
            <div className="subpanel-head">
              <div>
                <p className="panel-kicker">Activity</p>
                <h2>Recent events</h2>
              </div>
            </div>
            <ul className="log-list">
              {logs.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </section>
        </section>

        <aside className="panel side-panel">
          <div className="stack">
            <section className="subpanel">
              <p className="panel-kicker">Connection</p>
              <h2>Runtime details</h2>
              <dl className="details-list">
                <div>
                  <dt>Database file</dt>
                  <dd>{connection?.filename ?? 'Opening...'}</dd>
                </div>
                <div>
                  <dt>Selected VFS</dt>
                  <dd>{connection?.vfs ?? '...'}</dd>
                </div>
                <div>
                  <dt>Storage mode</dt>
                  <dd>
                    {connection
                      ? formatStorageMode(connection.storageMode)
                      : 'Starting...'}
                  </dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{connection?.runtime ?? 'Starting...'}</dd>
                </div>
                <div>
                  <dt>Connected clients</dt>
                  <dd>{connection?.connectedClients ?? '...'}</dd>
                </div>
                <div>
                  <dt>Known VFS list</dt>
                  <dd>{connection?.vfsList.join(', ') ?? 'Loading...'}</dd>
                </div>
              </dl>
            </section>

            <section className="subpanel">
              <p className="panel-kicker">Fallback</p>
              <h2>Persistence behavior</h2>
              <p className="body-copy">
                The shared worker prefers the standard
                <code> opfs </code>
                VFS when available. If that VFS is missing, it attempts to
                install and use
                <code> opfs-sahpool </code>
                so OPFS persistence still works on browsers that do not expose
                `SharedArrayBuffer`.
              </p>
              <p className="body-copy">
                All tabs connected to this origin share one SQLite connection,
                so initialization and query execution are funneled through a
                single worker queue.
              </p>
              {connection?.storageDetail ? (
                <p className="body-copy">{connection.storageDetail}</p>
              ) : null}
            </section>

            <section className="subpanel">
              <p className="panel-kicker">Diagnostics</p>
              <h2>Shared worker capability report</h2>
              <ul className="log-list">
                {(connection?.diagnostics ?? ['Loading shared worker diagnostics...']).map(
                  (entry) => (
                    <li key={entry}>{entry}</li>
                  ),
                )}
              </ul>
            </section>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App
