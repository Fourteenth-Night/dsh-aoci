// 零依赖 MCP stdio 客户端（0.3.0）：直接以 JSON-RPC 2.0 over stdio 驱动 `aoci --repo <root> mcp`。
// 去掉 @modelcontextprotocol/sdk 依赖（其 4.3MB + zod 5.9MB 只用到 client/stdio 两处），
// 同时规避：profile 安装期模块解析失败、SDK 私有 _childProcess 取子进程、继承 console 句柄导致的 0x800700E8。
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { sanitizedEnv } from './util'

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpStdioOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  requestTimeoutMs?: number
  clientName?: string
  clientVersion?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 最小 MCP stdio 客户端：initialize / tools/list / tools/call，全管道 + windowsHide */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly tools: McpToolInfo[] = []
  private seq = 0
  private stderrTail = ''
  private exited = false
  private closing = false
  private exitListeners: Array<(reason: string) => void> = []

  constructor(private readonly opts: McpStdioOptions) {}

  private get timeoutMs(): number { return this.opts.requestTimeoutMs ?? 60_000 }

  get pid(): number | undefined { return this.child?.pid }

  get childProcess(): ChildProcessWithoutNullStreams | undefined { return this.child }

  get toolNames(): string[] { return this.tools.map((t) => t.name) }

  onExit(listener: (reason: string) => void): void { this.exitListeners.push(listener) }

  async connect(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...sanitizedEnv(), ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stderr.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-4000) })
    child.stdin.on('error', (e: Error) => { this.failAll(new Error('aoci mcp stdin 写入失败: ' + e.message)) })
    child.on('error', (e: Error) => {
      this.exited = true
      this.failAll(new Error('aoci mcp 启动失败: ' + e.message + (this.stderrTail ? ' | stderr=' + this.stderrTail : '')))
    })
    child.on('exit', (code, signal) => {
      this.exited = true
      if (!this.closing) this.failAll(new Error('aoci mcp 进程退出 code=' + code + ' signal=' + signal))
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => this.onLine(line))
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.opts.clientName ?? 'dsh-aoci', version: this.opts.clientVersion ?? '0.3.0' },
    }) as { error?: unknown }
    if (init?.error) throw new Error('MCP initialize 失败: ' + JSON.stringify(init.error))
    this.notify('notifications/initialized', {})
  }

  private onLine(line: string): void {
    const text = line.trim()
    if (!text.startsWith('{')) return
    let msg: { id?: number; result?: unknown; error?: unknown }
    try { msg = JSON.parse(text) } catch { return }
    if (msg.id === undefined) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result ?? {})
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
    for (const l of this.exitListeners) { try { l(err.message) } catch { /* ignore */ } }
    this.exitListeners = []
  }

  private write(payload: unknown): void {
    if (this.exited || !this.child) throw new Error(this.stderrTail ? 'aoci mcp 已退出 | stderr=' + this.stderrTail : 'aoci mcp 已退出')
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('MCP 请求超时: ' + method))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e as Error)
      }
    })
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.request('tools/list', {}) as { tools?: McpToolInfo[] }
    this.tools.length = 0
    for (const t of res?.tools ?? []) {
      if (t && typeof t.name === 'string') this.tools.push(t)
    }
    return this.tools
  }

  /** 支持 callTool(name, args) 与 SDK 风格的 callTool({ name, arguments }) */
  async callTool(nameOrReq: string | { name: string; arguments?: Record<string, unknown> }, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const name = typeof nameOrReq === 'string' ? nameOrReq : nameOrReq.name
    const payload = typeof nameOrReq === 'string' ? args : (nameOrReq.arguments ?? {})
    const res = await this.request('tools/call', { name, arguments: payload }) as McpToolResult
    return res ?? {}
  }

  async close(): Promise<void> {
    this.closing = true
    const child = this.child
    this.child = undefined
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('MCP 客户端已关闭')); }
    this.pending.clear()
    if (!child) return
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
  }
}