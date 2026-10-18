// 共享仓库定位（/aoci 无参与 aoci_cognition 懒绑定共用）：
// 会话 cwd → 上溯父目录 → defaultRoot → 最近绑定项目
import { promises as fsP } from 'node:fs'
import { join } from 'node:path'

export async function isGitRepository(root: string): Promise<boolean> {
  try { await fsP.access(join(root, '.git')); return true } catch { return false }
}

export interface LocateOptions {
  cwd?: string
  defaultRoot?: string
  recent?: Array<{ root: string; updatedAt?: string }>
  maxParents?: number
}

export async function locateRepo(opts: LocateOptions): Promise<string | undefined> {
  const seen = new Set<string>()
  const check = async (p: string | undefined): Promise<string | undefined> => {
    if (!p) return undefined
    const norm = p.replace(/[\\/]+$/, '')
    if (!norm || seen.has(norm.toLowerCase())) return undefined
    seen.add(norm.toLowerCase())
    return (await isGitRepository(norm)) ? norm : undefined
  }
  // 1) cwd
  const cwdHit = await check(opts.cwd)
  if (cwdHit) return cwdHit
  // 2) 上溯父目录
  if (opts.cwd) {
    let p = opts.cwd.replace(/[\\/]+$/, '')
    const max = opts.maxParents ?? 8
    for (let i = 0; i < max; i++) {
      const parent = p.replace(/[\\/][^\\/]+$/, '')
      if (!parent || parent === p) break
      const hit = await check(parent)
      if (hit) return hit
      p = parent
    }
  }
  // 3) defaultRoot
  const rootHit = await check(opts.defaultRoot)
  if (rootHit) return rootHit
  // 4) 最近绑定项目（按 updatedAt 倒序）
  for (const p of [...(opts.recent ?? [])].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))) {
    const hit = await check(p.root)
    if (hit) return hit
  }
  return undefined
}
