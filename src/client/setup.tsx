// AOCI 设置页（settings.section）：项目添加（Git 仓库根）、二进制路径、DB 数据源、调度
import React, { useEffect, useState } from 'react'

export interface SetupPageProps {
  store?: {
    get(): unknown
    set(patch: Record<string, unknown>): Promise<void>
    watch?(cb: (next: unknown) => void): () => void
  }
}

const inputStyle: React.CSSProperties = { width: '100%', margin: '4px 0', padding: '4px 6px', boxSizing: 'border-box' }

export function SetupPage(props: SetupPageProps) {
  const store = props.store
  const [value, setValue] = useState<any>(() => (store ? store.get() : undefined))

  useEffect(() => {
    if (!store?.watch) return
    const dispose = store.watch((next) => setValue(next))
    return dispose
  }, [store])

  const projects: any[] = value?.projects ?? []

  const addProject = () => {
    const root = window.prompt('Git 仓库根绝对路径（例如 D:/code/my-service）')
    if (!root) return
    const next = { ...value, projects: [...projects, { root }] }
    setValue(next)
    void store?.set(next)
  }

  const removeProject = (i: number) => {
    const next = { ...value, projects: projects.filter((_, j) => j !== i) }
    setValue(next)
    void store?.set(next)
  }

  return (
    <div style={{ padding: '12px', gap: '8px', display: 'flex', flexDirection: 'column', fontSize: 13 }}>
      <h4 style={{ margin: 0 }}>AOCI 认知层</h4>
      <label>aoci 二进制（稳定绝对路径；从官方 Release 下载并校验，插件不捆绑）</label>
      <input style={inputStyle} value={value?.mcp?.binaryPath ?? value?.binaryPath ?? ''}
        onChange={(e) => { const next = { ...value, binaryPath: e.target.value }; setValue(next); void store?.set(next) }} />
      <label>项目（Git 仓库根）</label>
      {projects.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <code style={{ flex: 1 }}>{p.root}</code>
          <button onClick={() => removeProject(i)}>移除</button>
        </div>
      ))}
      <button onClick={addProject}>+ 添加项目</button>
      <p style={{ color: '#888', margin: 0 }}>
        添加项目后：插件将执行 aoci init + scan 建立 Baseline，并生成 dsh-mcp-client 条目（mcp__aoci-&lt;slug&gt;__* 九工具）。
        数据库认知需先在环境提供 AOCI_DB_&lt;ID&gt;_DSN 凭据引用。
      </p>
    </div>
  )
}
