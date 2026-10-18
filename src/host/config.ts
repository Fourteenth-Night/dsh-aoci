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

export const GovernanceSchema = Schema.union(['strict', 'standard', 'relaxed']).default('standard')
  .description('治理分级：strict 强制每次维护后 verify；standard 按需；relaxed 仅提示')
export const ToolSurfaceSchema = Schema.union(['compact', 'full']).default('compact')
  .description('模型可见工具面：compact 聚合入口（省 token）；full 全量工具')
export const AutoRefreshSchema = Schema.union(['off', 'status', 'nightly']).default('status')
  .description('增量刷新：off 关闭；status 仅状态提示漂移；nightly 夜间自动 verify')

export const AociConfigSchema = Schema.object({
  defaultRoot: Schema.string().default('').description('相对路径解析基准目录；空表示 aoci_use 需绝对路径'),
  binaryPath: Schema.string().default('C:/aoci/bin/aoci.exe').description('aoci 稳定绝对路径（不捆绑，需从官方 Release 获取并校验；可留空启用自动探测）'),
  binaryAutoDetect: Schema.boolean().default(true).description('未配置 binaryPath 时自动探测常见目录与 PATH 中的 aoci 二进制'),
  binarySha256: Schema.string().default('').description('可选：期望的 aoci 二进制 SHA-256（hex，大小写不敏感）；配置后不匹配则拒绝使用'),
  minAociVersion: Schema.string().default('0.1.0-rc18').description('最低 aoci 版本（如 0.1.0-rc21）；低于该版本拒绝绑定并提示升级'),
  envPassthrough: Schema.array(Schema.string()).default([]).description('额外允许透传给 aoci 子进程的环境变量名（默认仅 PATH/系统变量与 AOCI_DB_*）'),
  toolSurface: ToolSurfaceSchema,
  autoRefresh: AutoRefreshSchema,
  governance: GovernanceSchema,
  readOnly: Schema.boolean().default(false).description('只读模式：不执行 init/scan/maintain，不写 state/aoci 之外的资产'),
  httpRoutes: Schema.boolean().default(false).description('是否挂载 /aoci/api 只读面板路由（默认关闭）'),
  budget: Schema.object({
    warn: Schema.number().min(0).max(1).default(0.6).description('上下文压力提示阈值'),
    fold: Schema.number().min(0).max(1).default(0.75).description('主动折叠 AOCI 大结果阈值'),
    compact: Schema.number().min(0).max(1).default(0.9).description('建议压缩阈值'),
  }).default({ warn: 0.6, fold: 0.75, compact: 0.9 }),
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
  binarySha256?: string
  minAociVersion?: string
  envPassthrough?: string[]
  toolSurface?: 'compact' | 'full'
  autoRefresh?: 'off' | 'status' | 'nightly'
  governance?: 'strict' | 'standard' | 'relaxed'
  readOnly?: boolean
  httpRoutes?: boolean
  budget?: { warn: number; fold: number; compact: number }
  autoInstallOnFirstUse: boolean
  mcp: { serverNamePrefix: string; toolCallTimeoutMs: number; failOnStartupError: boolean }
  projects: ProjectConfigMin[]
}
