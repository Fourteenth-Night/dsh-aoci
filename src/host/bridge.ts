// 动态 MCP 桥：按需拉起 aoci --repo <root> mcp，连接并把工具动态注册进 ctx.tools
// 命名与 dsh-mcp-client 一致：mcp__aoci-<slug>__<tool>。
// toolSurface=compact 时只注册 aoci_overview + 聚合入口 aoci_call（省 token）；full 注册全部九工具。
// 另提供 ensure/call 供静态工具 aoci_cognition 懒绑定调用（保证 PTC 模式也可用）。
import { McpStdioClient } from './mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { AOCI_TOOLS } from './types'
import { slugFromRoot, mcpServerName, sanitizedEnv, compactToolResult } from './util'
import { safeLogger } from './logger'
import { persistOversized, TOOL_RESULT_LIMIT } from './persist'

export type ToolSurface = 'compact' | 'full'

export interface BindResult {
  ok: boolean
  slug: string
  namespace: string
  tools: string[]
  message: string
}

interface BoundServer {
  slug: string
  namespace: string
  root: string
  binaryPath: string
  client: McpStdioClient
  disposers: Array<() => void>
  rebinding: boolean
  retryTimer?: ReturnType<typeof setTimeout>
}

/** 提取 MCP 工具结果的原始正文（不压缩，供落盘/校验使用） */
function mcpText(res: unknown): string {
  const r = res as { content?: unknown; isError?: boolean }
  const content = r.content
  if (Array.isArray(content)) {
    const text = content.map((c) => (c as { text?: string })?.text ?? '').join('')
    return text || JSON.stringify(content)
  }
  if (typeof content === 'string') return content
  return JSON.stringify(res)
}

export class AociBridge {
  private bound = new Map<string, BoundServer>()
  private readonly surface: ToolSurface

  private toolsScoped: Context | undefined
  private readonly stateDir: string | undefined

  constructor(private readonly ctx: Context, opts: { surface?: ToolSurface; stateDir?: string } = {}) {
    this.surface = opts.surface ?? 'compact'
    this.stateDir = opts.stateDir
    // DSH 0.2.x 服务访问注入门控：提前取得 tools 作用域，供 bind 时注册动态工具
    const inject = (ctx as unknown as { inject?(keys: string[], cb: (scoped: Context) => void): unknown }).inject
    if (inject) {
      try { inject(['tools'], (scoped: Context) => { this.toolsScoped = scoped }) } catch { /* fallback */ }
    }
  }

  private toolsRegistry(): { register(t: unknown): () => void } {
    const scoped = this.toolsScoped as unknown as { tools?: { register(t: unknown): () => void } } | undefined
    if (scoped?.tools) return scoped.tools
    return (this.ctx as unknown as { tools: { register(t: unknown): () => void } }).tools
  }

  isBound(slug: string): boolean { return this.bound.has(slug) }

  /** 懒绑定：已绑定则复用，否则按 root+binaryPath 建立 */
  async ensure(root: string, binaryPath: string): Promise<BindResult> {
    const slug = slugFromRoot(root)
    if (this.isBound(slug)) {
      return { ok: true, slug, namespace: mcpServerName('aoci', slug), tools: this.boundTools(slug), message: '项目 ' + slug + ' 已绑定（复用现有 aoci mcp 服务器）' }
    }
    return this.bind(root, binaryPath)
  }

  /** 调用已绑定项目的 AOCI MCP 工具（供静态工具 aoci_cognition 使用） */
  /** 整形工具结果：超限时落盘并返回元数据，避免 6000 字符截断导致 attestation 无法完成 */
  private shapeResult(slug: string, tool: string, res: unknown): string {
    const raw = mcpText(res)
    // 关键顺序：先用原始正文判断大小；超限时落盘完整正文（body_sha256/bytes 描述的是原文），
    // 只有未超限的小结果才做 compact 减速（避免大结果先被 6000 字符截断再落盘）。
    if (raw.length <= TOOL_RESULT_LIMIT) return compactToolResult(raw)
    return persistOversized(this.stateDir, slug, tool, raw, TOOL_RESULT_LIMIT)
  }

