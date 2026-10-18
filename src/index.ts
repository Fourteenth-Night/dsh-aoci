// dsh-aoci host 半边入口（node 进程）
// 双面插件：包根 exports "."（本文件）；exports "./client" 为浏览器半边。
// 安装：dsh plugin --profile <name> add ./dsh-aoci-0.2.1.tgz
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AociConfigSchema, type AociConfig } from './host/config'
import type { ProjectRecord } from './host/types'
import { EvidenceStore } from './host/evidence'
import { inspectBinary, installHint } from './host/aoci-bin'
import { isGitRepo, checkIgnoreDiscipline, gitHead } from './host/workspace'
import { slugFromRoot, mcpServerName, buildMcpEntry, safeGet, detectAociBinary } from './host/util'
import { safeLogger } from './host/logger'
import { installRoutes } from './host/routes'
import { installTools } from './host/tools'
import { installSystemPrompt } from './host/system-prompt'
import { createNightlyGuard } from './host/jobs'
import { installAociCompactionGuard } from './host/compaction'
import { AociBridge } from './host/bridge'
import { installAociCommand } from './host/command'
import { verifyAociBinary } from './host/binary-verify'
import { runAoci } from './host/cli'

export const name = 'dsh-aoci'
export const config = AociConfigSchema

export const apply = (ctx: Context, config?: AociConfig) => {
  const cfg: AociConfig = {
    defaultRoot: config?.defaultRoot ?? '',
    binaryPath: config?.binaryPath ?? 'C:/aoci/bin/aoci.exe',
    binaryAutoDetect: config?.binaryAutoDetect ?? true,
    binarySha256: config?.binarySha256 ?? '',
    minAociVersion: config?.minAociVersion ?? '0.1.0-rc18',
    envPassthrough: config?.envPassthrough ?? [],
    toolSurface: config?.toolSurface ?? 'compact',
    autoRefresh: config?.autoRefresh ?? 'status',
    governance: config?.governance ?? 'standard',
    readOnly: config?.readOnly ?? false,
    httpRoutes: config?.httpRoutes ?? false,
    budget: config?.budget ?? { warn: 0.6, fold: 0.75, compact: 0.9 },
    autoInstallOnFirstUse: config?.autoInstallOnFirstUse ?? true,
    mcp: {
      serverNamePrefix: config?.mcp?.serverNamePrefix ?? 'aoci',
      toolCallTimeoutMs: config?.mcp?.toolCallTimeoutMs ?? 120000,
      failOnStartupError: config?.mcp?.failOnStartupError ?? false,
    },
    projects: config?.projects ?? [],
  }
  const stateDir = joinStateDir()

  // ---- 证据账本 ----
  const store = new EvidenceStore(stateDir)

  // ---- 二进制定位（配置优先，缺省自动探测） ----
  const resolveBinary = async (): Promise<string | undefined> => {
    const c = cfg.binaryPath
    if (c && (await inspectBinary(c)).exists) return c
    return cfg.binaryAutoDetect !== false ? detectAociBinary() : undefined
  }

  // ---- 二进制校验（SHA-256 / 最低版本 / 缓存） ----
  const verifyBinary = async () => {
    const binary = await resolveBinary()
    if (!binary) return { ok: false, reason: '未找到 aoci 二进制。' + installHint() }
    return verifyAociBinary(ctx, binary, {
      expectedSha256: cfg.binarySha256 || undefined,
      minVersion: cfg.minAociVersion || undefined,
      stateDir,
    })
  }

  // ---- 项目记录初始化（launch：把配置中的项目落成 ProjectRecord） ----
  void (async () => {
    const existing = await store.loadProjects()
    const bySlug = new Map(existing.map((p) => [p.slug, p]))
    const now = new Date().toISOString()
    for (const p of cfg.projects ?? []) {
      const slug = slugFromRoot(p.slug || p.root)
      if (!(await isGitRepo(p.root))) continue
      const rec: ProjectRecord = bySlug.get(slug) ?? {
        slug,
        root: p.root,
        binaryPath: cfg.binaryPath,
        mcp: { serverName: mcpServerName(cfg.mcp?.serverNamePrefix ?? 'aoci', slug), connected: false, tools: 9 },
        index: { layout: 'volumes-v1', baseline: { established: false }, aligned: false, entries: 0 },
        database: { enabled: (p.dbSources?.length ?? 0) > 0, sources: (p.dbSources ?? []).map(s => ({ ...s })) },
        schedule: { cron: p.schedule?.cron ?? '0 3 * * *', verifyOnly: p.schedule?.verifyOnly ?? true },
        lastHead: gitHead(p.root),
        createdAt: now,
        updatedAt: now,
      }
      bySlug.set(slug, rec)
    }
    await store.saveProjects([...bySlug.values()])
  })().catch((e) => safeLogger(ctx).warn('dsh-aoci: 项目记录初始化失败: ' + (e as Error).message))

  // ---- MCP 接线提示 ----
  for (const p of cfg.projects ?? []) {
    const slug = slugFromRoot(p.slug || p.root)
    const entry = buildMcpEntry(p, cfg.binaryPath, {
      serverNamePrefix: cfg.mcp?.serverNamePrefix,
      toolCallTimeoutMs: cfg.mcp?.toolCallTimeoutMs,
      failOnStartupError: cfg.mcp?.failOnStartupError,
    })
    safeLogger(ctx).info('dsh-aoci: 项目 ' + slug + ' 使用 MCP 命名空间 ' + entry.config.serverName +
      '；组合中需挂载该 dsh-mcp-client 条目（args: ' + entry.config.args.join(' ') + '，命令 ' + entry.config.command + '）')
    void (async () => {
      const bad = await checkIgnoreDiscipline(p.root)
      if (bad.length) safeLogger(ctx).warn('dsh-aoci: 项目 ' + slug + ' 的 .gitignore 误排除认知资产，scan 会静默跳过: ' + bad.join(', '))
      const bin = await inspectBinary(cfg.binaryPath)
      if (!bin.exists) safeLogger(ctx).warn('dsh-aoci: ' + cfg.binaryPath + ' 不存在（' + installHint() + '）')
    })().catch(() => undefined)
  }

  // ---- 设置 ----
  installSettings(ctx, cfg)

  // ---- 路由（默认关闭；启用时为只读面板 API） ----
  if (cfg.httpRoutes) {
    installRoutes(ctx, { store, panelUrlFor: () => undefined })
  }

  // ---- 动态 MCP 桥（工具面 compact/full） ----
  const bridge = new AociBridge(ctx, { surface: cfg.toolSurface })

  installTools(ctx, {
    store,
    binaryPath: resolveBinary,
    projects: async () => (cfg.projects ?? []).map((p) => ({ root: p.root, slug: slugFromRoot(p.slug || p.root) })),
    openPanel: (slug) => safeLogger(ctx).info('dsh-aoci: 打开面板 ' + slug),
    bridge,
    defaultRoot: cfg.defaultRoot,
    stateDir,
    surface: cfg.toolSurface ?? 'compact',
    governance: cfg.governance ?? 'standard',
    autoRefresh: cfg.autoRefresh ?? 'status',
    readOnly: cfg.readOnly ?? false,
    verifyBinary,
  })

  installSystemPrompt(ctx, cfg.projects ?? [], { surface: cfg.toolSurface, governance: cfg.governance, readOnly: cfg.readOnly })
  installAociCommand(ctx, {
    store,
    bridge,
    binaryPath: resolveBinary,
    verifyBinary,
    defaultRoot: cfg.defaultRoot,
    readOnly: cfg.readOnly ?? false,
    governance: cfg.governance ?? 'standard',
  })
  installAociCompactionGuard(ctx, {
    serverNamespace: cfg.mcp?.serverNamePrefix ?? 'aoci',
    refreshEventId: () => 'dsh-' + Date.now().toString(16),
    budget: cfg.budget,
    // 尽力测量上下文压力：优先 ctx.tokenMeter；无会话/服务时返回 undefined（策略退化为纯提示）
    getPressure: (session?: unknown) => {
      try {
        const meter = safeGet<{ measure(s: unknown): { totalTokens?: number } }>(ctx, 'tokenMeter')
        const llm = safeGet<{ resolveModelInfo(): { context?: number | { maxTokens?: number } } }>(ctx, 'llm')
        if (!meter || !session) return undefined
        const m = meter.measure(session)
        const info = llm?.resolveModelInfo()
        const limit = typeof info?.context === 'number' ? info.context : info?.context?.maxTokens
        if (typeof limit !== 'number' || limit <= 0 || typeof m.totalTokens !== 'number') return undefined
        return Math.min(1, m.totalTokens / limit)
      } catch {
        return undefined
      }
    },
  })

  // 夜间健康检查（autoRefresh=nightly 时真正执行 verify 并记审计/运行账本）
  const nightlyRuns = new Set<string>()
  const guard = createNightlyGuard({
    alreadyRanToday: (slug, day) => nightlyRuns.has(slug + ':' + day),
    markRan: (slug, day) => { nightlyRuns.add(slug + ':' + day) },
    runVerify: async (p) => {
      const binary = await resolveBinary()
      if (!binary) return
      safeLogger(ctx).info('dsh-aoci: 夜间 verify ' + p.root)
      const started = Date.now()
      const out = await runAoci(ctx, { argv: [binary, '--repo', p.root, 'verify', '--json'], timeoutMs: 120000 })
      const ok = out.exitCode === 0
      void store.appendRun({ ts: new Date().toISOString(), kind: 'verify', project: slugFromRoot(p.slug || p.root), state: ok ? 'completed' : 'failed', exitCode: out.exitCode ?? undefined, message: 'nightly' })
    },
  })
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    timer = setInterval(() => {
      for (const p of cfg.projects ?? []) {
        try { guard.tick(p) } catch { /* cron 非法则跳过 */ }
      }
    }, 60_000)
  } catch { /* Node timers 在受限沙箱不可用时跳过调度 */ }
  if (timer) (ctx as unknown as { on(e: string, cb: () => void): void }).on('dispose', () => { clearInterval(timer); void bridge.dispose() })

  safeLogger(ctx).info('dsh-aoci: 已激活；项目数=' + (cfg.projects?.length ?? 0) + '，surface=' + cfg.toolSurface + '，governance=' + cfg.governance + '，readOnly=' + cfg.readOnly)
}

function installSettings(ctx: Context, cfg: AociConfig) {
  const settings = safeGet<{ register(ns: string, schema: unknown, opts?: { base?: unknown }): unknown }>(ctx, 'settings')
  if (!settings) return
  try {
    settings.register('aoci', AociConfigSchema, { base: cfg })
  } catch (e) {
    safeLogger(ctx).warn('dsh-aoci: 设置注册失败: ' + (e as Error).message)
  }
}

/** profile 状态目录：优先 DSH_HOME/profiles/<name>/state/aoci，缺省回退 DSH_HOME/state/aoci */
function joinStateDir(): string {
  const dshHome = process.env.DSH_HOME ?? joinHome('.dsh')
  const profile = process.env.DSH_PROFILE
  if (profile && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) return join(dshHome, 'profiles', profile, 'state', 'aoci')
  return join(dshHome, 'state', 'aoci')
}

function joinHome(...parts: string[]) {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  return join(home, ...parts)
}