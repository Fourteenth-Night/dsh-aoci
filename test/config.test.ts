import { describe, expect, it } from 'vitest'
import { AociConfigSchema, type AociConfig } from '../src/host/config'

describe('AociConfigSchema', () => {
  it('默认值与缺省派生', () => {
    const value = AociConfigSchema({}) as unknown as AociConfig
    expect(value.binaryPath).toBe('C:/aoci/bin/aoci.exe')
    expect(value.projects).toEqual([])
    expect(value.mcp.toolCallTimeoutMs).toBe(120000)
  })
  it('project 默认值', () => {
    const value = AociConfigSchema({ projects: [{ root: '/r' }] }) as unknown as AociConfig
    expect(value.projects[0]?.slug).toBeUndefined()
    expect(value.projects[0]?.schedule?.cron).toBe('0 3 * * *')
    expect(value.projects[0]?.chunkTokens).toBe(7000)
  })
})
