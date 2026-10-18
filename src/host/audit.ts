// 治理审计（方向 4）：结构化事件账本 + 可读报告（FRAS 溯源/漂移/时间线）
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export type AuditAction = 'bind' | 'unbind' | 'init' | 'scan' | 'maintain' | 'verify' | 'check' | 'refresh' | 'audit' | 'db_preflight'

export interface AuditEvent {
  ts: string
  action: AuditAction
  project?: string
  ok: boolean
  exitCode?: number | null
  durationMs?: number
  head?: string
  detail?: string
  session?: string
}

export async function appendAudit(stateDir: string, ev: AuditEvent): Promise<void> {
  try {
    await fs.mkdir(stateDir, { recursive: true })
    await fs.appendFile(join(stateDir, 'aoci-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8')
  } catch {
    /* 审计写入失败不阻塞主流程 */
  }
}

export async function readAudit(stateDir: string, limit = 120): Promise<AuditEvent[]> {
  try {
    const text = await fs.readFile(join(stateDir, 'aoci-events.jsonl'), 'utf8')
    return text.split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as AuditEvent)
  } catch {
    return []
  }
}

/** 生成可读审计报告（供 aoci_audit 工具返回） */
export function formatAuditReport(project: string, opts: {
  events: AuditEvent[]
  head?: string
  lastHead?: string
  aligned?: boolean
  verifyText?: string
  checkText?: string
  governance?: string
}): string {
  const lines: string[] = []
  lines.push('# AOCI 审计报告 · ' + project)
  lines.push('治理级别: ' + (opts.governance ?? 'standard') + ' · HEAD: ' + (opts.head ?? 'n/a') + (opts.lastHead && opts.lastHead !== opts.head ? '（上次维护于 ' + opts.lastHead.slice(0, 12) + '…，存在漂移）' : '（与维护基线一致）'))
  lines.push('aligned: ' + (opts.aligned === undefined ? 'unknown' : String(opts.aligned)))
  lines.push('')
  lines.push('## verify')
  lines.push(opts.verifyText?.slice(0, 1500) ?? '(未运行)')
  lines.push('')
  lines.push('## check')
  lines.push(opts.checkText?.slice(0, 1500) ?? '(未运行)')
  lines.push('')
  lines.push('## 最近事件（' + opts.events.length + ' 条）')
  for (const e of opts.events.slice(-30)) {
    lines.push('- ' + e.ts + ' · ' + e.action + (e.ok ? ' ✅' : ' ❌') + (e.exitCode !== undefined && e.exitCode !== null ? ' exit=' + e.exitCode : '') + (e.project ? ' · ' + e.project : '') + (e.detail ? ' · ' + e.detail.slice(0, 120) : ''))
  }
  return lines.join('\n')
}
