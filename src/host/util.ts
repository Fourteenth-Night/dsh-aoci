// 纯函数工具：slug/serverName/凭据引用派生、五段 cron 匹配、UI JSON 解析、标志解析等（全部可单测）
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpEntry, ProjectConfig } from './types'
import { AOCI_MANAGED_ASSETS as AOCI_MANAGED_ASSETS_FILTER } from './types'

/** 解析 /aoci 或 aoci_use 的原始输入：首个 token 为路径，其余为 --key value / --flag */
export interface AociFlags {
  path?: string
  locale?: string
  scope?: string
  agent?: string
  db?: string
  skipScan?: boolean
}
export function parseAociInput(raw: string): AociFlags {
  const out: AociFlags = {}
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('--')) {
      const key = t.slice(2)
      if (key === 'skip-scan') out.skipScan = true
      else if (key === 'locale' || key === 'scope' || key === 'agent' || key === 'db') {
        const val = tokens[i + 1]
        if (val && !val.startsWith('--')) { (out as Record<string, string>)[key] = val; i++ }
      }
    } else if (!out.path) {
      out.path = t
    }
  }
  return out
}

/** 自动探测 aoci 二进制：优先显式配置；否则常见目录与 PATH（不比较版本，保持零开销） */
export function detectAociBinary(configured?: string): string | undefined {
  if (configured) return configured
  for (const c of ['C:/aoci/bin/aoci.exe', 'C:/aoci/aoci.exe']) {
    try { if (existsSync(c)) return c } catch { /* ignore */ }
  }
  for (const p of (process.env.PATH || '').split(';')) {
    if (!p) continue
    try { const f = join(p, 'aoci.exe'); if (existsSync(f)) return f } catch { /* ignore */ }
  }
  return undefined
}

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

/** 文件 SHA-256（hex 小写）；读取失败返回 undefined */
export function sha256File(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

/** 从 `aoci version` / `--version` 输出解析版本号（如 0.1.0-rc21） */
export function parseAociVersion(output: string): string | undefined {
  const m = output.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/)
  return m ? m[1] : undefined
}

/** 版本比较：a < b 返回 -1，相等 0，a > b 返回 1；识别预发布段（rc/alpha 等按字符串序近似） */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.trim().replace(/^v/i, '')
  const [aMain, aPre] = norm(a).split('-')
  const [bMain, bPre] = norm(b).split('-')
  const pa = (aMain || '').split('.').map((x) => Number(x) || 0)
  const pb = (bMain || '').split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (!aPre && !bPre) return 0
  if (!aPre) return 1
  if (!bPre) return -1
  return aPre === bPre ? 0 : aPre < bPre ? -1 : 1
}

/** 受管子进程环境白名单：只透传系统必需变量、AOCI_DB_* 与显式配置项（剥离其余凭据与 DSH_* 事实） */
export function sanitizedEnv(extra: string[] = []): Record<string, string> {
  const keep = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'COMSPEC', 'PATHEXT', 'windir', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (keep.has(k) || k.startsWith('AOCI_DB_') || extra.some((e) => e.toUpperCase() === k.toUpperCase())) env[k] = v
  }
  return env
}

/** 工具结果整形：JSON 可解析时只保留关键字段并限制长度；不可解析时按字符截断并给 receipt */
export function compactToolResult(raw: string, maxChars = 6000): string {
  const truncated = (text: string) =>
    text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…[truncated ' + (text.length - maxChars) + ' chars; full result remains in the session log]'
  try {
    const parsed = JSON.parse(raw)
    const text = (parsed as Record<string, unknown>).text
    if (typeof text === 'string') return truncated(text)
    return truncated(JSON.stringify(parsed))
  } catch {
    return truncated(raw)
  }
}

/** 工具面 token 估算（字符数/4，粗略；用于展示优化前后对比） */
export function estimateToolSurfaceChars(tools: Array<{ name: string; description?: string; parameters?: unknown }>): number {
  return tools.reduce((n, t) => n + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length, 0)
}

