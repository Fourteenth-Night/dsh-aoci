// /aoci 斜杠命令：一键建立 AOCI 认知（init/scan + 绑定 9 个 MCP 工具，并让当前 AI 立即开始建索引）
// 注册采用 ctx.inject(['commands'], cb)（dsh-plan-mode 同款），消除服务挂载顺序问题；结果写入日志便于排障
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { promises as fsP } from 'node:fs'
import { join } from 'node:path'
import { safeGet, resolveProjectPath, slugFromRoot, parseAociInput, detectAociBinary } from './util'
import { isGitRepo } from './workspace'
import { inspectBinary, installHint } from './aoci-bin'
import { runAoci } from './cli'
import { safeLogger } from './logger'
import type { AociBridge } from './bridge'
import type { EvidenceStore } from './evidence'

export interface AociCommandDeps {
  store: EvidenceStore
  bridge: AociBridge
  binaryPath(): Promise<string | undefined>
  defaultRoot?: string
}

interface CommandResult { kind: 'success' | 'error'; text: string }
interface CommandAgent { steer(message: unknown): void }

export function installAociCommand(ctx: Context, deps: AociCommandDeps) {
  const logger = safeLogger(ctx)

  const spec = {
    name: 'aoci',
    description: '为指定 Git 仓库一键建立 AOCI 认知：init/scan + 绑定 9 个 MCP 工具，并让当前 AI 立即开始建索引',
    input: { hint: '<路径>（绝对路径，或相对 defaultRoot 的相对路径）' },
    handler: async ({ agent, rawInput }: { agent: CommandAgent; rawInput: string }): Promise<CommandResult> => {
      try {
        const flags = parseAociInput(rawInput ?? '')
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return { kind: 'error', text: installHint() }
        let resolved = flags.path ? resolveProjectPath(flags.path, deps.defaultRoot) : undefined
        if (!resolved) {
          // 无参：尝试自动定位当前会话工作区仓库
          try {
            const session = (agent as unknown as { session?: { header?: { cwd?: string }; cwd?: string } }).session
            const cwd = session?.header?.cwd ?? session?.cwd
            if (cwd) resolved = resolveProjectPath(cwd, undefined)
          } catch { /* ignore */ }
        }
        if (!resolved) return { kind: 'error', text: '用法：/aoci <路径>（绝对路径，或相对 defaultRoot 的相对路径），或 /aoci 自动定位当前工作区' }
        if (!(await isGitRepo(resolved))) return { kind: 'error', text: '不是 Git 仓库（需要 .git）：' + resolved }

        const slug = slugFromRoot(resolved)
        const initialized = await fsP.access(join(resolved, 'aoci.txt')).then(() => true).catch(() => false)
        if (!initialized) {
          const initArgs = [binary, '--repo', resolved, 'init', '--locale', flags.locale ?? 'en-US']
          if (flags.scope) initArgs.push('--scope', flags.scope)
          if (flags.agent) initArgs.push('--agent', flags.agent)
          const bin = await runAoci(ctx, { argv: initArgs, timeoutMs: 120000 })
          if (bin.exitCode !== 0 && bin.exitCode !== null) {
            return { kind: 'error', text: 'init 失败(exit ' + bin.exitCode + '): ' + (bin.stderr || bin.stdout).slice(0, 400) }
          }
        }
        // 基线已存在时跳过 scan（官方语义：scan 只建首次基线；之后维护走 maintain/update_entry）
        const hasBaseline = await fsP.access(join(resolved, '.aoci', 'baseline.json')).then(() => true).catch(() => false)
        if (!hasBaseline && !flags.skipScan) {
          const sc = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'scan'], timeoutMs: 300000 })
          if (sc.exitCode !== 0 && sc.exitCode !== null) {
            return { kind: 'error', text: 'scan 失败(exit ' + sc.exitCode + '): ' + (sc.stderr || sc.stdout).slice(0, 400) }
          }
        }

        const br = await deps.bridge.bind(resolved, binary)
        if (!br.ok) return { kind: 'error', text: br.message }
        await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'scan', project: slug, state: 'completed', message: br.message })
        await deps.store.upsertProject({
          slug, root: resolved, binaryPath: binary,
          mcp: { serverName: br.namespace, connected: true, tools: 9 },
          index: { layout: 'volumes-v1', baseline: { established: true }, aligned: false, entries: 0 },
          database: { enabled: !!flags.db, sources: [] },
          schedule: { cron: '0 3 * * *', verifyOnly: true },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        })

        let dbNote = ''
        if (flags.db) {
          const pre = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'database', 'source', 'access', '--source', flags.db, '--json'], timeoutMs: 60000 })
          dbNote = pre.exitCode === 0 ? '\n数据库预检(' + flags.db + ')通过，可让 AI 执行 database cognition bootstrap。' : '\n数据库预检(' + flags.db + ')未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 200)
        }

        // 让当前 AI 立即开始建索引（plan-mode 同款提交模式；尽力而为）
        try {
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: 'AOCI 已就绪。请为仓库 ' + resolved + ' 建立 AOCI 认知索引：依次调用 mcp__' + br.namespace + '__aoci_rules 与完整 aoci_overview，按 Guide 分批 aoci_maintain + aoci_update_entry，最后 verify/check 证明 aligned。' + dbNote }],
            source: { kind: 'user' },
          }))
        } catch { /* 提交失败则退化为提示文案 */ }

        return { kind: 'success', text: br.message + dbNote + ' 已让当前 AI 开始建立认知索引。' }
      } catch (e) {
        return { kind: 'error', text: '/aoci 失败: ' + (e as Error).message }
      }
    },
  }

  const register = (commands: { register(spec: unknown): unknown }) => {
    try {
      commands.register(spec)
      logger.info('dsh-aoci: /aoci 命令已注册')
    } catch (e) {
      logger.warn('dsh-aoci: /aoci 命令注册失败: ' + (e as Error).message)
    }
  }

  // 主路径：ctx.inject 等命令服务就绪后再注册（消除挂载顺序问题）
  const inject = (ctx as unknown as { inject?(keys: string[], cb: (scoped: { commands: { register(spec: unknown): unknown } }) => void): unknown }).inject
  if (inject) {
    try {
      inject(['commands'], (commandCtx) => register(commandCtx.commands))
      return
    } catch { /* 继续兜底 */ }
  }
  // 兜底：直接属性访问
  const commands = safeGet<{ register(spec: unknown): unknown }>(ctx, 'commands')
  if (commands?.register) register(commands)
}