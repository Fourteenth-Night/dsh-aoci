// 动态 MCP 桥：按需拉起 aoci --repo <root> mcp，连接并把 9 个工具动态注册进 ctx.tools
// 命名与 dsh-mcp-client 一致：mcp__aoci-<slug>__<tool>。生命周期随绑定/解绑/插件卸载管理。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { AOCI_TOOLS } from './types'
import { slugFromRoot, mcpServerName } from './util'

export interface BindResult {
  ok: boolean
  slug: string
  namespace: string
  tools: string[]
  message: string
}

interface BoundServer {
  transport: StdioClientTransport
  client: Client
  disposers: Array<() => void>
}

export class AociBridge {
  private bound = new Map<string, BoundServer>()

  constructor(private readonly ctx: Context) {}

  private toolsRegistry(): { register(t: unknown): () => void } {
    return (this.ctx as unknown as { tools: { register(t: unknown): () => void } }).tools
  }

  async bind(root: string, binaryPath: string): Promise<BindResult> {
    const slug = slugFromRoot(root)
    const namespace = mcpServerName('aoci', slug)
    const tools = AOCI_TOOLS.map((t) => 'mcp__' + namespace + '__' + t)
    const existing = this.bound.get(slug)
    if (existing) return { ok: true, slug, namespace, tools, message: '项目 ' + slug + ' 已绑定（复用现有 aoci mcp 服务器）' }

    let transport: StdioClientTransport
    let client: Client
    try {
      transport = new StdioClientTransport({
        command: binaryPath,
        args: ['--repo', root, 'mcp'],
        env: process.env as unknown as Record<string, string>,
        stderr: 'pipe',
      })
      client = new Client({ name: 'dsh-aoci', version: '0.1.5' }, { capabilities: {} })
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
            const res = await client.callTool({ name: raw, arguments: (args as { input?: Record<string, unknown> }).input ?? ({} as Record<string, unknown>) })
            const r = res as { content?: unknown; isError?: boolean }
            if (r.isError) throw new Error(JSON.stringify(r.content ?? res))
            return JSON.stringify(r.content ?? res)
          },
        })
        const disposeTool = this.toolsRegistry().register(def)
        disposers.push(disposeTool)
      } catch { /* 单个工具注册失败不阻塞其余 */ }
    }

    this.bound.set(slug, { transport, client, disposers })
    return { ok: true, slug, namespace, tools, message: '已绑定 ' + slug + '：aoci mcp 服务器已拉起，' + disposers.length + '/' + AOCI_TOOLS.length + ' 个工具注册成功。接下来请调用 mcp__' + namespace + '__aoci_rules 与 aoci_overview 建立认知。' }
  }

  async unbind(slug: string): Promise<boolean> {
    const entry = this.bound.get(slug)
    if (!entry) return false
    for (const d of entry.disposers) { try { d() } catch { /* ignore */ } }
    try { await entry.client.close() } catch { /* ignore */ }
    try { ;(entry.transport as unknown as { _childProcess?: { kill(): void } })._childProcess?.kill?.() } catch { /* ignore */ }
    this.bound.delete(slug)
    return true
  }

  isBound(slug: string): boolean { return this.bound.has(slug) }

  async dispose(): Promise<void> {
    for (const slug of [...this.bound.keys()]) await this.unbind(slug)
  }
}