/** 归一化 AOCI 认知动作：'overview' / 'aoci_overview' 均 → 'aoci_overview'；未知返回 '' */
export function normalizeAociAction(action: string): string {
  const a = action.trim()
  if (!a) return ''
  const full = a.startsWith('aoci_') ? a : 'aoci_' + a
  const known = ['aoci_rules', 'aoci_overview', 'aoci_get_entries', 'aoci_search', 'aoci_maintain', 'aoci_update_entry', 'aoci_remove_entry', 'aoci_header', 'aoci_report']
  return known.includes(full) ? full : ''
}

// ---------- P0/P1：条目撰写契约与错误提示 ----------

export interface EntryFinding {
  field: 'F' | 'R' | 'A' | 'S' | 'tag' | 'format'
  message: string
}

/** 本地预校验一条 Entry：格式、标签、F/R/A/S 长度与配额（避免提交后才 repair_required） */
export function validateEntryText(entry: string): EntryFinding[] {
  const findings: EntryFinding[] = []
  const m = entry.match(/^([^\[]+)\[([^\]]+)\]:\s*([\s\S]*)$/)
  if (!m) return [{ field: 'format', message: '期望格式 filename[tag]: F:… | R:… | A:… | S:…' }]
  const tags = m[2] ?? ''
  const tagMatch = tags.match(/^[A-Z][A-Z]([1-9])(?:[A-Z])?[A-Z]$/)
  if (!tagMatch) findings.push({ field: 'tag', message: '标签应为 A+B+C+[D]+E（两字母+重要度1-9+可选D+字母，如 EG7T）' })
  const cDigit = tagMatch ? Number(tagMatch[1]) : 5
  const fields: Record<string, string> = {}
  for (const part of (m[3] ?? '').split('|')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim().toUpperCase()
    if (key === 'F' || key === 'R' || key === 'A' || key === 'S') fields[key] = part.slice(idx + 1).trim()
  }
  const runes = (s: string) => [...s].length
  const limits: Record<string, number> = { F: 160, R: 360, A: 400 }
  for (const k of ['F', 'R', 'A'] as const) {
    const v = fields[k]
    if (!v) { findings.push({ field: k, message: k + ' 字段缺失' }); continue }
    const limit = limits[k] ?? 160
    if (runes(v) > limit) findings.push({ field: k, message: k + ' 超过 ' + limit + ' runes（当前 ' + runes(v) + '）' })
  }
  const r = fields['R']
  if (r && r !== '-' && r.split(',').filter(Boolean).length > 8) findings.push({ field: 'R', message: 'R 最多 8 项' })
  const a = fields['A']
  if (a && a !== '-' && a.split(',').filter(Boolean).length > 6) findings.push({ field: 'A', message: 'A 最多 6 项' })
  const s = fields['S']
  if (s && s !== '-') {
    const tokens = Math.ceil(Buffer.byteLength(s, 'utf8') / 3)
    const limit = cDigit >= 8 ? 600 : cDigit >= 4 ? 200 : 50
    if (tokens > limit) findings.push({ field: 'S', message: 'S 约 ' + tokens + ' tokens，超过 C' + cDigit + ' 档上限 ' + limit })
  }
  return findings
}

/** 把 AOCI 机器错误翻译成可操作提示（Volumes v1 / repair 长度限制） */
export function humanizeAociError(text: string): string {
  const t = String(text ?? '')
  const hints: string[] = []
  if (/cannot modify Volumes v1 formal cognition/i.test(t)) hints.push('本仓库为 Volumes v1 布局：请使用 aoci_cognition 的 action="maintain"/"update_entry"（对应 MCP aoci_maintain/aoci_update_entry），不要使用 legacy 的 index/scope/onboard 命令。')
  if (/repair_required/i.test(t)) hints.push('按 findings 只修复指定字段后重交同一完整批次；上限：F≤160 runes、R≤360（≤8 项）、A≤400（≤6 项）、S 按重要度档（C9-8≤600 / C7-4≤200 / C3-1≤50 tokens）。')
  if (/entry_field_budget_exceeded/i.test(t)) hints.push('字段超限时压缩语义，不要机械截断；可先调用 aoci_cognition 的 action="validate" 做本地预校验。')
  return hints.length ? t + '\n\n[提示] ' + hints.join(' ') : t
}