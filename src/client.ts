// dsh-aoci client 半边入口（浏览器）
// 说明：客户端 ctx 同样可能是受限代理（inject 保护）。所有服务访问经 try/catch 安全读取，
// 服务缺失时功能优雅降级（设置页/认知页/面板页不可用时，宿主侧工具与 MCP 仍可用）。
import type { Context } from '@deepseek-ai/cordis'
import { SetupPage } from './client/setup'
import { BoardPage } from './client/board'
import { PanelPage } from './client/panel'

export const name = 'dsh-aoci:client'

type AnyRecord = Record<string, unknown>

function safeProp<T>(ctx: Context, key: string): T | undefined {
  try {
    return (ctx as unknown as AnyRecord)[key] as T
  } catch {
    return undefined
  }
}

function safeLog(ctx: Context, level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  try {
    const logger = safeProp<Record<string, (...a: unknown[]) => void>>(ctx, 'logger')
    logger?.[level]?.(...args)
  } catch { /* 忽略 */ }
}

export const apply = (ctx: Context) => {
  const settingsScope = safeProp<{
    bind?(spec: { namespace: string }): { get(): unknown; set(p: AnyRecord): Promise<void>; watch?(cb: (next: unknown) => void): () => void }
  }>(ctx, 'settingsScope')
  const slots = safeProp<{ register?(name: string, entry: { id: string; order?: number; component: unknown; props?: unknown }): void }>(ctx, 'slots')
  const api = safeProp<{ get?(path: string): Promise<unknown> }>(ctx, 'api')

  try {
    if (slots?.register) {
      slots.register('settings.section', {
        id: 'aoci',
        order: 400,
        component: SetupPage,
        props: { store: settingsScope?.bind?.({ namespace: 'aoci' }) ?? { get: () => undefined, set: async () => undefined } },
      })
      slots.register('sidebar.section:aoci', {
        id: 'aoci-board',
        order: 500,
        component: BoardPage,
        props: {
          fetchProjects: async () => {
            try {
              const res = await api?.get?.('/aoci/api/projects')
              return (res as { projects?: unknown } | null)?.projects ?? []
            } catch { return [] }
          },
        },
      })
      slots.register('sidebar.section:aoci-panel', {
        id: 'aoci-panel',
        order: 510,
        component: PanelPage,
        props: { url: undefined },
      })
    }
  } catch { /* 插槽不可用或签名不符时降级：宿主侧工具与 MCP 仍可用 */ }

  safeLog(ctx, 'info', 'dsh-aoci: client 半边已加载（settings.section + AOCI 认知页 + 面板页）')
}