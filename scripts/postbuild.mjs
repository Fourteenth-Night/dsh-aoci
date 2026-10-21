// 构建后把 skill 资源拷入 lib（供 dsh.plugin.json contributes.skills 引用）
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
for (const name of ['SKILL.md', 'SKILL.en.md']) {
  const src = join(root, 'src/skill', name)
  const dst = join(root, 'lib/skill', name)
  if (existsSync(src)) {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    console.log('copied ' + name + ' -> lib/skill/' + name)
  } else {
    console.warn(name + ' not found, skip')
  }
}