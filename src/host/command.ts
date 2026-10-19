// /aoci 斜杠命令：一键建立 AOCI 认知（init/scan + 绑定 MCP 桥，并让当前 AI 立即开始建索引）
// 注册采用 ctx.inject(['commands'], cb)（dsh-plan-mode 同款），消除服务挂载顺序问题；结果写入日志便于排障
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { promises as fsP } from 'node:fs'
import { join } from 'node:path'
import { safeGet, resolveProjectPath, slugFromRoot, parseAociInput, detectAociBinary, humanizeAociError } from './util'
import { isGitRepo, gitHead } from './workspace'
import { installHint } from './aoci-bin'
import { runAoci } from './cli'
import { safeLogger } from './logger'
import { appendAudit } from './audit'
import { acquireLock, releaseLock } from './lock'
import type { AociBridge } from './bridge'
import type { EvidenceStore } from './evidence'

export interface AociCommandDeps {
  store: EvidenceStore
  bridge: AociBridge
  binaryPath(): Promise<string | undefined>
  defaultRoot?: string
  readOnly?: boolean
  governance?: 'strict' | 'standard' | 'relaxed'
  verifyBinary?(): Promise<{ ok: boolean; version?: string; sha256?: string; reason?: string }>
  stateDir?: string
  recentProjects?(): Promise<Array<{ root: string; slug: string; updatedAt?: string }>>
}

interface CommandResult { kind: 'success' | 'error'; text: string }
interface CommandAgent { steer(message: unknown): void }

