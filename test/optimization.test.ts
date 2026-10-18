// 优化项纯函数单测（v0.2.0：工具面/预算/审计/刷新/二进制校验）
import { describe, it, expect, afterEach } from 'vitest'
import { compareVersions, parseAociVersion, sanitizedEnv, compactToolResult, estimateToolSurfaceChars, parseAociInput } from '../src/host/util'
import { foldPolicy } from '../src/host/compaction'
import { formatAuditReport } from '../src/host/audit'
import { buildRefreshPlan } from '../src/host/refresh'
import { AociConfigSchema } from '../src/host/config'

describe('版本比较与解析', () => {
  it('compareVersions 处理主版本与预发布', () => {
    expect(compareVersions('0.1.0-rc21', '0.1.0-rc18')).toBe(1)
    expect(compareVersions('0.1.0-rc18', '0.1.0-rc21')).toBe(-1)
    expect(compareVersions('0.1.0-rc18', '0.1.0-rc18')).toBe(0)
    expect(compareVersions('0.2.0', '0.1.0-rc21')).toBe(1)
  })
  it('parseAociVersion 从输出提取版本', () => {
    expect(parseAociVersion('aoci version 0.1.0-rc21 (windows/amd64)')).toBe('0.1.0-rc21')
    expect(parseAociVersion('no version here')).toBeUndefined()
  })
})

describe('环境白名单', () => {
  const key = 'DSH_TEST_SECRET_DO_NOT_FORWARD'
  afterEach(() => { delete process.env[key] })
  it('透传系统变量与 AOCI_DB_*，剥离任意密钥', () => {
    process.env[key] = 'secret'
    process.env['AOCI_DB_PRIMARY_DSN'] = 'ref'
    process.env['PATH'] = process.env['PATH'] || 'C:\\Windows'
    const env = sanitizedEnv()
    expect(env[key]).toBeUndefined()
    expect(env['AOCI_DB_PRIMARY_DSN']).toBe('ref')
    expect(env['PATH']).toBeTruthy()
  })
  it('显式 extra 允许透传', () => {
    process.env['MY_ALLOWED'] = 'ok'
    const env = sanitizedEnv(['MY_ALLOWED'])
    expect(env['MY_ALLOWED']).toBe('ok')
    delete process.env['MY_ALLOWED']
  })
})

describe('结果整形与工具面估算', () => {
  it('compactToolResult 提取 text 并截断', () => {
    expect(compactToolResult(JSON.stringify({ text: 'hello' }))).toBe('hello')
    const long = 'x'.repeat(7000)
    const out = compactToolResult(JSON.stringify({ text: long }))
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('truncated')
  })
  it('estimateToolSurfaceChars 随工具数增长', () => {
    const a = estimateToolSurfaceChars([{ name: 'x', description: 'd' }])
    const b = estimateToolSurfaceChars([{ name: 'x', description: 'd' }, { name: 'y', description: 'd' }])
    expect(b).toBeGreaterThan(a)
  })
})

describe('预算折叠策略', () => {
  const budget = { warn: 0.6, fold: 0.75, compact: 0.9 }
  it('按压力分档', () => {
    expect(foldPolicy(undefined, budget)).toBe('none')
    expect(foldPolicy(0.5, budget)).toBe('none')
    expect(foldPolicy(0.8, budget)).toBe('fold')
    expect(foldPolicy(0.95, budget)).toBe('fold+compact')
  })
})

describe('审计报告', () => {
  it('包含 HEAD/漂移/事件', () => {
    const text = formatAuditReport('demo', {
      events: [{ ts: '2026-01-01T00:00:00Z', action: 'verify', ok: true, project: 'demo' }],
      head: 'a'.repeat(40), lastHead: 'b'.repeat(40), aligned: false, governance: 'strict',
    })
    expect(text).toContain('AOCI 审计报告')
    expect(text).toContain('存在漂移')
    expect(text).toContain('verify')
    expect(text).toContain('strict')
  })
})

describe('增量刷新计划', () => {
  it('非 git 路径也返回结构化计划', () => {
    const plan = buildRefreshPlan('C:/definitely/not/a/git/repo', undefined, { governance: 'strict' })
    expect(plan.dirty).toBe(false)
    expect(plan.instruction).toContain('AOCI 增量刷新')
    expect(plan.instruction).toContain('aoci_verify')
  })
})

describe('配置默认值', () => {
  it('compact/governance/readOnly/预算默认', () => {
    const cfg = AociConfigSchema({}) as unknown as { toolSurface: string; governance: string; readOnly: boolean; httpRoutes: boolean; budget: { fold: number } }
    expect(cfg.toolSurface).toBe('compact')
    expect(cfg.governance).toBe('standard')
    expect(cfg.readOnly).toBe(false)
    expect(cfg.httpRoutes).toBe(false)
    expect(cfg.budget.fold).toBe(0.75)
  })
})

describe('解析标志（保留）', () => {
  it('--db/--skip-scan', () => {
    expect(parseAociInput('D:/r --db primary --skip-scan')).toEqual({ path: 'D:/r', db: 'primary', skipScan: true })
  })
})