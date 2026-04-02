import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm'
import type {
  ExecPayload,
  ExecResult,
  InitPayload,
  InitResult,
  ResultRow,
  SqliteFailure,
  SqliteIncoming,
  SqliteResponseMap,
  SqliteSuccess,
  StorageMode,
} from './sqlite-protocol'

type SqliteApi = Awaited<ReturnType<typeof sqlite3InitModule>>

type SyncAccessHandleLike = {
  close: () => unknown
}

type FileHandleWithSyncAccess = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>
}

let activeDb: Database | null = null
let activeFilename: string | null = null
let activeVfs = ''
let sqlite3ApiPromise: Promise<SqliteApi> | null = null
let storageDetail: string | null = null
let storageMode: StorageMode = 'memory'
let sahPoolPromise: Promise<SAHPoolUtil> | null = null
let requestQueue = Promise.resolve()
const connectedPorts = new Set<MessagePort>()

async function collectOpfsDiagnostics() {
  const fileHandlePrototype = globalThis.FileSystemFileHandle
    ?.prototype as { createSyncAccessHandle?: unknown } | undefined
  const lines = [
    'runtime=shared-worker',
    `worker=${typeof self !== 'undefined'}`,
    `isSecureContext=${String(globalThis.isSecureContext ?? false)}`,
    `sharedArrayBuffer=${typeof SharedArrayBuffer !== 'undefined'}`,
    `atomics=${typeof Atomics !== 'undefined'}`,
    `crossOriginIsolated=${String(globalThis.crossOriginIsolated ?? false)}`,
    `navigator.storage=${typeof navigator !== 'undefined' && !!navigator.storage}`,
    `navigator.storage.getDirectory=${typeof navigator?.storage?.getDirectory === 'function'}`,
    `FileSystemHandle=${typeof globalThis.FileSystemHandle !== 'undefined'}`,
    `FileSystemDirectoryHandle=${typeof globalThis.FileSystemDirectoryHandle !== 'undefined'}`,
    `FileSystemFileHandle=${typeof globalThis.FileSystemFileHandle !== 'undefined'}`,
    `createSyncAccessHandle=${typeof fileHandlePrototype?.createSyncAccessHandle === 'function'}`,
    `connectedClients=${connectedPorts.size}`,
  ]

  if (typeof navigator?.userAgent === 'string') {
    lines.push(`userAgent=${navigator.userAgent}`)
  }

  try {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory()
      lines.push(`root.getFileHandle=${typeof root.getFileHandle === 'function'}`)
      lines.push(`root.removeEntry=${typeof root.removeEntry === 'function'}`)
      const file = (await root.getFileHandle('.opfs-capability-probe', {
        create: true,
      })) as FileHandleWithSyncAccess
      lines.push(`file.createSyncAccessHandle=${typeof file.createSyncAccessHandle === 'function'}`)

      if (typeof file.createSyncAccessHandle === 'function') {
        const handle = await file.createSyncAccessHandle()
        const closeResult = handle.close()
        lines.push(
          `syncHandle.closeIsPromise=${String(
            typeof closeResult === 'object' &&
              closeResult !== null &&
              'then' in closeResult,
          )}`,
        )
      }

      if (typeof root.removeEntry === 'function') {
        await root.removeEntry('.opfs-capability-probe').catch(() => undefined)
      }
    }
  } catch (error) {
    lines.push(`probeError=${getErrorMessage(error)}`)
  }

  return lines
}

async function normalizeMissingOpfsGlobals() {
  if (typeof navigator?.storage?.getDirectory !== 'function') {
    return
  }

  const root = await navigator.storage.getDirectory()
  const file = (await root.getFileHandle('.opfs-global-probe', {
    create: true,
  })) as FileHandleWithSyncAccess
  const rootCtor = Object.getPrototypeOf(root)?.constructor
  const fileCtor = Object.getPrototypeOf(file)?.constructor
  const handleCtor = Object.getPrototypeOf(Object.getPrototypeOf(root))?.constructor

  if (!globalThis.FileSystemDirectoryHandle && rootCtor) {
    globalThis.FileSystemDirectoryHandle = rootCtor as typeof FileSystemDirectoryHandle
  }

  if (!globalThis.FileSystemFileHandle && fileCtor) {
    globalThis.FileSystemFileHandle = fileCtor as typeof FileSystemFileHandle
  }

  if (!globalThis.FileSystemHandle && handleCtor) {
    globalThis.FileSystemHandle = handleCtor as typeof FileSystemHandle
  }

  if (typeof root.removeEntry === 'function') {
    await root.removeEntry('.opfs-global-probe').catch(() => undefined)
  }
}

