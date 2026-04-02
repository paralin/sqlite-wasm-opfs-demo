export type SqlCell =
  | string
  | number
  | bigint
  | null
  | Uint8Array
  | Int8Array
  | ArrayBuffer

export type ResultRow = Record<string, SqlCell>

export type StorageMode = 'memory' | 'opfs' | 'opfs-sahpool'

export type RuntimeMode = 'shared-worker'

export type InitPayload = {
  bootstrapSql: string
  filename: string
}

export type InitResult = {
  connectedClients: number
  diagnostics: string[]
  filename: string
  persistent: boolean
  runtime: RuntimeMode
  storageDetail: string | null
  storageMode: StorageMode
  version: string
  vfs: string
  vfsList: string[]
}

export type ExecPayload = {
  sql: string
}

export type ExecResult = {
  changeCount: number
  columns: string[]
  elapsedMs: number
  lastInsertRowId: bigint | null
  rowCount: number
  rows: ResultRow[]
}

export type SqliteRequestMap = {
  close: Record<string, never>
  disconnect: Record<string, never>
  exec: ExecPayload
  init: InitPayload
}

export type SqliteResponseMap = {
  close: {
    closed: boolean
  }
  disconnect: {
    disconnected: boolean
  }
  exec: ExecResult
  init: InitResult
}

export type SqliteRequest<K extends keyof SqliteRequestMap> = {
  id: number
  payload: SqliteRequestMap[K]
  type: K
}

export type SqliteSuccess<K extends keyof SqliteResponseMap> = {
  id: number
  result: SqliteResponseMap[K]
  success: true
}

export type SqliteFailure = {
  error: string
  id: number
  success: false
}

export type SqliteIncoming =
  | SqliteRequest<'close'>
  | SqliteRequest<'disconnect'>
  | SqliteRequest<'exec'>
  | SqliteRequest<'init'>
