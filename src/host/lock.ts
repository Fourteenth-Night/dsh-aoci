// 并发锁（P1）：同一仓库同一时刻只允许一个会话做正式写操作
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface LockInfo {
  pid: number
  session?: string
  acquiredAt: string
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function acquireLock(stateDir: string, slug: string, session?: string): Promise<{ ok: boolean; holder?: LockInfo }> {
  const dir = join(stateDir, 'locks')
  try { await fs.mkdir(dir, { recursive: true }) } catch { /* ignore */ }
  const file = join(dir, slug + '.lock')
  try {
    const info = JSON.parse(await fs.readFile(file, 'utf8')) as LockInfo
    if (info.pid !== process.pid && alive(info.pid)) return { ok: false, holder: info }
  } catch { /* 无锁或已损坏 */ }
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, session, acquiredAt: new Date().toISOString() } satisfies LockInfo), 'utf8')
  return { ok: true }
}

export async function releaseLock(stateDir: string, slug: string): Promise<void> {
  const file = join(stateDir, 'locks', slug + '.lock')
  try {
    const info = JSON.parse(await fs.readFile(file, 'utf8')) as LockInfo
    if (info.pid === process.pid) await fs.unlink(file)
  } catch { /* ignore */ }
}
