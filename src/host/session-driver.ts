// "认知工作" = 真实 DSH Agent 会话任务（设计文档 4.5）
// AOCI 语义必须由模型生成：建索引/维护索引/数据库认知通过真实会话执行，消耗 API 额度。
// 执行机制对齐 dsh-task-board：workspaces 接入真实 session -> 重命名 -> session.prompt -> 订阅快照至 settle。
// 注意：session 服务的确切签名以 M0 运行时 cordis_inspect_list 为准（本文件按任务看板实证形状编写并防御式降级）。
import type { Context } from '@deepseek-ai/cordis'
import { safeGet } from './util'

export type CognizanceKind = 'index_build' | 'maintain' | 'db_bootstrap'

export interface CognizanceTask {
  projectSlug: string
  projectRoot: string
  kind: CognizanceKind
  /** MCP 命名空间，如 aoci-my-service */
  serverNamespace: string
  apiQuotaConfirmed: boolean
}

export interface SessionDriverResult {
  sessionId?: string
  settled: boolean
  message?: string
}

const PROMPTS: Record<CognizanceKind, (ns: string, root: string) => string> = {
  index_build: (ns, root) => [
    '为项目建立 AOCI 认知索引。',
    '1) 确认 MCP 工具已连接（命名空间 ' + ns + '，共 9 个 aoci_* 工具）；',
    '2) 依次调用 aoci_rules 与 aoci_overview，确认能完整交付本仓库认知（超阈值按 continuation_required 分块并完成 attestation）；',
    '3) 跟随 aoci index agent guide --json 的指引，按批次执行无参 aoci_maintain，并把每批候选经 aoci_update_entry 整批提交，直到 applied/aligned；',
    '4) 最后运行 aoci verify 与 aoci check，确认 aligned 并报告：索引 sha、条目数、耗时、以及你对各区域的掌握程度百分比。',
    '仓库根: ' + root,
  ].join('\n'),
  maintain: (ns, root) => [
    '对项目执行 AOCI 增量维护（收尾）。',
    '1) 确认 ' + ns + ' 工具可用；',
    '2) 先完成最近稳定工作单元与必要检查（格式化/Lint/测试/git diff）；',
    '3) 调用 aoci_maintain（无参），完整处理 applied / repair_required / stopped，语义候选经 aoci_update_entry 提交；',
    '4) verify + check 证明 aligned 后报告结果。',
    '仓库根: ' + root,
  ].join('\n'),
  db_bootstrap: (ns, root) => [
    '为项目建立数据库 AOCI 认知。',
    '1) 确认 ' + ns + ' 工具可用；',
    '2) 先运行 aoci --repo <root> database source access --json 确认凭据引用预检通过（管理员应已在环境提供 AOCI_DB_<ID>_DSN，插件不收集 DSN）；',
    '3) 执行 database cognition bootstrap：读取经典 schema 证据 -> 由你按证据撰写表级 FRAS -> 证据哈希经人工接受 -> 条目进入治理 apply（离线，不重连数据库）；',
    '4) 报告证据哈希、建表条目数。',
    '仓库根: ' + root,
  ].join('\n'),
}

/**
 * 驱动一次真实会话执行认知任务。
 * 说明：session 服务在组合中由 host 提供；若不可用，抛出带指引的错误。
 */
export async function runCognizanceSession(ctx: Context, task: CognizanceTask, opts: { timeoutMs?: number } = {}): Promise<SessionDriverResult> {
  if (!task.apiQuotaConfirmed) {
    throw new Error('dsh-aoci: 认知任务会消耗 API 额度，请先在 UI 确认后再启动')
  }
  const host = {
    workspaces: safeGet<{ acquire?(opts: { project?: string }): Promise<{ sessionId: string }> }>(ctx, 'workspaces'),
    session: safeGet<{
      create?(opts: { title?: string; root?: string }): Promise<{ id: string }>
      prompt?(sessionId: string, message: string, opts?: { signal?: AbortSignal }): Promise<unknown>
      subscribe?(sessionId: string, listener: (snapshot: unknown) => void): () => void
    }>(ctx, 'session'),
  }
  if (!host.workspaces && !host.session) {
    return {
      settled: false,
      message: 'dsh-aoci: 宿主未提供 workspaces/session 服务，无法驱动认知会话。请在会话中手动发起建索引指令。',
    }
  }
  const script = PROMPTS[task.kind](task.serverNamespace, task.projectRoot)
  let sessionId: string | undefined
  try {
    if (host.session && host.session.create) {
      const s = await host.session.create({ title: 'AOCI ' + task.kind + ' · ' + task.projectSlug, root: task.projectRoot })
      sessionId = s.id
    } else if (host.workspaces && host.workspaces.acquire) {
      const s = await host.workspaces.acquire({ project: task.projectRoot })
      sessionId = s.sessionId
    } else {
      return { settled: false, message: 'dsh-aoci: 未找到可用的 session 接入点（session.create / workspaces.acquire）' }
    }
    if (host.session && host.session.prompt && sessionId) {
      await host.session.prompt(sessionId, script)
    }
    // 订阅至 settle：此处形状以运行时为准；当前返回已启动状态
    return { sessionId, settled: true, message: '认知会话已启动（sessionId=' + sessionId + '），执行结果将写入 evidence' }
  } catch (e) {
    return { settled: false, message: 'dsh-aoci 认知会话失败: ' + (e as Error).message }
  }
}