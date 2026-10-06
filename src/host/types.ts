// dsh-aoci 共享类型：项目配置、MCP 条目、TaskRun 证据（对齐设计文档第 5 章数据模型）
export type DbEngine = 'mysql' | 'postgresql' | 'opengauss'

export interface DbSource {
  sourceId: string
  engine: DbEngine
  databaseName?: string
  namespace?: string
  /** 默认派生 AOCI_DB_<大写 sourceId>_DSN；AOCI 只保存引用名，绝不保存密钥值 */
  credentialEnv?: string
}

export interface ProjectConfig {
  /** 仓库根绝对路径（Git 仓库） */
  root: string
  /** 缺省取目录名；[a-z0-9-] */
  slug?: string
  enabled?: boolean
  locale?: string
  schedule?: { cron?: string; verifyOnly?: boolean }
  dbSources?: DbSource[]
  /** overview_delivery.chunk_tokens，4000–24000，默认 7000 */
  chunkTokens?: number
  /** maintain_transport_budget_bytes，默认 24576 */
  maintainBudgetBytes?: number
}

export type Transport = 'stdio' | 'streamable-http'

export interface McpEntry {
  id: string
  name: '@deepseek-ai/dsh-mcp-client'
  config: {
    serverName: string
    transport: 'stdio'
    command: string
    args: string[]
    env?: Record<string, string>
    toolCallTimeoutMs: number
    failOnStartupError: boolean
    reconnect?: { enabled?: boolean }
  }
}

export type RunKind = 'index_build' | 'maintain' | 'verify' | 'check' | 'scan' | 'db_bootstrap'
export type RunState = 'running' | 'completed' | 'failed' | 'killed'

export interface TaskRun {
  ts: string
  kind: RunKind
  project: string
  state: RunState
  sessionId?: string
  indexSha?: string
  entries?: number
  exitCode?: number
  evidence?: string
  apiTokens?: number
  message?: string
}

export interface ProjectRecord {
  slug: string
  root: string
  binaryPath: string
  aociVersion?: string
  mcp: { serverName: string; connected: boolean; tools: number }
  index: {
    layout: 'volumes-v1' | 'legacy'
    baseline: { established: boolean; baselineSha?: string }
    aligned: boolean
    entries: number
    indexSha?: string
    lastOverviewAt?: string
  }
  database: {
    enabled: boolean
    sources: Array<DbSource & { accessPreflight?: 'ok' | 'missing-ref' | 'error'; evidenceHash?: string }>
  }
  schedule: { cron: string; verifyOnly: boolean }
  createdAt: string
  updatedAt: string
}

export const AOCI_TOOLS = [
  'aoci_rules', 'aoci_overview', 'aoci_get_entries', 'aoci_search',
  'aoci_maintain', 'aoci_update_entry', 'aoci_remove_entry',
  'aoci_header', 'aoci_report',
] as const

export const AOCI_MANAGED_ASSETS = [
  'aoci.txt', 'aoci.meta.txt', 'aoci.code.txt', 'aoci.database.txt', 'AGENTS.md',
] as const
