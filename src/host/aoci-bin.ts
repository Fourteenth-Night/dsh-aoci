// aoci 二进制生命周期：存在性/版本/自检（设计文档 4.1）
// 许可约束：FSL-1.1-MIT 下不捆绑二进制；本模块只负责"定位 + 校验 + 引导下载提示"。
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

export interface BinaryInfo {
  path: string
  exists: boolean
  version?: string
  sha256?: string
}

export function sha256File(file: string): Promise<string> {
  return fs.readFile(file).then((buf) => {
    const hash = createHash('sha256')
    hash.update(buf)
    return hash.digest('hex')
  })
}

export async function inspectBinary(binaryPath: string): Promise<BinaryInfo> {
  const info: BinaryInfo = { path: binaryPath, exists: false }
  try {
    const st = await fs.stat(binaryPath)
    if (!st.isFile()) return info
    info.exists = true
    info.sha256 = await sha256File(binaryPath)
  } catch {
    return info
  }
  return info
}

/** 引导提示：如何从官方 Release 获取并校验（SHA-256），作为 UI/日志文案 */
export function installHint(release = 'v0.1.0-rc18'): string {
  return [
    '未找到 aoci 二进制。请从官方 Release 获取并校验后放到稳定路径：',
    '  gh release download ' + release + ' --repo aoci-spec/aoci-code --pattern \'*windows*\'',
    '  解压 -> 建议放置 C:\\aoci\\bin\\aoci.exe -> 运行 aoci --version 与 aoci capabilities 自检',
    '（插件不捆绑二进制：AOCI-CODE 采用 FSL-1.1-MIT source-available 许可）',
  ].join('\n')
}
