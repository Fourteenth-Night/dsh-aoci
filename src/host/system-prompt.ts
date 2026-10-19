// 认知纪律段（设计文档 4.10）：经 ctx.systemPrompt.section 注入 AOCI 工作纪律
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectConfig } from './types'
import { safeGet } from './util'

export function installSystemPrompt(ctx: Context, projects: ProjectConfig[], opts: { surface?: 'compact' | 'full'; governance?: 'strict' | 'standard' | 'relaxed'; readOnly?: boolean; surfacePrefix?: string } = {}) {
  const sys = safeGet<{ section(opts: { name: string; order: number; text: string }): void }>(ctx, 'systemPrompt')
  if (!sys) return
  const summaries = projects.map((p) => {
    const slug = p.slug || p.root
    return '- ' + slug + ' (' + p.root + '): 开工先 aoci_rules + 完整 aoci_overview；收尾按 aoci_maintain 纪律'
  }).join('\n')

  sys.section({
    name: 'aoci:cognition',
    order: 300,
    text: [
      'AOCI 认知纪律（由 dsh-aoci 插件注入）：',
      summaries || '（暂无已配置的 AOCI 项目；可在设置中添加 Git 仓库）',
      '1) 会话开始、接手任务或压缩后，先建立/恢复系统认知：aoci_rules 一次 + aoci_overview 一次（全量，按 continuation_required 分块并 attestation）；',
      '2) 业务收尾顺序：格式化 -> Lint/测试 -> git diff -> aoci_maintain(无参) -> 整批 aoci_update_entry -> verify/check 证明 aligned；',
      '3) 压缩后：重新加载 aoci_rules；以 context_compaction + 幂等 refresh_event_id 声明；完成一次完整 Overview 与 attestation（check_only 不是替代品）；',
      '4) 维护完成后再修改任何受管文件，会使旧维护结果失效，须重新维护；',
      '5) 语义（F/R/A/S、标签、Curation）必须由你阅读真实源码后生成——禁止用 AST/import 扫描/正则/模板/脚本代写。',
      opts.surface === 'compact' ? '6) 工具面为 compact：认知维护工具经聚合入口 aoci_call（tool=工具名, args=参数）调用；查询类用 aoci_query（kind=relations/impact/lineage/db）。' : '6) 工具面为 full：九个 AOCI 工具直接暴露为 mcp__aoci-<slug>__<tool>。',
      opts.governance === 'strict' ? '7) 治理级别 strict：维护后必须 aoci_verify 与 aoci_check 均通过，否则不得声称 aligned。' : '7) 治理级别 ' + (opts.governance ?? 'standard') + '：维护后建议 verify/check。',
      opts.readOnly ? '8) 只读模式已开启：禁止 init/scan/maintain 等写操作。' : '',
      '9) 建索引顺序：aoci_overview（完整）→ attestation → maintain → 分批 update_entry → verify/check → guide。Volumes v1 仓库只能用 MCP 的 aoci_maintain/aoci_update_entry（经 aoci_cognition），不要用 legacy index/scope/onboard 命令。',
      '10) Entry 契约：filename[tag]: F≤160 | R≤360(≤8项)- | A≤400(≤6项)- | S 按重要度(C9-8≤600/C7-4≤200/C3-1≤50 tokens)；标签 A+B+C+[D]+E；先用 aoci_cognition action="validate" 预校验。',
    ].join('\n'),
  })
}