  async call(slug: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.bound.get(slug)
    if (!entry) throw new Error('项目未绑定: ' + slug + '（可先调用 aoci_use 或 aoci_cognition 自动绑定）')
    if (!AOCI_TOOLS.includes(tool as never)) throw new Error('未知 AOCI 工具: ' + tool)
    const res = await entry.client.callTool({ name: tool, arguments: args })
    const r = res as { isError?: boolean }
    if (r.isError) throw new Error(JSON.stringify(res))
    return this.shapeResult(slug, tool, res)
  }

  /** 当前绑定暴露的工具名（用于状态展示与 token 估算） */
  boundTools(slug: string): string[] {
    const entry = this.bound.get(slug)
    if (!entry) return []
    return this.surface === 'full' ? [...AOCI_TOOLS] : ['aoci_overview', 'aoci_call']
  }

  async bind(root: string, binaryPath: string): Promise<BindResult> {
    const self = this
    const slug = slugFromRoot(root)
    const namespace = mcpServerName('aoci', slug)
    const existing = this.bound.get(slug)
    if (existing && !existing.rebinding) {
      return { ok: true, slug, namespace, tools: this.boundTools(slug), message: '项目 ' + slug + ' 已绑定（复用现有 aoci mcp 服务器）' }
    }
    if (existing) await this.unbindInternal(slug)

    let client: McpStdioClient
    try {
      // 零依赖 MCP 客户端：全管道 + windowsHide，避免 console 句柄继承导致的 0x800700E8
      client = new McpStdioClient({
        command: binaryPath,
        args: ['--repo', root, 'mcp'],
        env: sanitizedEnv(),
        clientName: 'dsh-aoci',
        clientVersion: '0.3.0',
      })
      await client.connect()
      await client.listTools()
    } catch (e) {
      return { ok: false, slug, namespace, tools: [], message: '绑定失败（无法连接 aoci mcp）：' + (e as Error).message }
    }

    const disposers: Array<() => void> = []
    const registerDirect = (raw: string) => {
      const name = 'mcp__' + namespace + '__' + raw
      const def = defineTool({
        name,
        description: directDescription(raw),
        parameters: { input: { type: 'json', description: '调用参数（JSON 对象，按工具 schema 传入）' } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(args) {
          try {
            const res = await client.callTool({ name: raw, arguments: (args as { input?: Record<string, unknown> }).input ?? {} })
            const r = res as { isError?: boolean }
            if (r.isError) throw new Error(JSON.stringify(res))
            return self.shapeResult(slug, raw, res)
          } catch (e) {
            self.requestRebind(slug, '工具调用失败: ' + String((e as Error).message).slice(0, 160))
            throw e
          }
        },
      })
      disposers.push(this.toolsRegistry().register(def))
    }

    const direct = this.surface === 'full' ? AOCI_TOOLS : ['aoci_overview']
    for (const raw of direct) {
      try { registerDirect(raw) } catch { /* 单个工具注册失败不阻塞其余 */ }
    }

    // 聚合入口：aoci_call { tool, args }（compact 模式覆盖其余全部九工具）
    if (this.surface === 'compact') {
      try {
        const callName = 'mcp__' + namespace + '__aoci_call'
        const def = defineTool({
          name: callName,
          description: 'AOCI 任意认知工具聚合入口（项目 ' + slug + '）。tool 取九工具之一：' + AOCI_TOOLS.join(' / ') + '；args 为对应工具参数 JSON。update_entry 前请先用 aoci_cognition action="validate" 预校验；Volumes v1 只用 maintain/update_entry，禁用 legacy index 命令。',
          parameters: {
            tool: { type: 'string', required: true, description: '九工具之一：' + AOCI_TOOLS.join(', ') },
            args: { type: 'json', description: '工具参数 JSON（如 {"refresh_event_id":"…"}）' },
          },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
          async execute(args) {
            const tool = String((args as { tool?: string }).tool ?? '')
            if (!AOCI_TOOLS.includes(tool as never)) throw new Error('未知 AOCI 工具: ' + tool + '；可选: ' + AOCI_TOOLS.join(', '))
            try {
              const res = await client.callTool({ name: tool, arguments: ((args as { args?: Record<string, unknown> }).args ?? {}) })
              const r = res as { isError?: boolean }
              if (r.isError) throw new Error(JSON.stringify(res))
              return self.shapeResult(slug, tool, res)
            } catch (e) {
              self.requestRebind(slug, '聚合调用失败: ' + String((e as Error).message).slice(0, 160))
              throw e
            }
          },
        })
        disposers.push(this.toolsRegistry().register(def))
      } catch { /* ignore */ }
    }

    const entry: BoundServer = { slug, namespace, root, binaryPath, client, disposers, rebinding: false }
    client.onExit((reason) => self.requestRebind(slug, 'aoci mcp 连接异常: ' + reason.slice(0, 160)))
    this.bound.set(slug, entry)
    const tools = this.boundTools(slug)
    safeLogger(this.ctx).info('dsh-aoci: 桥已绑定 ' + slug + '（' + tools.length + ' 工具, surface=' + this.surface + '）')
    return {
      ok: true, slug, namespace, tools,
      message: '已绑定 ' + slug + '：aoci mcp 服务器已拉起，' + tools.length + ' 个工具注册成功（' + this.surface + '）。接下来请调用 ' + (tools[0] ? 'mcp__' + namespace + '__' + tools[0] : 'aoci_overview') + ' 建立认知。',
    }
  }

  private requestRebind(slug: string, reason: string) {
    const entry = this.bound.get(slug)
    if (!entry || entry.rebinding || entry.retryTimer) return
    safeLogger(this.ctx).warn('dsh-aoci: ' + slug + ' 连接异常（' + reason + '），2s 后自动重连')
    entry.rebinding = true
    entry.retryTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.unbindInternal(slug)
          const r = await this.bind(entry.root, entry.binaryPath)
          if (!r.ok) safeLogger(this.ctx).warn('dsh-aoci: ' + slug + ' 重连失败: ' + r.message)
          else safeLogger(this.ctx).info('dsh-aoci: ' + slug + ' 重连成功')
        } catch (e) {
          safeLogger(this.ctx).warn('dsh-aoci: ' + slug + ' 重连异常: ' + (e as Error).message)
        } finally {
          entry.rebinding = false
          entry.retryTimer = undefined
        }
      })()
    }, 2000)
  }

  async unbind(slug: string): Promise<boolean> {
    return this.unbindInternal(slug)
  }

  private async unbindInternal(slug: string): Promise<boolean> {
    const entry = this.bound.get(slug)
    if (!entry) return false
    if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = undefined }
    for (const d of entry.disposers) { try { d() } catch { /* ignore */ } }
    try { await entry.client.close() } catch { /* ignore */ }
    this.bound.delete(slug)
    return true
  }

  async dispose(): Promise<void> {
    for (const slug of [...this.bound.keys()]) await this.unbindInternal(slug)
  }
}

/** 直接暴露的 MCP 工具描述（短描述以省 token） */
function directDescription(raw: string): string {
  const map: Record<string, string> = {
    aoci_overview: '读取完整系统认知（架构/职责/关系/契约/约束/标签/FRAS 纪律）；超传输阈值时跟 next_cursor 到 completed=true 并提交 attestation。',
    aoci_rules: '读取 AOCI 行为契约。',
    aoci_get_entries: '按条件读取条目。',
    aoci_search: '检索条目。',
    aoci_maintain: '维护索引（无参触发语义漂移计算）。',
    aoci_update_entry: '整批提交语义候选条目。',
    aoci_remove_entry: '移除条目。',
    aoci_header: '读取索引身份与卷头。',
    aoci_report: '生成治理/证据报告。',
  }
  return 'AOCI ' + raw + '：' + (map[raw] ?? 'AOCI 工具')
}