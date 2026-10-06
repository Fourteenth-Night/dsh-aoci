// 模型侧确定性工具（设计文档 4.10）：状态/扫描/验证/检查/面板 —— 零模型语义
// 语义九工具仍走 MCP 通道（mcp__aoci-<slug>__*）；此处只暴露确定性运维操作。
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { promises as fsP } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EvidenceStore } from './evidence'
import { subprocessAvailable, runAoci } from './cli'
import { installHint } from './aoci-bin'
import { isGitRepo, gitHead, gitDirty } from './workspace'
import { slugFromRoot, resolveProjectPath, detectAociBinary } from './util'

export interface ToolDeps {
  store: EvidenceStore
  binaryPath(): Promise<string | undefined>
  projects(): Promise<Array<{ root: string; slug: string }>>
  openPanel(slug: string): void
  bridge: { bind(root: string, binaryPath: string): Promise<{ ok: boolean; slug: string; namespace: string; tools: string[]; message: string }>; unbind(slug: string): Promise<boolean> }
  defaultRoot?: string
}

export function installTools(ctx: Context, deps: ToolDeps) {
  const register = (tool: ToolDefinition) => {
    try {
      ;(ctx.tools as unknown as { register(t: ToolDefinition): void }).register(tool)
    } catch {
      // 工具注册失败不阻塞其余插件启动
    }
  }

  register(defineTool({
    name: 'aoci_status',
    description: '查看 dsh-aoci 管理的项目认知状态（aligned、条目数、基线、MCP 连接）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const projects = await deps.store.loadProjects()
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      return projects.map((p) => [
        'slug=' + p.slug, 'root=' + p.root, 'aligned=' + p.index.aligned,
        'entries=' + p.index.entries, 'baseline=' + p.index.baseline.established,
        'mcp=' + p.mcp.connected, 'db=' + p.database.enabled,
        'head=' + (gitHead(p.root) ?? 'n/a'), 'workingDirty=' + gitDirty(p.root),
      ].join(' | ')).join('\n') || ('(暂无项目; 二进制=' + (binary ?? '未找到') + ')')
    },
  }))

  register(defineTool({
    name: 'aoci_verify',
    description: '对指定项目运行 aoci verify --json（只读治理门，可能追加本地 Ledger）。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug（见 aoci_status）' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      if (!subprocessAvailable()) return 'dsh-aoci: ctx.subprocess 未挂载（需要 @deepseek-ai/dsh-subprocess-local）'
      const binary = await deps.binaryPath()
      if (!binary) return installHint()
      const projects = await deps.store.loadProjects()
      const p = projects.find((x) => x.slug === args.project)
      if (!p) return '未知项目: ' + args.project
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'verify', '--json'] })
      if (out.exitCode !== 0) return 'verify 失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout)
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'verify', project: p.slug, state: 'completed', exitCode: 0 })
      return out.stdout
    },
  }))

  register(defineTool({
    name: 'aoci_scan',
    description: '对指定项目运行 aoci scan（建立/更新 Baseline）。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      if (!subprocessAvailable()) return 'dsh-aoci: ctx.subprocess 未挂载'
      const binary = await deps.binaryPath()
      if (!binary) return installHint()
      const projects = await deps.store.loadProjects()
      const p = projects.find((x) => x.slug === args.project)
      if (!p) return '未知项目: ' + args.project
      if (!(await isGitRepo(p.root))) return '不是 Git 仓库，scan 需要 Git 清单: ' + p.root
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'scan'] })
      if (out.exitCode !== 0) return 'scan 失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout)
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'scan', project: p.slug, state: 'completed', exitCode: 0 })
      return out.stdout
    },
  }))

  register(defineTool({
    name: 'aoci_panel',
    description: '打开指定项目的 AOCI 只读面板（loopback）。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      try {
        deps.openPanel(args.project)
        return '已请求打开面板: ' + args.project
      } catch {
        return '打开面板失败（面板可能未启动，可在设置页启用）'
      }
    },
  }))

  // aoci_use：AI 自主选定仓库路径（绝对/相对 defaultRoot）→ init + scan + 动态绑定 MCP 桥
  register(defineTool({
    name: 'aoci_use',
    description: '为 AI 自主指定的 Git 仓库建立/复用 AOCI 认知：校验路径（绝对，或相对 defaultRoot）→ init + scan → 拉起 aoci mcp 并注册 mcp__aoci-<slug>__* 九工具。之后调用 aoci_rules 与 aoci_overview。',
    parameters: {
      path: { type: 'string', required: true, description: '仓库路径：绝对路径，或相对 defaultRoot 的相对路径' },
      root: { type: 'string', description: '可选：绝对基准目录（覆盖 defaultRoot 用于相对路径解析）' },
      locale: { type: 'string', description: 'init 语言环境，默认 en-US（可 zh-CN）' },
      scope: { type: 'string', description: 'Managed Scope：production / full' },
      agent: { type: 'string', description: '额外宿主接入（codex/claude/cursor/opencode），传给 aoci init --agent' },
      db: { type: 'string', description: '数据源 sourceId（如 primary）：绑定后执行 database source access 预检' },
      skipScan: { type: 'boolean', description: '跳过 scan（已有基线时自动跳过，无需设置）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const resolved = resolveProjectPath(args.path, args.root || deps.defaultRoot)
      if (!resolved) return '无法解析路径。请给绝对路径，或在设置里配置 defaultRoot（相对路径解析基准）。'
      if (!(await isGitRepo(resolved))) return '不是 Git 仓库（需要 .git）：' + resolved
      const slug = slugFromRoot(resolved)
      // init 只治理未初始化仓库；已初始化（存在 aoci.txt）时跳过 init，避免 Volumes v1 拒绝写路径
      const initialized = await fsP.access(join(resolved, 'aoci.txt')).then(() => true).catch(() => false)
      if (!initialized) {
        const initArgs = [binary, '--repo', resolved, 'init', '--locale', args.locale ?? 'en-US']
        if (args.scope) initArgs.push('--scope', args.scope)
        if (args.agent) initArgs.push('--agent', args.agent)
        const bin = await runAoci(ctx, { argv: initArgs, timeoutMs: 120000 })
        if (bin.exitCode !== 0 && bin.exitCode !== null) {
          return 'init 失败(exit ' + bin.exitCode + '): ' + (bin.stderr || bin.stdout).slice(0, 400)
        }
      }
      // 基线已存在时跳过 scan（官方语义：scan 只建首次基线；之后维护走 maintain/update_entry）
      const hasBaseline = await fsP.access(join(resolved, '.aoci', 'baseline.json')).then(() => true).catch(() => false)
      if (!hasBaseline && !args.skipScan) {
        const sc = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'scan'], timeoutMs: 300000 })
        if (sc.exitCode !== 0 && sc.exitCode !== null && !/baseline|already/i.test(sc.stderr + sc.stdout)) {
          return 'scan 失败(exit ' + sc.exitCode + '): ' + (sc.stderr || sc.stdout).slice(0, 400)
        }
      }
      const br = await deps.bridge.bind(resolved, binary)
      if (!br.ok) return br.message
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'scan', project: slug, state: 'completed', message: br.message })
      await deps.store.upsertProject({
        slug, root: resolved, binaryPath: binary,
        mcp: { serverName: br.namespace, connected: true, tools: 9 },
        index: { layout: 'volumes-v1', baseline: { established: true }, aligned: false, entries: 0 },
        database: { enabled: !!args.db, sources: [] },
        schedule: { cron: '0 3 * * *', verifyOnly: true },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      if (args.db) {
        const pre = await runAoci(ctx, { argv: [binary, '--repo', resolved, 'database', 'source', 'access', '--source', args.db, '--json'], timeoutMs: 60000 })
        return br.message + '\n数据库预检(' + args.db + '): ' + (pre.exitCode === 0 ? pre.stdout : '未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 300))
      }
      return br.message
    },
  }))

  // aoci_unbind：解绑（终止 aoci mcp 进程、注销工具）
  register(defineTool({
    name: 'aoci_unbind',
    description: '解绑某项目：终止其 aoci mcp 服务器并注销对应工具（mcp__aoci-<slug>__*）。',
    parameters: { slug: { type: 'string', required: true, description: '项目 slug（见 aoci_use/aoci_status）' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const ok = await deps.bridge.unbind(args.slug)
      return ok ? '已解绑 ' + args.slug : '未找到已绑定的项目 ' + args.slug
    },
  }))

  // aoci_check：与 verify 相同的确定性门，供 CI/收尾使用
  register(defineTool({
    name: 'aoci_check',
    description: '对指定项目运行 aoci check --json（聚合治理门）。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      if (!subprocessAvailable()) return 'dsh-aoci: ctx.subprocess 未挂载'
      const binary = await deps.binaryPath()
      if (!binary) return installHint()
      const projects = await deps.store.loadProjects()
      const p = projects.find((x) => x.slug === args.project)
      if (!p) return '未知项目: ' + args.project
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'check', '--json'] })
      if (out.exitCode !== 0) return 'check 失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout)
      await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'check', project: p.slug, state: 'completed', exitCode: 0 })
      return out.stdout
    },
  }))

  // AOCI System Cognition 查询（cognition system * --json）
  const sysQuery = (name: string, desc: string, sub: string) => register(defineTool({
    name,
    description: desc,
    parameters: { project: { type: 'string', required: true, description: '项目 slug' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const projects = await deps.store.loadProjects()
      const p = projects.find((x) => x.slug === args.project)
      if (!p) return '未知项目: ' + args.project
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'cognition', 'system', sub, '--json'], timeoutMs: 60000 })
      return out.exitCode === 0 ? out.stdout : '查询失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout).slice(0, 400)
    },
  }))
  sysQuery('aoci_relations', '项目依赖关系投影：卷包含关系 + 已解析的模型创作 R 关系（cognition system relations）。', 'relations')
  // impact 需要 object 参数，单独定义
  register(defineTool({
    name: 'aoci_impact',
    description: '沿正式 R 关系找出数据库对象变更可能触达的代码对象（cognition system impact）。',
    parameters: {
      project: { type: 'string', required: true, description: '项目 slug' },
      object: { type: 'string', required: true, description: '数据库对象名（如表名/对象标识）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const projects = await deps.store.loadProjects()
      const p = projects.find((x) => x.slug === args.project)
      if (!p) return '未知项目: ' + args.project
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'cognition', 'system', 'impact', '--object', args.object, '--json'], timeoutMs: 60000 })
      return out.exitCode === 0 ? out.stdout : '查询失败(exit ' + out.exitCode + '): ' + (out.stderr || out.stdout).slice(0, 400)
    },
  }))
  sysQuery('aoci_lineage', '索引对象来源与证据/回执绑定链（cognition system lineage）。', 'lineage')

  // aoci_db：数据库数据源只读预检（凭据仅环境变量引用）
  register(defineTool({
    name: 'aoci_db',
    description: '对指定项目的数据库数据源执行只读预检（database source access --json）；凭据仅环境变量引用，绝不收集密钥。',
    parameters: { project: { type: 'string', required: true, description: '项目 slug' }, source: { type: 'string', required: true, description: '数据源 sourceId（如 primary）' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const binary = (await deps.binaryPath()) ?? detectAociBinary()
      if (!binary) return installHint()
      const projects = await deps.store.loadProjects()
      const p = projects.find((x) => x.slug === args.project)
      if (!p) return '未知项目: ' + args.project
      const pre = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'database', 'source', 'access', '--source', args.source, '--json'], timeoutMs: 60000 })
      if (pre.exitCode === 0) {
        await deps.store.appendRun({ ts: new Date().toISOString(), kind: 'db_bootstrap', project: p.slug, state: 'completed', message: 'db preflight ok ' + args.source })
        return '预检通过：' + pre.stdout + '\n下一步：让当前 AI 执行 database cognition bootstrap 建立表级认知（凭据由环境变量 AOCI_DB_<ID>_DSN 提供）。'
      }
      return '预检未通过(exit ' + pre.exitCode + '): ' + (pre.stderr || pre.stdout).slice(0, 300)
    },
  }))
}