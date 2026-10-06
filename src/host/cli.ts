// 受控确定性命令（设计文档 4.4）：经 ctx.subprocess 执行 aoci 并解析 --json
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

export interface AociCliSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutBytes?: number
}

export interface AociCliOutcome {
  exitCode: number | null
  signal: string | null | undefined
  stdout: string
  stderr: string
  timedOut: boolean
}

export function subprocessAvailable(): boolean {
  // 静态 bundle 使用 node child_process 直接执行，始终可用
  return true
}

/** 执行 aoci（node child_process；静态 bundle 环境可用）；超时强制结束进程树 */
export async function runAoci(_ctx: Context, spec: AociCliSpec): Promise<AociCliOutcome> {
  const timeoutMs = spec.timeoutMs ?? 60_000
  const maxBytes = spec.maxOutBytes ?? 4 * 1024 * 1024
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const cap = (s: string) => s.length > maxBytes ? s.slice(-maxBytes) : s
  child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout + d.toString('utf8')) })
  child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr + d.toString('utf8')) })
  const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* ignore */ } }, timeoutMs)
  const code: number | null = await new Promise((resolve) => child.once('close', (c) => resolve(c)))
  clearTimeout(timer)
  return { exitCode: code, signal: null, stdout, stderr, timedOut }
}

export type AociJsonResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/** 执行 --json 命令并解析；非零退出码 / 解析失败 => { ok:false } */
export async function aociJson<T>(ctx: Context, spec: AociCliSpec): Promise<AociJsonResult<T>> {
  const argv = [...spec.argv, '--json']
  const out = await runAoci(ctx, { ...spec, argv })
  if (out.timedOut) return { ok: false, code: 'timeout', message: 'aoci 命令超时: ' + argv.join(' ') }
  if (out.exitCode !== 0) {
    return { ok: false, code: 'exit-' + String(out.exitCode), message: out.stderr || out.stdout }
  }
  try {
    return { ok: true, data: JSON.parse(out.stdout) as T }
  } catch {
    return { ok: false, code: 'bad-json', message: 'aoci 输出不是合法 JSON: ' + out.stdout.slice(0, 300) }
  }
}