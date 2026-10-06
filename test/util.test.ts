import { describe, expect, it } from 'vitest'
import {
  slugFromRoot, defaultCredentialEnv, mcpServerName, buildMcpEntry,
  cronMatch, parsePanelLink, ignoredAociAssets, parseAociInput,
} from '../src/host/util'

describe('slugFromRoot', () => {
  it('取 basename 并规整为 [a-z0-9-]', () => {
    expect(slugFromRoot('D:/code/My_Service')).toBe('my-service')
    expect(slugFromRoot('C:/a/b/')).toBe('b')
    expect(slugFromRoot('/')).toBe('repo')
  })
})

describe('defaultCredentialEnv', () => {
  it('由 sourceId 派生凭据引用', () => {
    expect(defaultCredentialEnv('primary')).toBe('AOCI_DB_PRIMARY_DSN')
    expect(defaultCredentialEnv('a.b')).toBe('AOCI_DB_A_B_DSN')
  })
})

describe('buildMcpEntry', () => {
  it('生成 stdio dsh-mcp-client 条目并与九工具命名空间一致', () => {
    const entry = buildMcpEntry({ root: 'D:/code/demo' }, 'C:/aoci/bin/aoci.exe')
    expect(entry.config.transport).toBe('stdio')
    expect(entry.config.args).toEqual(['--repo', 'D:/code/demo', 'mcp'])
    expect(entry.config.toolCallTimeoutMs).toBe(120000)
    expect(mcpServerName('aoci', slugFromRoot('D:/code/demo'))).toBe('aoci-demo')
  })
  it('DB 源透传凭据引用（只传环境变量名）', () => {
    const entry = buildMcpEntry({ root: '/r', dbSources: [{ sourceId: 'primary', engine: 'postgresql' }] }, '/bin/aoci')
    expect(entry.config.env).toEqual({ AOCI_DB_PRIMARY_DSN: '' })
  })
})

describe('cronMatch（5 段）', () => {
  const at = (min: number, h = 0, d = 1, mon = 1) => new Date(2026, mon - 1, d, h, min) // 本地时间构造，匹配 cron 的本地墙钟语义
  it('* * * * * 恒真', () => { expect(cronMatch('* * * * *', at(5))).toBe(true) })
  it('0 3 * * * 每天 03:00', () => {
    expect(cronMatch('0 3 * * *', at(0, 3))).toBe(true)
    expect(cronMatch('0 3 * * *', at(1, 3))).toBe(false)
  })
  it('*/15 支持步长', () => { expect(cronMatch('*/15 * * * *', at(0))).toBe(true); expect(cronMatch('*/15 * * * *', at(7))).toBe(false) })
  // 2026-01-04 为周日(dow=0)：dom 不匹配但 dow 匹配 => 并集命中
  it('DOM/DOW 任一受限时取并', () => { expect(cronMatch('0 0 1 * 0', at(0, 0, 4, 1))).toBe(true) })
  it('非法字段抛错', () => { expect(() => cronMatch('0 0 * * * *', new Date())).toThrow() })
})

describe('parsePanelLink', () => {
  it('json url/port 防御式解析', () => {
    expect(parsePanelLink('{"url":"http://127.0.0.1:18800","port":18800}')).toEqual({ url: 'http://127.0.0.1:18800', port: 18800 })
    expect(parsePanelLink('not json')).toEqual({})
  })
})

describe('ignoredAociAssets', () => {
  it('发现误排除 AOCI 认知资产的行', () => {
    expect(ignoredAociAssets('aoci.txt\n*.code.txt\nnode_modules/').sort()).toEqual(['aoci.code.txt', 'aoci.txt']) // sort 字典序
  })
})

describe('parseAociInput', () => {
  it('解析路径与标志', () => {
    const f = parseAociInput('D:/code/x --locale zh-CN --scope full --skip-scan --agent claude')
    expect(f.path).toBe('D:/code/x')
    expect(f.locale).toBe('zh-CN')
    expect(f.scope).toBe('full')
    expect(f.skipScan).toBe(true)
    expect(f.agent).toBe('claude')
  })
  it('无路径返回空对象', () => {
    expect(parseAociInput('--skip-scan')).toEqual({ skipScan: true })
    expect(parseAociInput('')).toEqual({})
  })
})
