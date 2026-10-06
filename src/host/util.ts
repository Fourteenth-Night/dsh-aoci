// 纯函数工具：slug/serverName/凭据引用派生、五段 cron 匹配、UI JSON 解析等（全部可单测）
import type { McpEntry, ProjectConfig } from './types'
import { AOCI_MANAGED_ASSETS as AOCI_MANAGED_ASSETS_FILTER } from './types'

/** 服务访问：静态 bundle 直接属性访问 ctx.<name>（服务在组合中存在即可解析；缺失/受限时抛错则降级为 undefined） */
export function safeGet<T>(obj: unknown, key: string): T | undefined {
  try {
    return (obj as Record<string, unknown>)?.[key] as T
  } catch {
    return undefined
  }
}

/** 相对路径解析：绝对路径原样；相对路径基于 base 解析；无 base 时返回 undefined（提示 AI 用绝对路径或配 defaultRoot） */
export function resolveProjectPath(input: string, base?: string): string | undefined {
  const p = input.trim()
  if (!p) return undefined
  if (p.includes(':') || p.startsWith('/') || p.startsWith('\\\\')) return p
  if (!base) return undefined
  return base.replace(/[\\/]+$/, '') + '/' + p.replace(/^[\\/]+/, '')
}

/** 仓库根 -> 稳定 slug：取 basename，去非法字符，转小写，短横线连接，保证 [a-z0-9_-]{1,32} */
export function slugFromRoot(root: string): string {
  const base = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo'
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (slug || 'repo').slice(0, 32)
}

/** 默认 DB 凭据环境变量名：sourceId=primary -> AOCI_DB_PRIMARY_DSN */
export function defaultCredentialEnv(sourceId: string): string {
  return 'AOCI_DB_' + sourceId.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase() + '_DSN'
}

/** MCP servername（namespace）：prefix + slug，[A-Za-z0-9_-]{1,32} */
export function mcpServerName(prefix: string, slug: string): string {
  return (prefix + '-' + slug).slice(0, 32)
}

/** 组装 dsh-mcp-client 配置条目（静态接入通道；动态绑定走 host/bridge） */
export function buildMcpEntry(project: ProjectConfig, binaryPath: string, opts: {
  serverNamePrefix?: string
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
} = {}): McpEntry {
  const slug = slugFromRoot(project.slug || project.root)
  const prefix = opts.serverNamePrefix ?? 'aoci'
  const env: Record<string, string> = {}
  for (const src of project.dbSources ?? []) {
    const ref = src.credentialEnv || defaultCredentialEnv(src.sourceId)
    env[ref] = ''
  }
  return {
    id: 'mcp-aoci-' + slug,
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: mcpServerName(prefix, slug),
      transport: 'stdio',
      command: binaryPath,
      args: ['--repo', project.root, 'mcp'],
      env: Object.keys(env).length ? env : undefined,
      toolCallTimeoutMs: opts.toolCallTimeoutMs ?? 120_000,
      failOnStartupError: opts.failOnStartupError ?? false,
      reconnect: { enabled: true },
    },
  }
}

/** 判定 .gitignore 内容是否误把 AOCI 认知资产排除（scan 依 Git 清单取文件，忽略会静默跳过） */
export function ignoredAociAssets(gitignore: string | undefined): string[] {
  if (!gitignore) return []
  const lines = gitignore.split(/\r?\n/)
  return AOCI_MANAGED_ASSETS_FILTER.filter((a) => {
    const pat = a.replace(/\.[a-z]+$/, '')
    return lines.some((l) => {
      const t = l.trim()
      if (!t || t.startsWith('#')) return false
      return t === a || t === '*' + a.slice(a.indexOf('.')) || t.includes(pat)
    })
  })
}

// ---- 5 段 cron 匹配（min hour dom month dow；*、数字、*\/n、逗号） ----
export type CronField = 'minute' | 'hour' | 'dom' | 'month' | 'dow'

export function cronMatch(expr: string, at: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 需要 5 段（min hour dom month dow）: ' + expr)
  const ok = (v: number, low: number, high: number, field: string) => {
    if (v < low || v > high) throw new Error('cron 字段越界 ' + field + ': ' + v)
    return v
  }
  const minute = ok(at.getMinutes(), 0, 59, 'minute')
  const hour = ok(at.getHours(), 0, 23, 'hour')
  const dom = at.getDate()
  const month = at.getMonth() + 1
  const dow = at.getDay()
  const match = (field: string, value: number, low: number, high: number): boolean => {
    const toks = field.split(',')
    for (const tok of toks) {
      if (tok === '*') return true
      const step = tok.split('/')
      if (step.length === 2) {
        const base = step[0]! === '*' ? low : Number(step[0])
        const every = Number(step[1])
        if (value >= base && (value - base) % every === 0) return true
        continue
      }
      const range = tok.split('-')
      if (range.length === 2) {
        const lo = Number(range[0]); const hi = Number(range[1])
        if (value >= lo && value <= hi) return true
        continue
      }
      if (Number(tok) === value) return true
    }
    return false
  }
  const m = match(parts[0]!, minute, 0, 59)
  const h = match(parts[1]!, hour, 0, 23)
  const domM = match(parts[2]!, dom, 1, 31)
  const mon = match(parts[3]!, month, 1, 12)
  const dowM = match(parts[4]!, dow, 0, 6)
  const domStar = parts[2]! === '*'
  const dowStar = parts[4]! === '*'
  const day = domStar || dowStar ? domM && dowM : domM || dowM
  return m && h && day && mon
}

/** 解析 aoci ui --detach --json 输出（字段名以官方为准，防御式读取） */
export function parsePanelLink(json: string): { url?: string; port?: number } {
  try {
    const obj = JSON.parse(json)
    const url = typeof obj.url === 'string' ? obj.url
      : typeof obj.link === 'string' ? obj.link
      : typeof obj.panel === 'string' ? obj.panel : undefined
    const port = typeof obj.port === 'number' ? obj.port
      : url ? Number(new URL(url).port) || undefined : undefined
    return { url, port }
  } catch {
    return {}
  }
}
