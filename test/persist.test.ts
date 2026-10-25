import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const { sweepSpy } = vi.hoisted(() => ({ sweepSpy: vi.fn(async () => ({ removed: 0, bytes: 0 })) }))
vi.mock('../src/host/paths', async (orig) => {
  const actual = await orig<typeof import('../src/host/paths')>()
  return { ...actual, sweepTmp: (...args: unknown[]) => sweepSpy(...(args as [])) }
})

const { persistOversized, TOOL_RESULT_LIMIT } = await import('../src/host/persist')

const dirs: string[] = []
const makeState = () => {
  const d = mkdtempSync(join(tmpdir(), 'aoci-persist-'))
  dirs.push(d)
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('persistOversized', () => {
  // 必须放在最前：模块级 lastSweep 只会在首次大结果落盘时触发一次清理。
  it('机会式清理真的会执行，并在 10 分钟内节流（回归：不能写在 return 之后）', () => {
    const stateDir = makeState()
    expect(sweepSpy.mock.calls.length).toBe(0)
    persistOversized(stateDir, 'demo', 'aoci_overview', 'B'.repeat(TOOL_RESULT_LIMIT + 1))
    expect(sweepSpy.mock.calls.length).toBe(1)
    persistOversized(stateDir, 'demo', 'aoci_overview', 'C'.repeat(TOOL_RESULT_LIMIT + 1))
    expect(sweepSpy.mock.calls.length).toBe(1)
  })

  it('大结果把完整正文落盘，元数据描述的是原文（不再返回截断正文）', () => {
    const stateDir = makeState()
    const text = 'A'.repeat(TOOL_RESULT_LIMIT + 1234)
    const out = persistOversized(stateDir, 'demo', 'aoci_overview', text)
    const file = /body_file=(.+)/.exec(out)?.[1]?.trim()
    expect(file).toBeTruthy()
    const onDisk = readFileSync(file as string, 'utf8')
    expect(onDisk).toBe(text)
    expect(out).toContain('body_bytes=' + Buffer.byteLength(text, 'utf8'))
    expect(out).toContain('body_sha256=' + createHash('sha256').update(text, 'utf8').digest('hex'))
  })

  it('小结果原样返回，不落盘', () => {
    const stateDir = makeState()
    const text = '{"ok":true}'
    expect(persistOversized(stateDir, 'demo', 'aoci_maintain', text)).toBe(text)
  })
})
