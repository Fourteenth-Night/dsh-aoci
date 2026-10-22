#!/usr/bin/env node
// AOCI MCP 驱动脚本（0.2.7）：零依赖，直接用原生 JSON-RPC over stdio 驱动 `aoci --repo <path> mcp`。
// 不需要 @modelcontextprotocol/sdk，因此任何 Node.js（含系统 node）都能运行。
// 关键：overview 与 attestation 必须在同一个 MCP 进程内完成（否则会丢 delivery 状态）。
// 用法：
//   单次：  node scripts/aoci-mcp-driver.mjs --repo <仓库> aoci_rules
//           node scripts/aoci-mcp-driver.mjs --repo <仓库> aoci_maintain '{}'
//   预设：  node scripts/aoci-mcp-driver.mjs --repo <仓库> --preset read|overview|maintain|optimize
//   序列：  node scripts/aoci-mcp-driver.mjs --repo <仓库> --steps steps.json
//   参数：  --args '<json>' 或 --args-file <file>（也可用 @file 作为位置参数）
//   选项：  --out-dir <目录>（默认 <DSH_HOME>/state/aoci/tmp 或系统临时目录） --clean（结束后清理输出目录）
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = { repo: process.cwd(), outDir: '', clean: false, steps: '', tool: '', args: '{}', preset: '' }
const pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--repo') opt.repo = argv[++i]
  else if (a === '--out-dir') opt.outDir = argv[++i]
  else if (a === '--clean') opt.clean = true
  else if (a === '--steps') opt.steps = argv[++i]
  else if (a === '--tool') opt.tool = argv[++i]
  else if (a === '--args') opt.args = argv[++i]
  else if (a === '--args-file') opt.args = '@' + argv[++i]
  else if (a === '--preset') opt.preset = argv[++i]
  else pos.push(a)
}
if (!opt.tool && pos.length) opt.tool = pos[0]
if ((opt.args === '{}' || !opt.args) && pos.length > 1) opt.args = pos[1]
if (opt.args && opt.args.startsWith('@')) opt.args = readFileSync(opt.args.slice(1), 'utf8')

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const profile = process.env.DSH_PROFILE
const aociState = profile ? join(dshHome, 'profiles', profile, 'state', 'aoci') : join(dshHome, 'state', 'aoci')
const outDir = opt.outDir || join(aociState, 'tmp')
mkdirSync(outDir, { recursive: true })
const stamp = Date.now()
const aociBin = process.env.AOCI_BIN || 'C:/aoci/bin/aoci.exe'

// 不要继承父进程的 console 句柄：DSH 桌面端父进程常无 console（AllocConsole 隐藏控制台失败时），
// 继承 stderr 会让 CreateProcess 报 0x800700E8（ERROR_BROKEN_PIPE，“管道正在被关闭”）。全部走管道。
const child = spawn(aociBin, ['--repo', opt.repo, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let stderrTail = ''
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4000) })
child.on('error', (err) => {
  console.error('aoci mcp 启动失败: ' + err.message + (stderrTail ? '\nstderr: ' + stderrTail : ''))
  process.exit(3)
})
const rl = createInterface({ input: child.stdout })
let seq = 0
const pending = new Map()
rl.on('line', (line) => {
  const t = line.trim()
  if (!t.startsWith('{')) return
  let msg
  try { msg = JSON.parse(t) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg)
  }
})
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve })
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 请求超时: ' + method)) }, 120000)
  pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m) } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const writeOut = (name, text) => {
  const file = join(outDir, stamp + '-' + name + '.json')
  writeFileSync(file, text, 'utf8')
  return file
}
const call = async (tool, args) => {
  const res = await request('tools/call', { name: tool, arguments: args ?? {} })
  if (res.error) { console.error('MCP error: ' + JSON.stringify(res.error)); process.exit(1) }
  const content = res.result?.content ?? []
  const text = content.map((c) => c.text ?? '').join('')
  const file = writeOut(tool, text)
  console.log('=== ' + tool + ' (saved: ' + file + ') ===')
  console.log(text)
  return text
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'dsh-aoci-driver', version: '0.3.4' },
})
if (init.error) { console.error('initialize failed: ' + JSON.stringify(init.error)); process.exit(1) }
notify('notifications/initialized', {})

const presets = {
  read: [{ tool: 'aoci_rules' }, { tool: 'aoci_overview' }, { tool: 'aoci_header' }],
  overview: [{ tool: 'aoci_rules' }, { tool: 'aoci_overview' }],
  maintain: [{ tool: 'aoci_maintain' }],
  optimize: [{ tool: 'aoci_maintain', args: { intent: 'cognition_optimization' } }],
}
if (opt.preset) {
  if (!presets[opt.preset]) { console.error('未知 preset: ' + opt.preset + '（可用: ' + Object.keys(presets).join('|') + '）'); process.exit(2) }
  for (const step of presets[opt.preset]) await call(step.tool, step.args)
} else if (opt.steps) {
  const steps = JSON.parse(readFileSync(opt.steps, 'utf8'))
  for (const step of steps) await call(step.tool, step.args)
} else if (opt.tool) {
  await call(opt.tool, JSON.parse(opt.args || '{}'))
} else {
  console.error('用法: node aoci-mcp-driver.mjs --repo <仓库> <tool> [argsJson] | --preset read|overview|maintain|optimize | --steps steps.json')
  process.exit(2)
}
child.stdin.end()
child.kill()
if (opt.clean) rmSync(outDir, { recursive: true, force: true })
process.exit(0)