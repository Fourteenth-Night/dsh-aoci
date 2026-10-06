// client 半边构建：tsdown CJS + __ModuleLoader__.load 包裹（DSH 前端 Lazy CJS 协议）
import { build } from 'tsdown'
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({ entry: ['src/client.ts'], format: 'cjs', outDir: join(root, 'lib-tmp'), clean: true })

const cjs = readFileSync(join(root, 'lib-tmp', 'client.cjs'), 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({',
  "  id: 'dsh-aoci',",
  '  factory: (__dsh_require__) => {',
  '    const module = { exports: {} }',
  '    ;(function (require, module, exports, __filename, __dirname) {',
  cjs,
  "    })(__dsh_require__, module, module.exports, 'client.js', '.')",
  '    return module.exports',
  '  }',
  '})',
  '',
].join('\n')

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), wrapped)

const skill = join(root, 'src/skill/SKILL.md')
if (existsSync(skill)) {
  mkdirSync(join(root, 'lib/skill'), { recursive: true })
  copyFileSync(skill, join(root, 'lib/skill/SKILL.md'))
}
rmSync(join(root, 'lib-tmp'), { recursive: true, force: true })
console.log('client bundle wrapped -> lib/client.js (' + Buffer.byteLength(wrapped) + ' bytes)')
