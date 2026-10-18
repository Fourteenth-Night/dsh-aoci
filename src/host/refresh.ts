// 增量刷新计划（方向 1）：用 git 变更集替代全量 rebuild，提示 AI 只维护受影响条目
import type { Context } from '@deepseek-ai/cordis'
import { gitDrift } from './workspace'

export interface RefreshPlan {
  head?: string
  sinceHead?: string
  changed: string[]
  untracked: string[]
  dirty: boolean
  instruction: string
}

export function buildRefreshPlan(
  root: string,
  sinceHead?: string,
  opts: { governance?: 'strict' | 'standard' | 'relaxed'; maxFiles?: number; namespace?: string } = {},
): RefreshPlan {
  const drift = gitDrift(root, sinceHead)
  const maxFiles = opts.maxFiles ?? 60
  const files = [...drift.changed, ...drift.untracked].slice(0, maxFiles)
  const truncated = drift.changed.length + drift.untracked.length > maxFiles
  const basis = sinceHead && drift.head && sinceHead !== drift.head ? sinceHead + '..' + drift.head + ' 的提交变更 + 工作区变更' : '工作区未提交变更'
  const strict = (opts.governance ?? 'standard') === 'strict'
  const instruction = [
    'AOCI 增量刷新（' + basis + '）' + (drift.dirty ? '，共 ' + drift.changed.length + ' 个已跟踪文件变更、' + drift.untracked.length + ' 个未跟踪文件' : '，无变更') + '。',
    files.length ? '变更文件（最多 ' + maxFiles + ' 个' + (truncated ? '，已截断，其余请自行 git status 补全' : '') + '）：' : '变更文件：无',
    ...files.map((f) => '- ' + f),
    '',
    '请按以下顺序维护（不要重建整仓）：',
    '1) 若本会话尚未加载认知：先 aoci_rules + 一次完整 aoci_overview（超传输阈值跟 cursor 到 completed=true 并 attestation）。',
    '2) 针对上述变更文件，找到其职责/关联条目，逐项阅读真实源码后生成语义候选。',
    '3) 无参 aoci_maintain → 完整处理 applied / repair_required / stopped → 整批 aoci_update_entry（保留 source_sha256 绑定）。',
    strict ? '4) 严格治理：必须 aoci_verify 且 aoci_check 均通过，否则不得声称 aligned。' : '4) 建议 aoci_verify / aoci_check 证明 aligned。',
    '5) 仅有文档/注释变更时可声明无条目变更，但仍需 aoci_verify 说明。',
  ].join('\n')
  return { head: drift.head, sinceHead, changed: drift.changed, untracked: drift.untracked, dirty: drift.dirty, instruction }
}
