#!/usr/bin/env node
// AOCI MCP 驱动脚本：解决"会话工具集看不到 mcp__aoci-* 工具"时的兜底路径。
// 关键：overview 与 attestation 必须在同一个 MCP 进程内完成（否则会丢 delivery 状态）。
// 用法：
//   单次：  node scripts/aoci-mcp-driver.mjs --repo <仓库> aoci_rules
//           node scripts/aoci-mcp-driver.mjs --repo <仓库> aoci_maintain '{}'
//   序列：  node scripts/aoci-mcp-driver.mjs --repo <仓库> --steps steps.json
//           steps.json = [{"tool":"aoci_overview","args":{"refresh_event_id":"..."}},{"tool":"attestation",...}]
//   选项：  --out-dir <目录>（默认 <DSH_HOME>/state/aoci/tmp 或系统临时目录） --clean（结束后清理输出目录）
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const argv = process.argv.slice(2)
const opt = { repo: process.cwd(), outDir: '', clean: false, steps: '', tool: '', args: '{}' }
const pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--repo') opt.repo = argv[++i]
  else if (a === '--out-dir') opt.outDir = argv[++i]
  else if (a === '--clean') opt.clean = true
  else if (a === '--steps') opt.steps = argv[++i]
  else if (a === '--tool') opt.tool = argv[++i]
  else if (a === '--args') opt.args = argv[++i]
  else pos.push(a)
}
if (!opt.tool && pos.length) opt.tool = pos[0]
if (!opt.args && pos.length > 1) opt.args = pos[1]
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const outDir = opt.outDir || (join(dshHome, 'state', 'aoci', 'tmp'))
mkdirSync(outDir, { recursive: true })
const stamp = Date.now()
const writeOut = (name, text) => {
  const file = join(outDir, stamp + '-' + name + '.json')
  writeFileSync(file, text, 'utf8')
  return file
}
const aociBin = process.env.AOCI_BIN || 'C:/aoci/bin/aoci.exe'
const transport = new StdioClientTransport({ command: aociBin, args: ['--repo', opt.repo, 'mcp'], env: process.env, stderr: 'pipe' })
const client = new Client({ name: 'dsh-aoci-driver', version: '0.2.5' }, { capabilities: {} })
await client.connect(transport)
const call = async (tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args ?? {} })
  const text = (res.content ?? []).map((c) => c.text ?? '').join('')
  const file = writeOut(tool, text)
  console.log('=== ' + tool + ' (saved: ' + file + ') ===')
  console.log(text)
  return text
}
if (opt.steps) {
  const steps = JSON.parse(readFileSync(opt.steps, 'utf8'))
  for (const step of steps) await call(step.tool, step.args)
} else if (opt.tool) {
  await call(opt.tool, JSON.parse(opt.args || '{}'))
} else {
  console.error('用法: node aoci-mcp-driver.mjs --repo <仓库> <tool> [argsJson] | --steps steps.json')
  process.exit(2)
}
await client.close()
if (opt.clean) rmSync(outDir, { recursive: true, force: true })
process.exit(0)
