// 模型侧确定性工具（设计文档 4.10）：状态/扫描/验证/检查/刷新/审计 —— 零模型语义
// toolSurface=compact 时合并查询类工具并省略低频工具（省 token）；full 暴露全量。
// 语义九工具仍走 MCP 通道（mcp__aoci-<slug>__* 或聚合 aoci_call）。
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { promises as fsP, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join as pathJoin } from 'node:path'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EvidenceStore } from './evidence'
import { subprocessAvailable, runAoci } from './cli'
import { installHint } from './aoci-bin'
import { isGitRepo, gitHead, gitDirty } from './workspace'
import { slugFromRoot, resolveProjectPath, detectAociBinary, estimateToolSurfaceChars, normalizeAociAction, validateEntryText, humanizeAociError } from './util'
import { acquireLock, releaseLock } from './lock'
import { safeLogger } from './logger'

/** 本进程已注册的工具名（供状态自检） */
export const registeredToolNames: string[] = []
import { locateRepo } from './repo-locate'
import { buildRefreshPlan } from './refresh'
import { appendAudit, readAudit, formatAuditReport } from './audit'

export interface ToolDeps {
  store: EvidenceStore
  binaryPath(): Promise<string | undefined>
  projects(): Promise<Array<{ root: string; slug: string }>>
  openPanel(slug: string): void
  bridge: {
    bind(root: string, binaryPath: string): Promise<{ ok: boolean; slug: string; namespace: string; tools: string[]; message: string }>
    ensure(root: string, binaryPath: string): Promise<{ ok: boolean; slug: string; namespace: string; tools: string[]; message: string }>
    call(slug: string, tool: string, args: Record<string, unknown>): Promise<string>
    unbind(slug: string): Promise<boolean>
    boundTools(slug: string): string[]
  }
  defaultRoot?: string
  stateDir: string
  surface: 'compact' | 'full'
  governance: 'strict' | 'standard' | 'relaxed'
  autoRefresh: 'off' | 'status' | 'nightly'
  readOnly: boolean
  verifyBinary(): Promise<{ ok: boolean; version?: string; sha256?: string; reason?: string }>
}

export function installTools(ctx: Context, deps: ToolDeps) {
  // DSH 0.2.x 的服务访问是注入门控的：直接用 ctx.tools 会抛 "cannot get property tools without inject"
  const inject = (ctx as unknown as { inject?(keys: string[], cb: (scoped: Context) => void): unknown }).inject
  if (inject) {
    try {
      inject(['tools'], (scoped: Context) => installToolsOn(ctx, scoped, deps))
      return
    } catch { /* 继续兜底 */ }
  }
  installToolsOn(ctx, ctx, deps)
}

