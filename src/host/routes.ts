// /aoci/* 同源 loopback 路由 + 面板反代（设计文档 4.8）
// 路由仅绑 harness 已有 FetchHandler；拒绝浏览器传入文件路径，只读。
import type { Context } from '@deepseek-ai/cordis'
import type { EvidenceStore } from './evidence'
import { parsePanelLink, safeGet } from './util'

export interface AociRoutesDeps {
  store: EvidenceStore
  /** 返回某项目的面板 URL（来自 aoci ui --detach --json 解析结果） */
  panelUrlFor(projectSlug: string): string | undefined
}

interface HttpSeam {
  get?(path: string, handler: (req: Request) => Promise<Response>): void
  router?: { get?(path: string, handler: (req: Request) => Promise<Response>): void }
}

export function installRoutes(ctx: Context, deps: AociRoutesDeps) {
  const http = safeGet<HttpSeam>(ctx, 'http')
  if (!http) return // 未挂载 dsh-host-webserver 时跳过，功能降级为仅工具/会话可用

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

  const handler = (fn: () => Promise<unknown>) => async () => {
    try {
      const result = await fn()
      return json(result)
    } catch (e) {
      return json({ error: (e as Error).message }, 500)
    }
  }

  const reg = (path: string, h: (req: Request) => Promise<Response>) => {
    if (http.get) http.get(path, h)
    else if (http.router?.get) http.router.get(path, h)
  }

  reg('/aoci/api/projects', handler(async () => (await deps.store.loadProjects()).map(p => ({
    slug: p.slug, root: p.root, aligned: p.index.aligned, entries: p.index.entries,
    baselineEstablished: p.index.baseline.established, mcpConnected: p.mcp.connected,
    dbEnabled: p.database.enabled, updatedAt: p.updatedAt,
  }))))
  reg('/aoci/api/panel/:slug', async (req) => {
    // :slug 从 URL 解析；面板只读反代：把 aoci ui 的 loopback 页面转发（GET/HEAD）
    const slug = decodeURIComponent(req.url.split('/').pop() || '')
    const target = deps.panelUrlFor(slug)
    if (!target) return json({ error: 'panel unavailable' }, 404)
    // 反代实现（仅回环、GET/HEAD）在 M2 完善；此处先返回目标供 iframe 直接使用
    return json({ url: target }, 200)
  })
  reg('/aoci/api/runs', handler(async () => deps.store.readRuns()))

  // SSE：多标签页变更同步（M2；事件名以运行时为准）
  return undefined
}