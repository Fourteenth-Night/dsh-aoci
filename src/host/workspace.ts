// 项目与范围治理（设计文档 4.2）
import { execSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { AOCI_MANAGED_ASSETS } from './types'
import { ignoredAociAssets } from './util'

/** 判定 root 是否为 Git 仓库 */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await fs.access(join(root, '.git'), 0)
    return true
  } catch {
    return false
  }
}

/** 读取仓库根 .gitignore；返回误排除 AOCI 认知资产的路径清单（若误配需提示修正） */
export async function checkIgnoreDiscipline(root: string): Promise<string[]> {
  let text: string | undefined
  try {
    text = await fs.readFile(join(root, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  return ignoredAociAssets(text)
}

export { AOCI_MANAGED_ASSETS }

/** 说明文案：Managed Scope 与首个 scan 的固定性 */
export function scanDisciplineHint(): string {
  return '首次 scan 会固定 Managed Scope 角色（scan --force 无法推进）。请确认宿主无关配置不应入库；aoci.txt 等认知资产不要加入 .gitignore（会被 scan 静默跳过）。'
}

/** 当前 git HEAD（非 git 仓库或失败返回 undefined） */
export function gitHead(root: string): string | undefined {
  try { return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined } catch { return undefined }
}

/** 工作区是否有未提交变更（porcelain 非空） */
export function gitDirty(root: string): boolean {
  try { return execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0 } catch { return false }
}

export interface GitDrift {
  head: string | undefined
  dirty: boolean
  changed: string[]
  untracked: string[]
}

/** 相对 sinceHead 的变更集（含工作区未提交与未跟踪文件） */
export function gitDrift(root: string, sinceHead?: string): GitDrift {
  const head = gitHead(root)
  const changed = new Set<string>()
  const untracked: string[] = []
  try {
    if (sinceHead && head && sinceHead !== head) {
      const out = execSync('git diff --name-only ' + sinceHead + '..' + head, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of out.split(/\r?\n/)) if (line.trim()) changed.add(line.trim())
    }
    const out2 = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out2.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      const status = t.slice(0, 2)
      const file = t.slice(3).trim()
      if (!file) continue
      if (status === '??') untracked.push(file)
      else changed.add(file.replace(/^.* -> /, ''))
    }
  } catch {
    /* 非 git 仓库或命令失败时返回空集 */
  }
  return { head, dirty: changed.size > 0 || untracked.length > 0, changed: [...changed], untracked }
}

/** 路径是否位于指定根目录内（大小写不敏感的 Windows 友好比较） */
export function isWithinRoot(root: string, target: string): boolean {
  const a = root.replace(/[\\/]+$/, '').toLowerCase() + (process.platform === 'win32' ? '\\' : '/')
  const b = target.replace(/[\\/]+$/, '').toLowerCase()
  return b === a.replace(/[\\/]$/, '') || b.startsWith(a)
}