function installToolsOn(ctx: Context, toolCtx: Context, deps: ToolDeps) {
  const register = (tool: ToolDefinition) => {
    try {
      ;(toolCtx.tools as unknown as { register(t: ToolDefinition): void }).register(tool)
      registeredToolNames.push(tool.name)
    } catch (e) {
      // 注册失败不阻塞其余启动，但必须留下日志（此前静默吞错导致"工具不可见"难以排查）
      safeLogger(ctx).warn('dsh-aoci: 工具注册失败 ' + tool.name + ': ' + (e as Error).message)
    }
  }
  const compact = deps.surface === 'compact'
  const toolText = (v: unknown) => [{ type: 'text' as const, text: String(v) }]
  const audit = (ev: Parameters<typeof appendAudit>[1]) => { void appendAudit(deps.stateDir, ev) }
  const resolveProject = async (slugOrRoot: string) => {
    const projects = await deps.store.loadProjects()
    return projects.find((x) => x.slug === slugOrRoot || x.root === slugOrRoot)
  }
  const runJson = async (binary: string, root: string, sub: string[], timeoutMs = 60000) => {
    const out = await runAoci(ctx, { argv: [binary, '--repo', root, ...sub, '--json'], timeoutMs })
    return { ok: out.exitCode === 0, text: out.exitCode === 0 ? out.stdout : 'exit ' + out.exitCode + ': ' + (out.stderr || out.stdout).slice(0, 400), exitCode: out.exitCode }
  }

  // ---------- 状态（含二进制校验/漂移/工具面估算） ----------
  register(defineTool({
    name: 'aoci_status',
    description: '查看 AOCI 项目状态：aligned/条目/基线/MCP、git 漂移、二进制校验、工具面。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute() {
      const projects = await deps.store.loadProjects()
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      const ver = await deps.verifyBinary().catch(() => undefined)
      const header = 'binary=' + (binary ?? '未找到') + ' | version=' + (ver?.version ?? '?') + ' | sha256=' + (ver?.sha256 ? ver.sha256.slice(0, 16) + '…' : '?') + ' | verified=' + (ver?.ok ? 'ok' : 'NO(' + (ver?.reason ?? 'unknown') + ')') + ' | surface=' + deps.surface + ' | governance=' + deps.governance + ' | readOnly=' + deps.readOnly
      const toolsLine = 'registeredTools=' + registeredToolNames.length + ' [' + registeredToolNames.join(',') + ']'
      const lines = projects.map((p) => {
        const head = gitHead(p.root)
        const dirty = gitDirty(p.root)
        const bound = deps.bridge.boundTools(p.slug)
        return [
          'slug=' + p.slug, 'root=' + p.root, 'aligned=' + p.index.aligned,
          'entries=' + p.index.entries, 'baseline=' + p.index.baseline.established,
          'mcp=' + p.mcp.connected, 'db=' + p.database.enabled,
          'head=' + (head ? head.slice(0, 12) : 'n/a'), 'lastHead=' + (p.lastHead ? p.lastHead.slice(0, 12) : 'n/a'),
          'workingDirty=' + dirty, 'boundTools=' + (bound.length ? bound.join(',') : '-'),
        ].join(' | ')
      }).join('\n') || '(暂无项目)'
      return [header, toolsLine, lines].join('\n')
    },
  }))

  // ---------- 验证 / 检查（成功时记录 lastHead 与审计事件） ----------
  register(defineTool({
    name: 'aoci_verify',
    description: '运行 aoci verify --json（只读治理门）；成功后记录维护基线 HEAD。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      if (!subprocessAvailable(ctx)) return 'dsh-aoci: 子进程服务未挂载'
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const p = await resolveProject(args.project)
      if (!p) return '未知项目: ' + args.project
      const started = Date.now()
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'verify', '--json'] })
      const ok = out.exitCode === 0
      audit({ ts: new Date().toISOString(), action: 'verify', project: p.slug, ok, exitCode: out.exitCode, durationMs: Date.now() - started, head: gitHead(p.root) })
      if (!ok) return 'verify 失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout).slice(0, 600)
      const head = gitHead(p.root)
      await deps.store.upsertProject({
        ...p, lastHead: head, lastMaintainAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        index: { ...p.index, aligned: true },
      })
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'verify', project: p.slug, state: 'completed', exitCode: 0 })
      return out.stdout
    },
  }))

  register(defineTool({
    name: 'aoci_check',
    description: '运行 aoci check --json（聚合治理门）。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      if (!subprocessAvailable(ctx)) return 'dsh-aoci: 子进程服务未挂载'
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const p = await resolveProject(args.project)
      if (!p) return '未知项目: ' + args.project
      const started = Date.now()
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'check', '--json'] })
      audit({ ts: new Date().toISOString(), action: 'check', project: p.slug, ok: out.exitCode === 0, exitCode: out.exitCode, durationMs: Date.now() - started })
      if (out.exitCode !== 0) return 'check 失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout).slice(0, 600)
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'check', project: p.slug, state: 'completed', exitCode: 0 })
      return out.stdout
    },
  }))

  // ---------- 自主绑定（含只读模式/二进制校验/审计/HEAD 记录） ----------
  register(defineTool({
    name: 'aoci_use',
    description: '为指定 Git 仓库建立/复用 AOCI 认知：校验路径与二进制 → init/scan（按需）→ 绑定 MCP 桥。支持 locale/scope/agent/db/skipScan。',
    parameters: {
      path: { type: 'string', required: true, description: '仓库路径（绝对或相对 defaultRoot）' },
      root: { type: 'string', description: '可选：相对路径解析基准' },
      locale: { type: 'string', description: 'init 语言环境（默认 en-US）' },
      scope: { type: 'string', description: 'Managed Scope：production / full' },
      agent: { type: 'string', description: 'aoci init --agent 额外宿主接入' },
      db: { type: 'string', description: '数据源 sourceId：绑定后执行只读预检' },
      skipScan: { type: 'boolean', description: '跳过 scan（已有基线会自动跳过）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      if (deps.readOnly) return '只读模式：已禁止 init/scan/维护写操作。请在设置中关闭 readOnly 后重试。'
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const ver = await deps.verifyBinary()
      if (!ver.ok) return '二进制校验失败：' + (ver.reason ?? '未知原因') + '\n' + installHint()
      const resolved = resolveProjectPath(args.path, args.root || deps.defaultRoot)
      if (!resolved) return '无法解析路径。请给绝对路径，或在设置里配置 defaultRoot（相对路径解析基准）。'
      if (!(await isGitRepo(resolved))) return '不是 Git 仓库（需要 .git）：' + resolved
      const slug = slugFromRoot(resolved)
      const initialized = await fsP.access(join(resolved, 'aoci.txt')).then(() => true).catch(() => false)
      if (!initialized) {
        const initArgs = [binary, '--repo', resolved, 'init', '--locale', args.locale ?? 'en-US']
        if (args.scope) initArgs.push('--scope', args.scope)
        if (args.agent) initArgs.push('--agent', args.agent)
        const started = Date.now()
        const bin = await runAoci(ctx, { argv: initArgs, timeoutMs: 120000 })
        audit({ ts: new Date().toISOString(), action: 'init', project: slug, ok: bin.exitCode === 0, exitCode: bin.exitCode, durationMs: Date.now() - started })
        if (bin.exitCode !== 0 && bin.exitCode !== null) return 'init 失败(exit ' + bin.exitCode + '): ' + (bin.stderr || bin.stdout).slice(0, 400)
      }
      const hasBaseline = await fsP.access(join(resolved, '.aoci', 'baseline.json')).then(() => true).catch(() => false)
      if (!hasBaseline && !args.skipScan) {
        const started = Date.now()
        const sc = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'scan'], timeoutMs: 300000 })
        audit({ ts: new Date().toISOString(), action: 'scan', project: slug, ok: sc.exitCode === 0, exitCode: sc.exitCode, durationMs: Date.now() - started })
        if (sc.exitCode !== 0 && sc.exitCode !== null && !/baseline|already/i.test(sc.stderr + sc.stdout)) {
          return 'scan 失败(exit ' + sc.exitCode + '): ' + (sc.stderr || sc.stdout).slice(0, 400)
        }
      }
      const lock = await acquireLock(deps.stateDir, slug)
      if (!lock.ok) return '仓库 ' + slug + ' 正被另一个会话写入（pid=' + (lock.holder?.pid ?? '?') + '），请等待其完成。'
      let br: { ok: boolean; namespace: string; tools: string[]; message: string }
      try {
        br = await deps.bridge.bind(resolved, binary)
      } finally {
        await releaseLock(deps.stateDir, slug).catch(() => undefined)
      }
      audit({ ts: new Date().toISOString(), action: 'bind', project: slug, ok: br.ok, detail: br.message.slice(0, 200) })
      if (!br.ok) return br.message
      const head = gitHead(resolved)
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'bind', project: slug, state: 'completed', message: br.message })
      await deps.store.upsertProject({
        slug, root: resolved, binaryPath: binary, aociVersion: ver.version,
        mcp: { serverName: br.namespace, connected: true, tools: br.tools.length },
        index: { layout: 'volumes-v1', baseline: { established: true }, aligned: false, entries: 0 },
        database: { enabled: !!args.db, sources: [] },
        schedule: { cron: '0 3 * * *', verifyOnly: true },
        lastHead: head,
        binary: { sha256: ver.sha256, version: ver.version, verifiedAt: new Date().toISOString() },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      let dbNote = ''
      if (args.db) {
        const pre = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'database', 'source', 'access', '--source', args.db, '--json'], timeoutMs: 60000 })
        audit({ ts: new Date().toISOString(), action: 'db_preflight', project: slug, ok: pre.exitCode === 0, exitCode: pre.exitCode })
        dbNote = pre.exitCode === 0 ? '\n数据库预检(' + args.db + ')通过。' : '\n数据库预检(' + args.db + ')未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 200)
      }
      return br.message + dbNote
    },
  }))

  // ---------- 静态认知入口（PTC/native 均可用；懒绑定） ----------
  register(defineTool({
    name: 'aoci_cognition',
    description: '静态 AOCI 认知入口（任何工具模式可用）：action=rules|overview|get_entries|search|maintain|update_entry|remove_entry|header|report；project 或 path 指定仓库，缺省自动定位并懒绑定。',
    parameters: {
      action: { type: 'string', required: true, description: 'rules/overview/get_entries/search/maintain/update_entry/remove_entry/header/report' },
      project: { type: 'string', description: '项目 slug（可选）' },
      path: { type: 'string', description: '仓库绝对路径（可选，与 project 二选一）' },
      args: { type: 'json', description: '工具参数 JSON（可选）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      const rawAction = String((args as { action?: string }).action ?? '')
      // 本地预校验入口：action=validate，args.entries 为待校验的 Entry 文本数组或 {new_entry} 数组
      if (rawAction === 'validate') {
        const list = ((args as { args?: { entries?: unknown } }).args ?? {}).entries
        const items = Array.isArray(list) ? list : []
        if (!items.length) return 'validate 需要 args.entries（新条目文本数组或 {new_entry} 数组）'
        const lines: string[] = []
        let bad = 0
        items.forEach((it, i) => {
          const text = typeof it === 'string' ? it : String((it as { new_entry?: string }).new_entry ?? '')
          const findings = validateEntryText(text)
          if (findings.length) { bad++; lines.push('#' + (i + 1) + ' ' + text.slice(0, 60) + ' → ' + findings.map((f) => f.field + ': ' + f.message).join('; ')) }
        })
        return bad ? '预校验发现 ' + bad + '/' + items.length + ' 条问题：\n' + lines.join('\n') : '预校验通过：' + items.length + ' 条 Entry 格式与长度均符合契约。'
      }
      // optimize：映射到 maintain intent=cognition_optimization（返回 review-required 质量批次）
      const tool = rawAction === 'optimize' ? 'aoci_maintain' : normalizeAociAction(rawAction)
      if (!tool) return '未知 action: ' + rawAction + '（可选：rules/overview/get_entries/search/maintain/update_entry/remove_entry/header/report/validate/optimize）'
      const writeActions = ['aoci_maintain', 'aoci_update_entry', 'aoci_remove_entry']
      if (deps.readOnly && writeActions.includes(tool)) return '只读模式：已禁止维护类操作。'
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      let root: string | undefined
      if (args.path) root = resolveProjectPath(String(args.path), deps.defaultRoot)
      else if (args.project) {
        const p = await resolveProject(String(args.project))
        root = p?.root ?? (await isGitRepo(String(args.project)) ? String(args.project) : undefined)
      }
      if (!root) {
        const recent = (await deps.store.loadProjects()).map((p) => ({ root: p.root, updatedAt: p.updatedAt }))
        root = await locateRepo({ defaultRoot: deps.defaultRoot, recent })
      }
      if (!root) return '未找到可用 Git 仓库：请提供 project/path，或先执行 /aoci 绑定一次。'
      if (!(await isGitRepo(root))) return '不是 Git 仓库：' + root
      const ver = await deps.verifyBinary()
      if (!ver.ok) return '二进制校验失败：' + (ver.reason ?? '未知原因') + '\n' + installHint()
      const br = await deps.bridge.ensure(root, binary)
      if (!br.ok) return br.message
      const callArgs = rawAction === 'optimize'
        ? { ...(((args as { args?: Record<string, unknown> }).args ?? {})), intent: 'cognition_optimization' }
        : ((args as { args?: Record<string, unknown> }).args ?? {})
      if (writeActions.includes(tool)) {
        // 并发锁：同一仓库同一时刻只允许一个会话正式写
        const lock = await acquireLock(deps.stateDir, br.slug)
        if (!lock.ok) return '仓库 ' + br.slug + ' 正被另一个会话写入（pid=' + (lock.holder?.pid ?? '?') + '，自 ' + (lock.holder?.acquiredAt ?? '?') + '）。请等待其完成或稍后重试。'
      }
      try {
        // 预校验：update_entry 提交前先在本地检查长度/标签，避免 repair_required 往返
        if (tool === 'aoci_update_entry') {
          const list = (callArgs.entries ?? []) as unknown
          if (Array.isArray(list)) {
            const bad: string[] = []
            list.forEach((it, i) => {
              const text = String((it as { new_entry?: string }).new_entry ?? '')
              const findings = validateEntryText(text)
              if (findings.length) bad.push('#' + (i + 1) + ' ' + findings.map((f) => f.field + ': ' + f.message).join('; '))
            })
            if (bad.length) {
              const msg = '本地预校验未通过（未提交）：\n' + bad.join('\n') + '\n请修正后重交同一完整批次（F≤160、R≤360/8项、A≤400/6项、S 按重要度档）。'
              audit({ ts: new Date().toISOString(), action: 'cognition', project: br.slug, ok: false, detail: 'update_entry precheck failed' })
              return msg
            }
          }
        }
        let out = await deps.bridge.call(br.slug, tool, callArgs)
        out = persistLargeResult(deps, br.slug, tool, out)
        if (tool === 'aoci_maintain') out = appendScaleHints(root, out)
        audit({ ts: new Date().toISOString(), action: 'cognition', project: br.slug, ok: true, detail: tool })
        return out
      } catch (e) {
        audit({ ts: new Date().toISOString(), action: 'cognition', project: br.slug, ok: false, detail: tool + ': ' + (e as Error).message.slice(0, 120) })
        return humanizeAociError('AOCI 调用失败（' + tool + '）: ' + (e as Error).message)
      } finally {
        if (writeActions.includes(tool)) await releaseLock(deps.stateDir, br.slug).catch(() => undefined)
      }
    },
  }))

  register(defineTool({
    name: 'aoci_unbind',
    description: '解绑项目：终止 aoci mcp 并注销对应工具。',
    parameters: { slug: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      const ok = await deps.bridge.unbind(args.slug)
      audit({ ts: new Date().toISOString(), action: 'unbind', project: args.slug, ok })
      return ok ? '已解绑 ' + args.slug : '未找到已绑定的项目 ' + args.slug
    },
  }))

  // ---------- 增量刷新（方向 1） ----------
  register(defineTool({
    name: 'aoci_refresh',
    description: '计算自上次维护基线以来的 git 变更集，并给出只维护受影响条目的分批指令（替代全量重建）。',
    parameters: {
      project: { type: 'string', required: true, description: '项目 slug' },
      sinceHead: { type: 'string', description: '可选：自定义基线 commit（默认使用项目记录的 lastHead）' },
      maxFiles: { type: 'number', description: '最多列出的变更文件数（默认 60）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      const p = await resolveProject(args.project)
      if (!p) return '未知项目: ' + args.project
      const plan = buildRefreshPlan(p.root, args.sinceHead ?? p.lastHead, { governance: deps.governance, maxFiles: args.maxFiles })
      audit({ ts: new Date().toISOString(), action: 'refresh', project: p.slug, ok: true, head: plan.head, detail: plan.changed.length + '+' + plan.untracked.length + ' files' })
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'refresh', project: p.slug, state: 'completed', message: plan.changed.length + ' changed' })
      return plan.instruction
    },
  }))

  // ---------- 构建进度（方向 1） ----------
  register(defineTool({
    name: 'aoci_build_status',
    description: '查看最近的索引构建/维护/验证运行记录与当前绑定状态。',
    parameters: { project: { type: 'string', description: '可选：只看某项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      const runs = await deps.store.readRuns(40)
      const filtered = args.project ? runs.filter((r) => r.project === args.project) : runs
      const tail = filtered.slice(-15).map((r) => r.ts + ' · ' + r.kind + ' · ' + r.project + ' · ' + r.state + (r.exitCode !== undefined ? ' exit=' + r.exitCode : '') + (r.message ? ' · ' + r.message.slice(0, 80) : ''))
      const projects = await deps.store.loadProjects()
      const binds = projects.map((p) => p.slug + ': bound=' + deps.bridge.boundTools(p.slug).length + ' tools').join('\n') || '(无项目)'
      return ['# 构建/维护记录（最近）', ...tail, '', '# 当前绑定', binds].join('\n')
    },
  }))

  // ---------- 审计（方向 4） ----------
  register(defineTool({
    name: 'aoci_audit',
    description: '生成治理审计报告：verify/check 结果、HEAD 与维护基线漂移、最近事件时间线。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
    async execute(args) {
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const p = await resolveProject(args.project)
      if (!p) return '未知项目: ' + args.project
      const head = gitHead(p.root)
      const verify = await runJson(binary, p.root, ['verify'])
      const check = await runJson(binary, p.root, ['check'])
      const events = await readAudit(deps.stateDir)
      audit({ ts: new Date().toISOString(), action: 'audit', project: p.slug, ok: verify.ok && check.ok, head })
      return formatAuditReport(p.slug, {
        events, head, lastHead: p.lastHead, aligned: p.index.aligned,
        verifyText: verify.text, checkText: check.text, governance: deps.governance,
      })
    },
  }))

  // ---------- 紧凑查询（compact 模式）：合并 relations/impact/lineage/db ----------
  if (compact) {
    register(defineTool({
      name: 'aoci_query',
      description: 'AOCI 系统查询聚合：kind=relations|impact|lineage|db（impact 需 object；db 需 source）。',
      parameters: {
        project: { type: 'string', required: true, description: '项目 slug' },
        kind: { type: 'string', required: true, description: 'relations / impact / lineage / db' },
        object: { type: 'string', description: 'kind=impact 时的数据库对象名' },
        source: { type: 'string', description: 'kind=db 时的数据源 sourceId' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
      async execute(args) {
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return installHint()
        const p = await resolveProject(args.project)
        if (!p) return '未知项目: ' + args.project
        const kind = String(args.kind ?? '')
        if (kind === 'impact') {
          if (!args.object) return 'kind=impact 需要 object 参数'
          return (await runJson(binary, p.root, ['cognition', 'system', 'impact', '--object', args.object])).text
        }
        if (kind === 'db') {
          if (!args.source) return 'kind=db 需要 source 参数'
          const pre = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'database', 'source', 'access', '--source', args.source, '--json'], timeoutMs: 60000 })
          audit({ ts: new Date().toISOString(), action: 'db_preflight', project: p.slug, ok: pre.exitCode === 0, exitCode: pre.exitCode })
          return pre.exitCode === 0 ? pre.stdout : '预检未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 300)
        }
        if (!['relations', 'lineage'].includes(kind)) return '未知 kind: ' + kind + '（可选 relations/impact/lineage/db）'
        return (await runJson(binary, p.root, ['cognition', 'system', kind])).text
      },
    }))
  }

  // ---------- 全量模式专用工具 ----------
  if (!compact) {
    register(defineTool({
      name: 'aoci_scan',
      description: '运行 aoci scan（建立/更新 Baseline）。',
      parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
      output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
      async execute(args) {
        if (deps.readOnly) return '只读模式：已禁止 scan'
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return installHint()
        const p = await resolveProject(args.project)
        if (!p) return '未知项目: ' + args.project
        if (!(await isGitRepo(p.root))) return '不是 Git 仓库，scan 需要 Git 清单: ' + p.root
        const started = Date.now()
        const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'scan'] })
        audit({ ts: new Date().toISOString(), action: 'scan', project: p.slug, ok: out.exitCode === 0, exitCode: out.exitCode, durationMs: Date.now() - started })
        if (out.exitCode !== 0) return 'scan 失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout).slice(0, 400)
        await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'scan', project: p.slug, state: 'completed', exitCode: 0 })
        return out.stdout
      },
    }))
    register(defineTool({
      name: 'aoci_panel',
      description: '打开指定项目的 AOCI 只读面板（需启用 httpRoutes）。',
      parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
      output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
      async execute(args) {
        try { deps.openPanel(args.project); return '已请求打开面板: ' + args.project } catch { return '打开面板失败（面板可能未启用）' }
      },
    }))
    const sysQuery = (name: string, desc: string, sub: string) => register(defineTool({
      name, description: desc,
      parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
      output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
      async execute(args) {
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return installHint()
        const p = await resolveProject(args.project)
        if (!p) return '未知项目: ' + args.project
        const out = await runJson(binary, p.root, ['cognition', 'system', sub])
        return out.text
      },
    }))
    sysQuery('aoci_relations', '项目依赖关系投影（cognition system relations）。', 'relations')
    sysQuery('aoci_lineage', '索引对象来源与证据绑定链（cognition system lineage）。', 'lineage')
    register(defineTool({
      name: 'aoci_impact',
      description: '沿正式 R 关系找出数据库对象变更可能触达的代码对象（cognition system impact）。',
      parameters: {
        project: { type: 'string', required: true, description: '项目 slug' },
        object: { type: 'string', required: true, description: '数据库对象名' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
      async execute(args) {
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return installHint()
        const p = await resolveProject(args.project)
        if (!p) return '未知项目: ' + args.project
        const out = await runJson(binary, p.root, ['cognition', 'system', 'impact', '--object', args.object])
        return out.text
      },
    }))
    register(defineTool({
      name: 'aoci_db',
      description: '数据库数据源只读预检（database source access --json）。',
      parameters: { project: { type: 'string', required: true, description: '项目 slug' }, source: { type: 'string', required: true, description: '数据源 sourceId' } },
      output: { schema: { type: 'string' }, render: (_a, v) => toolText(v) },
      async execute(args) {
        const binary = (await deps.binaryPath()) ?? detectAociBinary()
        if (!binary) return installHint()
        const p = await resolveProject(args.project)
        if (!p) return '未知项目: ' + args.project
        const pre = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'database', 'source', 'access', '--source', args.source, '--json'], timeoutMs: 60000 })
        audit({ ts: new Date().toISOString(), action: 'db_preflight', project: p.slug, ok: pre.exitCode === 0, exitCode: pre.exitCode })
        if (pre.exitCode === 0) {
          await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'db_bootstrap', project: p.slug, state: 'completed', message: 'db preflight ok ' + args.source })
          return '预检通过：' + pre.stdout
        }
        return '预检未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 300)
      },
    }))
  }
}