export function installAociCommand(ctx: Context, deps: AociCommandDeps) {
  const logger = safeLogger(ctx)

  /** 无参 /aoci 的仓库定位：会话 cwd → 上溯父目录 → defaultRoot → 最近绑定的项目 */
  const locateRepo = async (cwd?: string): Promise<string | undefined> => {
    const isRepo = async (p: string): Promise<boolean> => {
      try { return await isGitRepo(p) } catch { return false }
    }
    // 1) 会话工作区本身
    if (cwd && await isRepo(cwd)) return cwd
    // 2) 上溯父目录（最多 8 层）
    if (cwd) {
      let p = cwd.replace(/[\\/]+$/, '')
      for (let i = 0; i < 8; i++) {
        const parent = p.replace(/[\\/][^\\/]+$/, '')
        if (!parent || parent === p) break
        if (await isRepo(parent)) return parent
        p = parent
      }
    }
    // 3) defaultRoot
    if (deps.defaultRoot && await isRepo(deps.defaultRoot)) return deps.defaultRoot
    // 4) 最近绑定的项目（按 updatedAt 倒序）
    try {
      const recent = deps.recentProjects ? await deps.recentProjects() : []
      const sorted = [...recent].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      for (const p of sorted) if (await isRepo(p.root)) return p.root
    } catch { /* ignore */ }
    return undefined
  }

  const spec = {
    name: 'aoci',
    description: '为指定 Git 仓库一键建立 AOCI 认知：init/scan + 绑定 MCP 桥，并让当前 AI 立即开始建索引',
    input: { hint: '[路径] [--locale zh-CN] [--scope full] [--agent claude] [--skip-scan] [--db primary]' },
    handler: async ({ agent, rawInput }: { agent: CommandAgent; rawInput: string }): Promise<CommandResult> => {
      try {
        if (deps.readOnly) return { kind: 'error', text: '只读模式：已禁止 init/scan/维护写操作。' }
        const flags = parseAociInput(rawInput ?? '')
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return { kind: 'error', text: installHint() }
        const ver = deps.verifyBinary ? await deps.verifyBinary() : undefined
        if (ver && !ver.ok) return { kind: 'error', text: '二进制校验失败：' + (ver.reason ?? '未知原因') + '\n' + installHint() }
        let resolved = flags.path ? resolveProjectPath(flags.path, deps.defaultRoot) : undefined
        if (!resolved) {
          // 无参：多级回退定位仓库（会话工作区 → 上溯父目录 → defaultRoot → 最近绑定项目）
          const session = (agent as unknown as { session?: { header?: { cwd?: string }; cwd?: string } }).session
          const cwd = session?.header?.cwd ?? session?.cwd
          resolved = await locateRepo(cwd)
        }
        if (!resolved) return { kind: 'error', text: '未找到可用的 Git 仓库。无参 /aoci 会依次尝试：会话工作区 → 上溯父目录 → defaultRoot → 最近绑定的项目。请用 /aoci <绝对路径> 指定仓库，或在设置里配置 defaultRoot，或先绑定一次项目。' }
        if (!(await isGitRepo(resolved))) return { kind: 'error', text: '不是 Git 仓库（需要 .git）：' + resolved }

        const slug = slugFromRoot(resolved)
        const initialized = await fsP.access(join(resolved, 'aoci.txt')).then(() => true).catch(() => false)
        if (!initialized) {
          const initArgs = [binary, '--repo', resolved, 'init', '--locale', flags.locale ?? 'en-US']
          if (flags.scope) initArgs.push('--scope', flags.scope)
          if (flags.agent) initArgs.push('--agent', flags.agent)
          const started = Date.now()
          const bin = await runAoci(ctx, { argv: initArgs, timeoutMs: 120000 })
          void appendAudit(deps.stateDir ?? '', { ts: new Date().toISOString(), action: 'init', project: slug, ok: bin.exitCode === 0, exitCode: bin.exitCode, durationMs: Date.now() - started })
          if (bin.exitCode !== 0 && bin.exitCode !== null) {
            return { kind: 'error', text: humanizeAociError('init 失败(exit ' + bin.exitCode + '): ' + (bin.stderr || bin.stdout).slice(0, 400)) }
          }
        }
        // 基线已存在时跳过 scan（官方语义：scan 只建首次基线；之后维护走 maintain/update_entry）
        const hasBaseline = await fsP.access(join(resolved, '.aoci', 'baseline.json')).then(() => true).catch(() => false)
        if (!hasBaseline && !flags.skipScan) {
          const started = Date.now()
          const sc = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'scan'], timeoutMs: 300000 })
          void appendAudit(deps.stateDir ?? '', { ts: new Date().toISOString(), action: 'scan', project: slug, ok: sc.exitCode === 0, exitCode: sc.exitCode, durationMs: Date.now() - started })
          if (sc.exitCode !== 0 && sc.exitCode !== null) {
            return { kind: 'error', text: humanizeAociError('scan 失败(exit ' + sc.exitCode + '): ' + (sc.stderr || sc.stdout).slice(0, 400)) }
          }
        }

        const lock = await acquireLock(deps.stateDir ?? '', slug)
        if (!lock.ok) return { kind: 'error', text: '仓库 ' + slug + ' 正被另一个会话写入（pid=' + (lock.holder?.pid ?? '?') + '），请等待其完成。' }
        let br: { ok: boolean; namespace: string; tools: string[]; message: string }
        try {
          br = await deps.bridge.bind(resolved, binary)
        } finally {
          await releaseLock(deps.stateDir ?? '', slug).catch(() => undefined)
        }
        void appendAudit(deps.stateDir ?? '', { ts: new Date().toISOString(), action: 'bind', project: slug, ok: br.ok, detail: br.message.slice(0, 200) })
        if (!br.ok) return { kind: 'error', text: br.message }
        const head = gitHead(resolved)
        await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'bind', project: slug, state: 'completed', message: br.message })
        await deps.store.upsertProject({
          slug, root: resolved, binaryPath: binary, aociVersion: ver?.version,
          mcp: { serverName: br.namespace, connected: true, tools: br.tools.length },
          index: { layout: 'volumes-v1', baseline: { established: true }, aligned: false, entries: 0 },
          database: { enabled: !!flags.db, sources: [] },
          schedule: { cron: '0 3 * * *', verifyOnly: true },
          lastHead: head,
          binary: { sha256: ver?.sha256, version: ver?.version, verifiedAt: new Date().toISOString() },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        })

        let dbNote = ''
        if (flags.db) {
          const pre = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'database', 'source', 'access', '--source', flags.db, '--json'], timeoutMs: 60000 })
          void appendAudit(deps.stateDir ?? '', { ts: new Date().toISOString(), action: 'db_preflight', project: slug, ok: pre.exitCode === 0, exitCode: pre.exitCode })
          dbNote = pre.exitCode === 0 ? '\n数据库预检(' + flags.db + ')通过，可让 AI 执行 database cognition bootstrap。' : '\n数据库预检(' + flags.db + ')未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 200)
        }

        const overviewTool = br.tools.includes('aoci_overview') ? 'mcp__' + br.namespace + '__aoci_overview' : 'mcp__' + br.namespace + '__aoci_overview'
        const maintainHint = br.tools.includes('aoci_call')
          ? '其余维护工具经 mcp__' + br.namespace + '__aoci_call 调用（tool=aoci_rules/aoci_maintain/aoci_update_entry/…）'
          : '维护工具：mcp__' + br.namespace + '__aoci_maintain / aoci_update_entry / aoci_rules'
        const strict = (deps.governance ?? 'standard') === 'strict'
        try {
          const constraints = [
            'Entry 契约（务必遵守，否则会 repair_required）：filename[tag]: F:… | R:… | A:… | S:…',
            '- 标签格式 A+B+C+[D]+E（两个字母 + 重要度1-9 + 可选 D + 字母，如 EG7T）',
            '- F≤160 runes；R≤360 runes 且 ≤8 项（code:path 逗号分隔，无则 -）；A≤400 runes 且 ≤6 项；',
            '- S 只看不可推断、防错事实，配额按重要度：C9-8≤600 / C7-4≤200 / C3-1≤50 tokens；无则 S:-',
            '建议先调用 aoci_cognition 的 action="validate" 本地预校验条目，再提交 update_entry。',
          ].join('\n')
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: 'AOCI 已就绪（' + br.tools.length + ' 个工具，surface=' + (br.tools.includes('aoci_call') ? 'compact' : 'full') + '）。请为仓库 ' + resolved + ' 建立 AOCI 认知索引，严格按顺序：1) ' + overviewTool + ' 读取完整认知（跟 next_cursor 到 completed=true）；2) 按契约提交 attestation；3) ' + maintainHint + '；4) 按批次交付 update_entry；5) ' + (strict ? '必须' : '建议') + ' verify/check；6) 用 index agent guide 证明 complete=true。\n\n' + constraints + dbNote }],
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