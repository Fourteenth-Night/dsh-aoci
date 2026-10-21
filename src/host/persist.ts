// 大结果落盘：模型可见的工具结果超过阈值时，完整正文写入 state/aoci/tmp，
// 只返回元数据 + 预览（避免 compactToolResult 的 6000 字符截断导致 attestation 无法完成）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const TOOL_RESULT_LIMIT = 6000

export function persistOversized(stateDir: string | undefined, slug: string, tool: string, text: string, limit = TOOL_RESULT_LIMIT): string {
  if (!stateDir || text.length <= limit) return text
  try {
    const tmp = join(stateDir, 'aoci', 'tmp')
    mkdirSync(tmp, { recursive: true })
    const file = join(tmp, slug + '-' + tool + '-' + Date.now() + '.txt')
    writeFileSync(file, text, 'utf8')
    const sha = createHash('sha256').update(text, 'utf8').digest('hex')
    const tail = text.trimEnd().slice(-300)
    const endMarker = /end[_ -]?marker|<!--\s*aoci:end\s*-->/i.test(tail) || tail.endsWith('END')
    return '[aoci] ' + tool + ' 结果过大（' + text.length + ' chars > ' + limit + '），完整正文已保存：\n' +
      'body_file=' + file + '\n' +
      'body_sha256=' + sha + '\n' +
      'body_bytes=' + Buffer.byteLength(text, 'utf8') + '\n' +
      'end_marker=' + (endMarker ? 'present' : 'unknown') + '\n' +
      '请用 read 工具分段读取 body_file 获取完整正文（offset/limit），attestation 的 delivery confirmation 使用上述 sha256/bytes/end_marker。\n\n[HEAD 预览]\n' + text.slice(0, 4000)
  } catch {
    return text
  }
}
