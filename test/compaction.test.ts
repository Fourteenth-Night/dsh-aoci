import { describe, expect, it } from 'vitest'
import { compactAociResults } from '../src/host/compaction'

describe('compactAociResults', () => {
  const ns = 'aoci-demo'
  const blocks = [
    { type: 'text', text: '用户问题' },
    { type: 'tool_result', toolName: 'mcp__aoci-demo__aoci_overview', text: '[Whole-Index 正文...]' },
    { type: 'tool_result', toolName: 'mcp__aoci-demo__aoci_maintain', text: '{"applied":true}' },
    { type: 'text', text: '结论' },
  ]
  it('把大工具结果折叠为 receipt，保留前后普通内容', () => {
    const out = compactAociResults(blocks, { serverNamespace: ns, refreshEventId: 'evt-1' })
    expect(out.length).toBe(3)
    expect(out[0]!.text).toBe('用户问题')
    expect(out[1]!.text).toContain('[AOCI]')
    expect(out[1]!.text).toContain('refreshEventId')
    expect(out[1]!.text).toContain('aoci-demo')
    expect(out[2]!.text).toBe('结论')
  })
  it('不折叠普通文本块', () => {
    const out = compactAociResults([{ type: 'text', text: '普通' }], { serverNamespace: ns, refreshEventId: 'x' })
    expect(out).toHaveLength(1)
  })
})