/** 解析 maintain 结果的候选列表，为每个候选文件追加 E 档建议（行数 → T/S/M/L） */
function appendScaleHints(root: string, out: string): string {
  try {
    const jsonStart = out.indexOf('{')
    if (jsonStart < 0) return out
    const parsed = JSON.parse(out.slice(jsonStart)) as { candidates?: Array<{ path?: string }> }
    const candidates = parsed.candidates ?? []
    if (!candidates.length) return out
    const hints: string[] = []
    for (const c of candidates.slice(0, 40)) {
      const p = c.path
      if (!p) continue
      try {
        const text = readFileSync(root + '/' + p, 'utf8') as string
        const lines = text.split('\n').length
        const band = lines >= 400 ? 'L' : lines >= 200 ? 'M' : lines >= 100 ? 'S' : 'T'
        hints.push('- ' + p + ' (' + lines + ' 行) → 建议 E=' + band)
      } catch { /* ignore */ }
    }
    return hints.length ? out + '\n\n[E 档建议]\n' + hints.join('\n') : out
  } catch {
    return out
  }
}

/** 大结果落盘：宿主对工具结果有截断上限（约 13K chars），超限时把完整正文写入 state/aoci/tmp 并返回元数据，避免 attestation 被截断误判 */
function persistLargeResult(deps: ToolDeps, slug: string, tool: string, out: string): string {
  const LIMIT = 12000
  if (out.length <= LIMIT) return out
  try {
    const tmp = pathJoin(deps.stateDir, 'aoci', 'tmp')
    mkdirSync(tmp, { recursive: true })
    const file = pathJoin(tmp, slug + '-' + tool + '-' + Date.now() + '.txt')
    writeFileSync(file, out, 'utf8')
    const sha = createHash('sha256').update(out, 'utf8').digest('hex')
    const tail = out.trimEnd().slice(-300)
    const endMarker = /end[_ -]?marker|<!--\s*aoci:end\s*-->/i.test(tail) || tail.endsWith('END')
    return '[aoci_cognition] ' + tool + ' 结果过大（' + out.length + ' chars > ' + LIMIT + '），完整正文已保存：\n' +
      'body_file=' + file + '\n' +
      'body_sha256=' + sha + '\n' +
      'body_bytes=' + Buffer.byteLength(out, 'utf8') + '\n' +
      'end_marker=' + (endMarker ? 'present' : 'unknown') + '\n' +
      '请用 read 工具分段读取 body_file 以获取完整正文（offset/limit），attestation 的 delivery confirmation 使用上述 sha256/bytes/end_marker。\n\n[HEAD 预览]\n' + out.slice(0, 6000)
  } catch {
    return out
  }
}
