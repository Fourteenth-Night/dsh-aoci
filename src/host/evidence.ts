// 证据账本（设计文档 4.8）：state/aoci/ 下 projects.json + runs.jsonl + evidences/*.json
// 写入纪律：串行队列 + 临时文件回读校验 + 原子替换（对标 dsh-task-board 持久化）。
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProjectRecord, TaskRun } from './types'

export interface EvidenceLedger {
  version: number
  projects: ProjectRecord[]
}

export class EvidenceStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly dir: string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private static async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  private static async atomicWrite(file: string, data: string): Promise<void> {
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
    await fs.writeFile(tmp, data, 'utf8')
    const back = await fs.readFile(tmp, 'utf8') // 回读校验
    if (back !== data) throw new Error('evidence 临时文件回读校验失败: ' + file)
    await fs.rename(tmp, file)
  }

  async loadProjects(): Promise<ProjectRecord[]> {
    return this.serial(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const ledger = await EvidenceStore.readJson<EvidenceLedger>(join(this.dir, 'projects.json'), { version: 1, projects: [] })
      return ledger.projects
    })
  }

  async saveProjects(projects: ProjectRecord[]): Promise<void> {
    return this.serial(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      await EvidenceStore.atomicWrite(join(this.dir, 'projects.json'), JSON.stringify({ version: 1, projects }, null, 2))
    })
  }

  async upsertProject(record: ProjectRecord): Promise<void> {
    // 单层串行 + 底层读写：不得嵌套调用本类的其他 serial 方法（会循环等待）
    return this.serial(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const file = join(this.dir, 'projects.json')
      const ledger = await EvidenceStore.readJson<EvidenceLedger>(file, { version: 1, projects: [] })
      const i = ledger.projects.findIndex((p) => p.slug === record.slug)
      if (i >= 0) ledger.projects[i] = record
      else ledger.projects.push(record)
      await EvidenceStore.atomicWrite(file, JSON.stringify({ version: 1, projects: ledger.projects }, null, 2))
    })
  }

  async appendRun(run: TaskRun): Promise<void> {
    return this.serial(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.appendFile(join(this.dir, 'runs.jsonl'), JSON.stringify(run) + '\n', 'utf8')
      if (run.evidence) {
        // 证据内容由调用方落盘（verify/check --json 原样），此处仅登记引用
      }
    })
  }

  async readRuns(limit = 200): Promise<TaskRun[]> {
    return this.serial(async () => {
      try {
        const text = await fs.readFile(join(this.dir, 'runs.jsonl'), 'utf8')
        const lines = text.split('\n').filter(Boolean).slice(-limit)
        return lines.map((l) => JSON.parse(l) as TaskRun)
      } catch {
        return []
      }
    })
  }
}