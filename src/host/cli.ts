// 受控确定性命令（设计文档 4.4）：优先经 ctx.subprocess 受管进程执行 aoci；
// 无受管服务时降级到 node child_process（仅本地开发/测试）。
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { sanitizedEnv } from './util'

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

function getSubprocess(ctx: Context | undefined): SubprocessRuntime | undefined {
  if (!ctx) return undefined
  try {
    const svc = (ctx as unknown as { subprocess?: SubprocessRuntime }).subprocess
    return svc && typeof svc.spawn === 'function' ? svc : undefined
  } catch {
    return undefined
  }
}

/** 是否具备受管子进程服务（无 ctx 时视为可用，兼容旧调用） */
export function subprocessAvailable(ctx?: Context): boolean {
  if (ctx) return !!getSubprocess(ctx)
  return true
}

/** 执行 aoci：优先 ctx.subprocess（环境清洗/超时/取消/输出上限），降级 node spawn */
export async function runAoci(ctx: Context, spec: AociCliSpec): Promise<AociCliOutcome> {
  const managed = getSubprocess(ctx)
  if (managed && process.env.DSH_AOCI_NATIVE_SPAWN !== '1') {
    const out = await runManaged(managed, spec)
    // PTC 子分派等场景下受管服务可能"未挂载"：启动失败（exitCode=null 且非超时）时回退 node spawn
    if (out.exitCode === null && !out.timedOut && /未挂载|not mounted|not available|服务/i.test(out.stderr)) return runNode(spec)
    return out
  }
  return runNode(spec)
}

async function runManaged(sp: SubprocessRuntime, spec: AociCliSpec): Promise<AociCliOutcome> {
  const timeoutMs = spec.timeoutMs ?? 60_000
  const maxBytes = spec.maxOutBytes ?? 4 * 1024 * 1024
  const ac = new AbortController()
  const env = { ...sanitizedEnv(), ...(spec.env ?? {}) }
  let handle: SubprocessHandle
  try {
    handle = sp.spawn({
      argv: spec.argv,
      cwd: spec.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: 5000,
      signal: ac.signal,
      env,
    })
  } catch (e) {
    return { exitCode: null, signal: null, stdout: '', stderr: '受管子进程启动失败: ' + (e as Error).message, timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { handle.terminate() } catch { /* ignore */ }
    try { ac.abort() } catch { /* ignore */ }
  }, timeoutMs)
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (e) {
    clearTimeout(timer)
    return { exitCode: null, signal: null, stdout: '', stderr: '受管子进程失败: ' + (e as Error).message, timedOut }
  }
  clearTimeout(timer)
  const readAll = (reader: { readFrom(from: number): { text: string; lossy: boolean } } | undefined): string => {
    if (!reader) return ''
    const res = reader.readFrom(0)
    return (res.lossy ? '[输出超过上限，已保留尾部]\n' : '') + res.text
  }
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: readAll(handle.collected.stdout),
    stderr: readAll(handle.collected.stderr),
    timedOut,
  }
}

function runNode(spec: AociCliSpec): Promise<AociCliOutcome> {
  const timeoutMs = spec.timeoutMs ?? 60_000
  const maxBytes = spec.maxOutBytes ?? 4 * 1024 * 1024
  return new Promise((resolve) => {
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...sanitizedEnv(), ...(spec.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (s: string) => (s.length > maxBytes ? s.slice(-maxBytes) : s)
    child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout + d.toString('utf8')) })
    child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr + d.toString('utf8')) })
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* ignore */ } }, timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal: null, stdout, stderr, timedOut })
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: null, signal: null, stdout, stderr: (err as Error).message, timedOut })
    })
  })
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