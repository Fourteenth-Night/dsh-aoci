// 二进制安全校验（方向 7）：SHA-256 + 版本检查 + 结果缓存（避免每次启动重复哈希大文件）
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { runAoci } from './cli'
import { sha256File } from './aoci-bin'
import { compareVersions, parseAociVersion } from './util'

export interface BinaryVerification {
  ok: boolean
  path: string
  version?: string
  sha256?: string
  reason?: string
  cached?: boolean
}

export async function verifyAociBinary(
  ctx: Context,
  path: string,
  opts: { expectedSha256?: string; minVersion?: string; stateDir: string },
): Promise<BinaryVerification> {
  let st
  try {
    st = await fs.stat(path)
  } catch {
    return { ok: false, path, reason: '二进制不存在: ' + path }
  }
  const cacheFile = join(opts.stateDir, 'binary.json')
  let cache: { path?: string; mtimeMs?: number; size?: number; sha256?: string; version?: string } | undefined
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')) } catch { cache = undefined }
  const cacheHit = cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.sha256

  let sha256 = cacheHit ? cache!.sha256 : undefined
  let version = cacheHit ? cache!.version : undefined
  if (!cacheHit) {
    sha256 = await sha256File(path)
    const out = await runAoci(ctx, { argv: [path, '--version'], timeoutMs: 20000 })
    version = parseAociVersion((out.stdout || '') + '\n' + (out.stderr || ''))
    try {
      await fs.mkdir(opts.stateDir, { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify({ path, mtimeMs: st.mtimeMs, size: st.size, sha256, version, verifiedAt: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* 缓存写失败不阻塞 */ }
  }

  if (opts.expectedSha256 && sha256 && sha256.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
    return { ok: false, path, version, sha256, reason: 'SHA-256 与配置不符（期望 ' + opts.expectedSha256.slice(0, 12) + '…，实际 ' + sha256.slice(0, 12) + '…）' }
  }
  if (opts.minVersion && version && compareVersions(version, opts.minVersion) < 0) {
    return { ok: false, path, version, sha256, reason: 'aoci 版本 ' + version + ' 低于最低要求 ' + opts.minVersion + '，请从官方 Release 升级' }
  }
  return { ok: true, path, version, sha256, cached: !!cacheHit }
}
