// AOCI 运行期目录布局（0.3.4）：所有调试/临时/证据/缓存/审计文件统一收敛到 state/aoci 下，
// 禁止写工作区或仓库；tmp 支持 TTL + 配额清理。
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface TmpStats { dir: string; files: number; bytes: number; oldestMs?: number }

export function tmpDir(stateDir: string, slug?: string): string {
  return slug ? join(stateDir, 'tmp', slug) : join(stateDir, 'tmp')
}
export function evidenceDir(stateDir: string): string { return join(stateDir, 'evidence') }
export function cacheDir(stateDir: string): string { return join(stateDir, 'cache') }
export function locksDir(stateDir: string): string { return join(stateDir, 'locks') }
export function auditFile(stateDir: string): string { return join(stateDir, 'audit', 'aoci-events.jsonl') }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else out.push(p)
  }
  return out
}

/** 统计 tmp 目录：文件数/字节数/最旧文件时间 */
export async function tmpStats(stateDir: string): Promise<TmpStats> {
  const dir = tmpDir(stateDir)
  const files = await walk(dir)
  let bytes = 0
  let oldestMs: number | undefined
  for (const f of files) {
    try {
      const st = await fs.stat(f)
      bytes += st.size
      if (oldestMs === undefined || st.mtimeMs < oldestMs) oldestMs = st.mtimeMs
    } catch { /* ignore */ }
  }
  return { dir, files: files.length, bytes, oldestMs }
}

export interface SweepOptions { maxAgeMs?: number; maxBytes?: number }
export interface SweepResult { removed: number; bytes: number }

/** 清理 tmp：按 TTL（默认 7 天）+ 总大小上限（默认 200MB，删最旧） */
export async function sweepTmp(stateDir: string, opts: SweepOptions = {}): Promise<SweepResult> {
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600 * 1000
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024
  const files = await walk(tmpDir(stateDir))
  const now = Date.now()
  const metas: Array<{ f: string; size: number; mtime: number }> = []
  let removed = 0
  let freed = 0
  for (const f of files) {
    try {
      const st = await fs.stat(f)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.unlink(f)
        removed++
        freed += st.size
      } else {
        metas.push({ f, size: st.size, mtime: st.mtimeMs })
      }
    } catch { /* ignore */ }
  }
  const total = metas.reduce((n, m) => n + m.size, 0)
  if (total > maxBytes) {
    metas.sort((a, b) => a.mtime - b.mtime)
    let cur = total
    for (const m of metas) {
      if (cur <= maxBytes) break
      try { await fs.unlink(m.f); removed++; freed += m.size; cur -= m.size } catch { /* ignore */ }
    }
  }
  // 清理空目录（tmp/<slug>）
  try {
    const slugDirs = await fs.readdir(tmpDir(stateDir), { withFileTypes: true })
    for (const d of slugDirs) {
      if (!d.isDirectory()) continue
      const p = join(tmpDir(stateDir), d.name)
      try { if ((await fs.readdir(p)).length === 0) await fs.rmdir(p) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { removed, bytes: freed }
}

/** 清空 tmp（/aoci --clean 用） */
export async function cleanTmp(stateDir: string): Promise<SweepResult> {
  const stats = await tmpStats(stateDir)
  try { await fs.rm(tmpDir(stateDir), { recursive: true, force: true }) } catch { /* ignore */ }
  return { removed: stats.files, bytes: stats.bytes }
}
