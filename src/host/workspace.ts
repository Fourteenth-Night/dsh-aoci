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