function toSahPoolPath(filename: string) {
  return filename.startsWith('/') ? filename : `/${filename}`
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function getSqliteApi() {
  sqlite3ApiPromise ??= sqlite3InitModule()
  return sqlite3ApiPromise
}

async function getSahPool(sqlite3: SqliteApi) {
  sahPoolPromise ??= sqlite3.installOpfsSAHPoolVfs({})
  return await sahPoolPromise
}

function closeDatabase() {
  if (!activeDb) {
    return false
  }

  activeDb.close()
  activeDb = null
  activeFilename = null
  return true
}

async function initializeDatabase({
  bootstrapSql,
  filename,
}: InitPayload): Promise<InitResult> {
  const sqlite3 = await getSqliteApi()
  const diagnostics = await collectOpfsDiagnostics()

  if (!activeDb || activeFilename !== filename) {
    closeDatabase()

    const hasOpfsVfs = Boolean(sqlite3.capi.sqlite3_vfs_find('opfs'))
    storageDetail = null

    if (hasOpfsVfs) {
      activeVfs = 'opfs'
      storageMode = 'opfs'
      activeDb = new sqlite3.oo1.DB({
        filename,
        flags: 'ct',
        vfs: activeVfs,
      })
    } else {
      try {
        await normalizeMissingOpfsGlobals().catch((error) => {
          diagnostics.push(`normalizeGlobalsError=${getErrorMessage(error)}`)
        })
        diagnostics.push(
          ...(await collectOpfsDiagnostics()).map((line) => `postNormalize:${line}`),
        )
        const poolUtil = await getSahPool(sqlite3)
        activeVfs = 'opfs-sahpool'
        storageMode = 'opfs-sahpool'
        storageDetail =
          'SharedArrayBuffer-backed OPFS was unavailable, so the shared worker installed SQLite’s OPFS SAH pool VFS instead.'
        activeDb = new poolUtil.OpfsSAHPoolDb(toSahPoolPath(filename))
      } catch (error) {
        activeVfs = 'memdb'
        storageMode = 'memory'
        storageDetail =
          'Both OPFS VFS options were unavailable. Falling back to an in-memory database for this session. ' +
          getErrorMessage(error)
        diagnostics.push(`sahpoolError=${getErrorMessage(error)}`)
        activeDb = new sqlite3.oo1.DB(':memory:', 'ct')
      }
    }

    activeFilename = filename
  } else {
    diagnostics.push('reusedExistingConnection=true')
  }

  activeDb.exec(bootstrapSql)

  return {
    connectedClients: connectedPorts.size,
    diagnostics,
    filename: activeDb.filename,
    persistent: storageMode !== 'memory',
    runtime: 'shared-worker',
    storageDetail,
    storageMode,
    version: sqlite3.version.libVersion,
    vfs: activeDb.dbVfsName() ?? activeVfs,
    vfsList: sqlite3.capi.sqlite3_js_vfs_list(),
  }
}

async function executeSql({ sql }: ExecPayload): Promise<ExecResult> {
  if (!activeDb) {
    throw new Error('Database is not initialized.')
  }

  const sqlite3 = await getSqliteApi()
  const startedAt = performance.now()
  const rows = activeDb.exec({
    returnValue: 'resultRows',
    resultRows: [],
    rowMode: 'object',
    sql,
  }) as ResultRow[]

  return {
    changeCount: activeDb.changes(false),
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    elapsedMs: performance.now() - startedAt,
    lastInsertRowId: activeDb.pointer
      ? sqlite3.capi.sqlite3_last_insert_rowid(activeDb)
      : null,
    rowCount: rows.length,
    rows,
  }
}

function enqueueRequest<T>(work: () => Promise<T>) {
  const queued = requestQueue.then(work, work)
  requestQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

function disconnectPort(port: MessagePort) {
  const deleted = connectedPorts.delete(port)

  if (connectedPorts.size === 0) {
    closeDatabase()
  }

  return deleted
}

async function handleMessage(
  message: SqliteIncoming,
  port: MessagePort,
): Promise<SqliteResponseMap[keyof SqliteResponseMap]> {
  switch (message.type) {
    case 'init':
      return await initializeDatabase(message.payload)
    case 'exec':
      return await executeSql(message.payload)
    case 'close':
      return {
        closed: closeDatabase(),
      }
    case 'disconnect':
      return {
        disconnected: disconnectPort(port),
      }
  }
}

globalThis.addEventListener('connect', (event: Event) => {
  const connectEvent = event as MessageEvent
  const [port] = connectEvent.ports

  if (!port) {
    return
  }

  connectedPorts.add(port)
  port.start()
  port.addEventListener('message', (messageEvent: MessageEvent<SqliteIncoming>) => {
    const message = messageEvent.data

    void enqueueRequest(() => handleMessage(message, port))
      .then((result) => {
        port.postMessage({
          id: message.id,
          result,
          success: true,
        } satisfies SqliteSuccess<keyof SqliteResponseMap>)

        if (message.type === 'disconnect') {
          port.close()
        }
      })
      .catch((error) => {
        port.postMessage({
          error: getErrorMessage(error),
          id: message.id,
          success: false,
        } satisfies SqliteFailure)
      })
  })
})
