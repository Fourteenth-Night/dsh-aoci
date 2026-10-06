// AOCI 压缩契约 × dsh-compaction（设计文档 4.7）
// 契约要点：压缩交接不得保留/摘要 Whole-Index/Overview/Entry/Challenge/Attestation 正文；
// 恢复业务前须重载 aoci_rules，声明 context_compaction + 幂等 refresh_event_id，完成一次完整 Overview + Attestation。
import type { Context } from '@deepseek-ai/cordis'
import { safeLogger } from './logger'

export interface AociReceipt {
  kind: 'aoci-receipt'
  serverNamespace: string
  indexSha?: string
  refreshEventId: string
  instruction: string
}

/** 纯函数：把会话历史中 mcp__<ns>__aoci_* 的大工具结果替换为 AOCI receipt + 重载指令。
 *  用于压缩摘要生成阶段，保证 Whole-Index 正文不进入压缩交接物。 */
export function compactAociResults(blocks: Array<{ type: string; text?: string; toolName?: string }>, opts: { serverNamespace: string; refreshEventId: string }): Array<{ type: string; text?: string; toolName?: string }> {
  const out: Array<{ type: string; text?: string; toolName?: string }> = []
  let replaced = 0
  for (const b of blocks) {
    const tool = b.toolName
    const isAociTool = !!tool && tool.includes('aoci-') && tool.includes('__aoci_')
    if (isAociTool || (b.type === 'tool_result' && b.text && /aoci_(overview|get_entries|search|maintain)/.test(b.text.slice(0, 200)))) {
      if (replaced === 0) {
        const receipt: AociReceipt = {
          kind: 'aoci-receipt',
          serverNamespace: opts.serverNamespace,
          refreshEventId: opts.refreshEventId,
          instruction: '压缩后恢复业务前：重新加载 aoci_rules；以 refresh_event_id=' + opts.refreshEventId + ' 声明 context_compaction；完成一次完整 Overview（按 continuation_required 分块）+ Attestation。',
        }
        out.push({ type: 'text', text: '[AOCI] ' + JSON.stringify(receipt) })
      }
      replaced += 1
      continue
    }
    out.push(b)
  }
  return out
}

/** 在 dsh-compaction 事件上挂接恢复指令注入（事件名 'compaction/start'/'compaction/end'；以运行时 cordis_inspect 为准） */
export function installAociCompactionGuard(ctx: Context, opts: { serverNamespace: string; refreshEventId: () => string }) {
  const emitter = ctx as unknown as { on?: (event: string, cb: (...args: unknown[]) => void) => void }
  if (!emitter.on) return
  emitter.on('compaction/end', () => {
    const guidance = [
      '[AOCI] 检测到上下文压缩。按 AOCI 压缩契约：',
      '1) 若 aoci_rules 不再可靠，先重新加载；',
      '2) 以 refresh_event_id=' + opts.refreshEventId() + ' 声明 context_compaction；',
      '3) 完成一次完整 Overview 光标、确认与 attestation（check_only 不是替代品）。',
    ].join('\n')
    safeLogger(ctx).info(guidance)
  })
}