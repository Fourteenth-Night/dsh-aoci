// 模型侧确定性工具（设计文档 4.10）：状态/扫描/验证/检查/刷新/审计 —— 零模型语义
// toolSurface=compact 时合并查询类工具并省略低频工具（省 token）；full 暴露全量。
// 语义九工具仍走 MCP 通道（mcp__aoci-<slug>__* 或聚合 aoci_call）。
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { promises as fsP } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EvidenceStore } from './evidence'
import { subprocessAvailable, runAoci } from './cli'
import { installHint } from './aoci-bin'
import { isGitRepo, gitHead, gitDirty } from './workspace'
import { slugFromRoot, resolveProjectPath, detectAociBinary, estimateToolSurfaceChars, normalizeAociAction } from './util'
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
  const register = (tool: ToolDefinition) => {
    try {
      ;(ctx.tools as unknown as { register(t: ToolDefinition): void }).register(tool)
    } catch {
      // 工具注册失败不阻塞其余插件启动
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
      return [header, lines].join('\n')
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
      const br = await deps.bridge.bind(resolved, binary)
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
      const tool = normalizeAociAction(String((args as { action?: string }).action ?? ''))
      if (!tool) return '未知 action: ' + String((args as { action?: string }).action ?? '') + '（可选：rules/overview/get_entries/search/maintain/update_entry/remove_entry/header/report）'
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
      try {
        const callArgs = ((args as { args?: Record<string, unknown> }).args ?? {})
        const out = await deps.bridge.call(br.slug, tool, callArgs)
        audit({ ts: new Date().toISOString(), action: 'cognition', project: br.slug, ok: true, detail: tool })
        return out
      } catch (e) {
        audit({ ts: new Date().toISOString(), action: 'cognition', project: br.slug, ok: false, detail: tool + ': ' + (e as Error).message.slice(0, 120) })
        return 'AOCI 调用失败（' + tool + '）: ' + (e as Error).message
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