// dsh-aoci host 半边入口（node 进程）
// 双面插件：包根 exports "."（本文件）；exports "./client" 为浏览器半边。
// 安装：dsh plugin --profile <name> add ./dsh-aoci-0.1.0.tgz
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AociConfigSchema, type AociConfig } from './host/config'
import type { ProjectRecord } from './host/types'
import { EvidenceStore } from './host/evidence'
import { inspectBinary } from './host/aoci-bin'
import { isGitRepo, checkIgnoreDiscipline } from './host/workspace'
import { slugFromRoot, mcpServerName, buildMcpEntry, safeGet, detectAociBinary } from './host/util'
import { safeLogger } from './host/logger'
import { installRoutes } from './host/routes'
import { installTools } from './host/tools'
import { installSystemPrompt } from './host/system-prompt'
import { createNightlyGuard } from './host/jobs'
import { installAociCompactionGuard } from './host/compaction'
import { runCognizanceSession } from './host/session-driver'
import { AociBridge } from './host/bridge'
import { installAociCommand } from './host/command'

export const name = 'dsh-aoci'
export const config = AociConfigSchema

export const apply = (ctx: Context, config?: AociConfig) => {
  const cfg: AociConfig = {
    defaultRoot: config?.defaultRoot ?? '',
    binaryPath: config?.binaryPath ?? 'C:/aoci/bin/aoci.exe',
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
        createdAt: now,
        updatedAt: now,
      }
      bySlug.set(slug, rec)
    }
    await store.saveProjects([...bySlug.values()])
  })().catch((e) => safeLogger(ctx).warn('dsh-aoci: 项目记录初始化失败: ' + (e as Error).message))

  // ---- MCP 接线提示（条目由 profile 组合写入；插件侧校验并提示） ----
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
      if (!bin.exists) safeLogger(ctx).warn('dsh-aoci: ' + cfg.binaryPath + ' 不存在（' + installHintText() + '）')
    })().catch(() => undefined)
  }

  // ---- 设置（installSettingsSection：dsh-settings 在场时注册可编辑 namespace） ----
  installSettings(ctx, cfg)

  // ---- 路由 / 工具 / 系统段 / 压缩守卫 / 夜间健康检查 ----
  installRoutes(ctx, {
    store,
    panelUrlFor: () => undefined, // M2: 解析 aoci ui --detach --json 的 loopback 链接
  })
  const bridge = new AociBridge(ctx)
  installTools(ctx, {
    store,
    binaryPath: async () => {
      const c = cfg.binaryPath
      if (c && (await inspectBinary(c)).exists) return c
      return cfg.binaryAutoDetect !== false ? detectAociBinary() : undefined
    },
    projects: async () => (cfg.projects ?? []).map((p) => ({ root: p.root, slug: slugFromRoot(p.slug || p.root) })),
    openPanel: (slug) => safeLogger(ctx).info('dsh-aoci: 打开面板 ' + slug + '（M2 实现 iframe/反代）'),
    bridge,
    defaultRoot: cfg.defaultRoot,
  })
  installSystemPrompt(ctx, cfg.projects ?? [])
  installAociCommand(ctx, {
    store,
    bridge,
    binaryPath: async () => (await inspectBinary(cfg.binaryPath)).exists ? cfg.binaryPath : undefined,
    defaultRoot: cfg.defaultRoot,
  })
  installAociCompactionGuard(ctx, {
    serverNamespace: cfg.mcp?.serverNamePrefix ?? 'aoci',
    refreshEventId: () => 'dsh-' + Date.now().toString(16),
  })

  // 夜间健康检查（浏览器心跳由 client 半边驱动 tick；host 侧供测试/CLI 复用）
  const nightlyRuns = new Set<string>()
  const guard = createNightlyGuard({
    alreadyRanToday: (slug, day) => nightlyRuns.has(slug + ':' + day),
    markRan: (slug, day) => { nightlyRuns.add(slug + ':' + day) },
    runVerify: async (p) => {
      safeLogger(ctx).info('dsh-aoci: 夜间 verify ' + p.root)
      // M1: 实际执行 aoci verify --json 并经 store.appendRun 记录
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

  // 认知会话驱动（供 client/工具调用）；apply 必须返回 undefined（cordis 视返回值为 effect）
  safeLogger(ctx).info('dsh-aoci: 已激活；项目数=' + (cfg.projects?.length ?? 0) + '，MCP 工具命名空间前缀=' + (cfg.mcp?.serverNamePrefix ?? 'aoci'))
}

function installHintText(): string {
  return '请从官方 Release 下载 aoci 并放到稳定路径（插件不捆绑二进制，FSL-1.1-MIT）'
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

/** profile 状态目录：优先 DSH_HOME/profiles/<name>/state/aoci，缺省回退用户缓存目录上的 aoci */
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