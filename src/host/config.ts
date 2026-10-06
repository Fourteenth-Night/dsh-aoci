// 设置 schema（schemastery v3；设计文档 4.9）
import Schema from 'schemastery'

export const DbSourceSchema = Schema.object({
  sourceId: Schema.string().required().description('数据源 ID，例如 primary'),
  engine: Schema.union(['mysql', 'postgresql', 'opengauss']).default('postgresql'),
  databaseName: Schema.string(),
  namespace: Schema.string().default('public'),
  credentialEnv: Schema.string().description('凭据引用环境变量名；缺省派生 AOCI_DB_<ID>_DSN'),
})

export const ProjectSchema = Schema.object({
  root: Schema.string().required().description('Git 仓库根绝对路径'),
  slug: Schema.string().description('缺省取目录名'),
  enabled: Schema.boolean().default(true),
  locale: Schema.string().default('en-US'),
  schedule: Schema.object({
    cron: Schema.string().default('0 3 * * *').description('5 段 cron，如 0 3 * * *'),
    verifyOnly: Schema.boolean().default(true).description('夜间只跑 verify/check，不自动烧 API 额度'),
  }).default({ cron: '0 3 * * *', verifyOnly: true }),
  dbSources: Schema.array(DbSourceSchema).default([]),
  chunkTokens: Schema.number().min(4000).max(24000).default(7000),
  maintainBudgetBytes: Schema.number().default(24576),
})

export const AociConfigSchema = Schema.object({
  defaultRoot: Schema.string().default('').description('相对路径解析基准目录；空表示 aoci_use 需绝对路径'),
  binaryPath: Schema.string().default('C:/aoci/bin/aoci.exe').description('aoci 稳定绝对路径（不捆绑，需从官方 Release 获取并校验；可留空启用自动探测）'),
  binaryAutoDetect: Schema.boolean().default(true).description('未配置 binaryPath 时自动探测常见目录与 PATH 中的 aoci 二进制'),
  autoInstallOnFirstUse: Schema.boolean().default(true),
  mcp: Schema.object({
    serverNamePrefix: Schema.string().default('aoci'),
    toolCallTimeoutMs: Schema.number().default(120000),
    failOnStartupError: Schema.boolean().default(false),
  }).default({ serverNamePrefix: 'aoci', toolCallTimeoutMs: 120000, failOnStartupError: false }),
  projects: Schema.array(ProjectSchema).default([]),
})

export interface DbSourceConfig {
  sourceId: string
  engine: 'mysql' | 'postgresql' | 'opengauss'
  databaseName?: string
  namespace?: string
  credentialEnv?: string
}

export interface ProjectConfigMin {
  root: string
  slug?: string
  enabled?: boolean
  locale?: string
  schedule?: { cron?: string; verifyOnly?: boolean }
  dbSources?: DbSourceConfig[]
  chunkTokens?: number
  maintainBudgetBytes?: number
}

export interface AociConfig {
  defaultRoot?: string
  binaryPath: string
  binaryAutoDetect?: boolean
  autoInstallOnFirstUse: boolean
  mcp: { serverNamePrefix: string; toolCallTimeoutMs: number; failOnStartupError: boolean }
  projects: ProjectConfigMin[]
}