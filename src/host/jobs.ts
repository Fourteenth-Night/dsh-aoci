// 后台任务与调度（设计文档 4.6）：确定性 verify/check/scan 走 ctx.jobs；夜间健康检查按 5 段 cron
import type { Context } from '@deepseek-ai/cordis'
import { cronMatch } from './util'
import type { ProjectConfig } from './types'

export interface NightlyGuardOpts {
  /** 返回 true 表示本日该仓库已执行过 verify（幂等去重） */
  alreadyRanToday(projectSlug: string, day: string): boolean
  markRan(projectSlug: string, day: string): void
  runVerify(project: ProjectConfig): Promise<void>
}

/** 浏览器心跳式 tick：60s 一次；命中 cron 且当日未跑则执行（应用退出后调度不承诺继续） */
export function createNightlyGuard(opts: NightlyGuardOpts) {
  return {
    tick(project: ProjectConfig, now: Date = new Date()): 'ran' | 'skip' | 'duplicate' {
      const cron = project.schedule?.cron || '0 3 * * *'
      if (!cronMatch(cron, now)) return 'skip'
      const day = now.toISOString().slice(0, 10)
      if (opts.alreadyRanToday(project.slug || project.root, day)) return 'duplicate'
      opts.markRan(project.slug || project.root, day)
      void opts.runVerify(project)
      return 'ran'
    },
  }
}

/** ctx.jobs 环境下注册确定性后台任务（kind 前缀 aoci-*）；无 ctx.jobs 时静默跳过 */
export function registerJobs(ctx: Context, run: (kind: string, project: ProjectConfig, cwd: string) => Promise<void>) {
  const jobs = (ctx as unknown as { jobs?: { start(kind: string, label: string, run: () => Promise<void>): string } }).jobs
  if (!jobs) return
  // 示例：scan / verify / check 三种确定性任务，均由调用方（工具/调度）触发
  for (const kind of ['scan', 'verify', 'check'] as const) {
    jobs.start('aoci-' + kind, 'AOCI ' + kind, async () => {
      // 实际项目由调用方经闭包绑定；此处为注册占位，运行期通过 run() 注入
    })
  }
}
