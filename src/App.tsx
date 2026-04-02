import { useEffect, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  sqlite3Worker1Promiser as sqlite3Worker1PromiserFactory,
  type Worker1Promiser,
} from '@sqlite.org/sqlite-wasm'
import './App.css'

type SqlCell =
  | string
  | number
  | bigint
  | null
  | Uint8Array
  | Int8Array
  | ArrayBuffer

type ResultRow = Record<string, SqlCell>

type ExecutionSummary = {
  changeCount: string | null
  columns: string[]
  elapsedMs: number
  lastInsertRowId: string | null
  rowCount: number
  rows: ResultRow[]
  sql: string
}

type ConnectionState = {
  crossOriginIsolated: boolean
  dbId: string
  filename: string
  persistent: boolean
  version: string
  vfs: string
  vfsList: string[]
}

type WorkerResponseMap = {
  'config-get': {
    result: {
      version: {
        libVersion: string
      }
      vfsList: string[]
    }
  }
  close: {
    result: {
      filename?: string
    }
  }
  exec: {
    result: {
      changeCount?: bigint | number
      lastInsertRowId?: bigint | number
      resultRows?: ResultRow[]
    }
  }
  open: {
    dbId?: string
    result: {
      dbId: string
      filename: string
      persistent: boolean
      vfs: string
    }
  }
}

const DB_URI = 'file:opfs-demo.db?vfs=opfs'

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
    ('Warm OPFS cache', 'ready', 3, 'Confirms the worker-backed database opens from OPFS.'),
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

function normalizeFileName(filename: string) {
  return filename.replace(/^file:/, '').replace(/\?vfs=.*$/, '')
}

function formatMaybeBigInt(value: bigint | number | undefined) {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'number') {
    return String(value)
  }

  return null
}

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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'object' && error !== null && 'result' in error) {
    const result = Reflect.get(error, 'result')

    if (typeof result === 'object' && result !== null && 'message' in result) {
      const message = Reflect.get(result, 'message')

      if (typeof message === 'string') {
        return message
      }
    }
  }

  return String(error)
}

async function createPromiser() {
  return await new Promise<Worker1Promiser>((resolve, reject) => {
    try {
      ;(
        sqlite3Worker1PromiserFactory as unknown as (config: {
          onready: (promiser: Worker1Promiser) => void
        }) => Worker1Promiser
      )({
        onready: resolve,
      })
    } catch (error) {
      reject(error)
    }
  })
}

async function workerMessage(
  promiser: Worker1Promiser,
  type: 'config-get',
): Promise<WorkerResponseMap['config-get']>
async function workerMessage(
  promiser: Worker1Promiser,
  type: 'close',
): Promise<WorkerResponseMap['close']>
async function workerMessage(
  promiser: Worker1Promiser,
  type: 'exec',
  args: Record<string, unknown>,
): Promise<WorkerResponseMap['exec']>
async function workerMessage(
  promiser: Worker1Promiser,
  type: 'open',
  args: Record<string, unknown>,
): Promise<WorkerResponseMap['open']>
async function workerMessage(
  promiser: Worker1Promiser,
  type: 'config-get' | 'close' | 'exec' | 'open',
  args?: Record<string, unknown>,
) {
  return await (
    promiser as unknown as (
      type: 'config-get' | 'close' | 'exec' | 'open',
      args: Record<string, unknown>,
    ) => Promise<WorkerResponseMap[typeof type]>
  )(type, args ?? {})
}

async function executeSql(promiser: Worker1Promiser, sql: string) {
  const startedAt = performance.now()
  const response = await workerMessage(promiser, 'exec', {
    returnValue: 'resultRows',
    resultRows: [],
    rowMode: 'object',
    sql,
  })
  const rows = (response.result.resultRows ?? []) as ResultRow[]
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []

  return {
    changeCount: formatMaybeBigInt(response.result.changeCount),
    columns,
    elapsedMs: performance.now() - startedAt,
    lastInsertRowId: formatMaybeBigInt(response.result.lastInsertRowId),
    rowCount: rows.length,
    rows,
    sql,
  } satisfies ExecutionSummary
}

