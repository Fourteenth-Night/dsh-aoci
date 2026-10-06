// 动态 MCP 桥：按需拉起 aoci --repo <root> mcp，连接并把 9 个工具动态注册进 ctx.tools
// 命名与 dsh-mcp-client 一致：mcp__aoci-<slug>__<tool>。含进程健康监视与自动重连。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { AOCI_TOOLS } from './types'
import { slugFromRoot, mcpServerName } from './util'
import { safeLogger } from './logger'

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
  transport: StdioClientTransport
  client: Client
  disposers: Array<() => void>
  rebinding: boolean
  retryTimer?: ReturnType<typeof setTimeout>
}

export class AociBridge {
  private bound = new Map<string, BoundServer>()

  constructor(private readonly ctx: Context) {}

  private toolsRegistry(): { register(t: unknown): () => void } {
    return (this.ctx as unknown as { tools: { register(t: unknown): () => void } }).tools
  }

  private childOf(t: StdioClientTransport): unknown {
    try {
      return (t as unknown as { getChildProcess?(): unknown }).getChildProcess?.() ?? (t as unknown as { _childProcess?: unknown })._childProcess
    } catch {
      return undefined
    }
  }

  isBound(slug: string): boolean { return this.bound.has(slug) }

  async bind(root: string, binaryPath: string): Promise<BindResult> {
    const self = this
    const slug = slugFromRoot(root)
    const namespace = mcpServerName('aoci', slug)
    const tools = AOCI_TOOLS.map((t) => 'mcp__' + namespace + '__' + t)
    const existing = this.bound.get(slug)
    if (existing && !existing.rebinding) {
      return { ok: true, slug, namespace, tools, message: '项目 ' + slug + ' 已绑定（复用现有 aoci mcp 服务器）' }
    }
    if (existing) await this.unbindInternal(slug)

    let transport: StdioClientTransport
    let client: Client
    try {
      transport = new StdioClientTransport({
        command: binaryPath,
        args: ['--repo', root, 'mcp'],
        env: process.env as unknown as Record<string, string>,
        stderr: 'pipe',
      })
      client = new Client({ name: 'dsh-aoci', version: '0.2.0' }, { capabilities: {} })
      await client.connect(transport)
      await client.listTools()
    } catch (e) {
      return { ok: false, slug, namespace, tools, message: '绑定失败（无法连接 aoci mcp）：' + (e as Error).message }
    }

    const disposers: Array<() => void> = []
    for (const raw of AOCI_TOOLS) {
      try {
        const name = 'mcp__' + namespace + '__' + raw
        const def = defineTool({
          name,
          description: 'AOCI ' + raw + ' · 项目 ' + slug + '（' + root + '）',
          parameters: { input: { type: 'json', description: '调用参数（JSON 对象，按工具 schema 传入）' } },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
          async execute(args) {
            try {
              const res = await client.callTool({ name: raw, arguments: (args as { input?: Record<string, unknown> }).input ?? ({} as Record<string, unknown>) })
              const r = res as { content?: unknown; isError?: boolean }
              if (r.isError) throw new Error(JSON.stringify(r.content ?? res))
              return JSON.stringify(r.content ?? res)
            } catch (e) {
              self.requestRebind(slug, '工具调用失败: ' + String((e as Error).message).slice(0, 160))
              throw e
            }
          },
        })
        disposers.push(this.toolsRegistry().register(def))
      } catch { /* 单个工具注册失败不阻塞其余 */ }
    }

    const entry: BoundServer = { slug, namespace, root, binaryPath, transport, client, disposers, rebinding: false }
    const child = this.childOf(transport)
    if (child && typeof child === 'object' && 'on' in child) {
      ;(child as { on(e: string, cb: () => void): void }).on('exit', () => self.requestRebind(slug, 'aoci mcp 进程退出'))
    }
    this.bound.set(slug, entry)
    safeLogger(this.ctx).info('dsh-aoci: 桥已绑定 ' + slug + '（' + disposers.length + '/' + AOCI_TOOLS.length + ' 工具）')
    return {
      ok: true, slug, namespace, tools,
      message: '已绑定 ' + slug + '：aoci mcp 服务器已拉起，' + disposers.length + '/' + AOCI_TOOLS.length + ' 个工具注册成功。接下来请调用 mcp__' + namespace + '__aoci_rules 与 aoci_overview 建立认知。',
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
    try { ;(entry.transport as unknown as { _childProcess?: { kill(): void } })._childProcess?.kill?.() } catch { /* ignore */ }
    this.bound.delete(slug)
    return true
  }

  async dispose(): Promise<void> {
    for (const slug of [...this.bound.keys()]) await this.unbindInternal(slug)
  }
}
