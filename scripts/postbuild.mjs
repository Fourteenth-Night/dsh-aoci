// 构建后把 skill 资源拷入 lib（供 dsh.plugin.json contributes.skills 引用）
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const src = join(root, 'src/skill/SKILL.md')
const dst = join(root, 'lib/skill/SKILL.md')
if (existsSync(src)) {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  console.log('copied SKILL.md -> lib/skill/SKILL.md')
} else {
  console.warn('SKILL.md not found, skip')
}