function App() {
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [execution, setExecution] = useState<ExecutionSummary | null>(null)
  const [isBooting, setIsBooting] = useState(true)
  const [isRunning, setIsRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [promiser, setPromiser] = useState<Worker1Promiser | null>(null)
  const [query, setQuery] = useState(DEFAULT_QUERY)

  const pushLog = (message: string) => {
    const stamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    setLogs((current) => [`${stamp} ${message}`, ...current].slice(0, 8))
  }

  const runQuery = async (sql: string, activePromiser: Worker1Promiser) => {
    setIsRunning(true)
    setErrorMessage(null)
    pushLog(`Running SQL: ${sql.split('\n')[0]?.trim() || 'statement'}`)

    try {
      const summary = await executeSql(activePromiser, sql)
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
    let workerPromiser: Worker1Promiser | null = null

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
      appendLog('Initializing the SQLite worker.')

      try {
        workerPromiser = await createPromiser()

        if (cancelled) {
          return
        }

        setPromiser(() => workerPromiser)

        const config = await workerMessage(workerPromiser, 'config-get')
        const open = await workerMessage(workerPromiser, 'open', {
          filename: DB_URI,
        })

        await workerMessage(workerPromiser, 'exec', {
          sql: BOOTSTRAP_SQL,
        })

        if (cancelled) {
          return
        }

        setConnection({
          crossOriginIsolated: window.crossOriginIsolated,
          dbId:
            typeof Reflect.get(open, 'dbId') === 'string'
              ? (Reflect.get(open, 'dbId') as string)
              : open.result.dbId,
          filename: normalizeFileName(open.result.filename),
          persistent: open.result.persistent,
          version: config.result.version.libVersion,
          vfs: open.result.vfs,
          vfsList: config.result.vfsList,
        })

        appendLog(
          `Opened ${normalizeFileName(open.result.filename)} with ${open.result.vfs}.`,
        )

        setIsRunning(true)
        const initialExecution = await executeSql(workerPromiser, DEFAULT_QUERY)

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

      if (workerPromiser) {
        void workerMessage(workerPromiser, 'close').catch(() => undefined)
      }
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!promiser) {
      return
    }

    await runQuery(query, promiser)
  }

  const handleEditorKeyDown = async (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()

      if (promiser) {
        await runQuery(query, promiser)
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
            A compact query runner for a worker-backed SQLite database stored in
            <code> {normalizeFileName(DB_URI)} </code>
            so data survives page reloads.
          </p>
        </div>
        <div className="meta-grid">
          <article className="meta-card">
            <span className="meta-label">Engine</span>
            <strong>{connection?.version ?? 'Starting...'}</strong>
            <span className="meta-hint">
              {connection
                ? `${connection.vfs} VFS`
                : 'Worker1 promiser boot sequence'}
            </span>
          </article>
          <article className="meta-card">
            <span className="meta-label">Storage</span>
            <strong>{connection?.persistent ? 'Persistent' : 'Pending'}</strong>
            <span className="meta-hint">
              {connection ? connection.filename : 'Waiting for open()'}
            </span>
          </article>
          <article className="meta-card">
            <span className="meta-label">Isolation</span>
            <strong>
              {connection?.crossOriginIsolated ? 'COOP/COEP on' : 'Checking'}
            </strong>
            <span className="meta-hint">
              {connection?.crossOriginIsolated
                ? 'SharedArrayBuffer path is available.'
                : 'Vite serves the required headers in dev and preview.'}
            </span>
          </article>
        </div>
      </section>

      <section className="workspace">
        <section className="panel runner-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Query Runner</p>
              <h2>Run SQL against the OPFS database</h2>
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
                  Current database id: <code>{connection?.dbId ?? 'loading'}</code>
                </span>
              </div>
              <button
                className="primary-button"
                type="submit"
                disabled={!promiser || isBooting || isRunning}
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
              <strong>{execution?.lastInsertRowId ?? 'n/a'}</strong>
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
                  <dt>Primary VFS</dt>
                  <dd>{connection?.vfs ?? '...'}</dd>
                </div>
                <div>
                  <dt>Persistent storage</dt>
                  <dd>{connection?.persistent ? 'yes' : 'not yet'}</dd>
                </div>
                <div>
                  <dt>Known VFS list</dt>
                  <dd>{connection?.vfsList.join(', ') ?? 'Loading...'}</dd>
                </div>
              </dl>
            </section>

            <section className="subpanel">
              <p className="panel-kicker">Notes</p>
              <h2>Why the headers matter</h2>
              <p className="body-copy">
                SQLite&apos;s OPFS path depends on worker-side capabilities gated
                behind cross-origin isolation. The Vite config serves
                <code> Cross-Origin-Opener-Policy: same-origin </code>
                and
                <code> Cross-Origin-Embedder-Policy: require-corp </code>
                in both dev and preview mode.
              </p>
            </section>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App
