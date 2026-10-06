// 沙箱安全日志：ctx.logger 不在宿主沙箱白名单，经 safeGet(ctx,'logger') 读取；不可用时静默降级
import { safeGet } from './util'

export interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const silent: LoggerLike = { info() {}, warn() {}, error() {} }

export function safeLogger(ctx: unknown): LoggerLike {
  return safeGet<LoggerLike>(ctx, 'logger') ?? silent
}
