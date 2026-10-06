// AOCI 认知页：项目列表 / aligned 状态 / 条目 / 最近 Run 证据
import React, { useEffect, useState } from 'react'

export interface ProjectSummary {
  slug: string
  root: string
  aligned: boolean
  entries: number
  baselineEstablished: boolean
  mcpConnected: boolean
  dbEnabled: boolean
  updatedAt: string
}

const cardStyle: React.CSSProperties = { border: '1px solid #333', borderRadius: 8, padding: '10px', margin: '8px 0' }

export function BoardPage({ fetchProjects }: { fetchProjects?: () => Promise<ProjectSummary[]> }) {
  const [items, setItems] = useState<ProjectSummary[]>([])
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!fetchProjects) return
    fetchProjects().then(setItems).catch((e) => setError((e as Error).message))
  }, [fetchProjects])

  return (
    <div style={{ padding: '12px', fontSize: 13 }}>
      <h4 style={{ margin: 0 }}>AOCI 认知（code + database）</h4>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
      {items.length === 0 && <p style={{ color: '#888' }}>暂无项目。前往设置添加 Git 仓库后建立索引。</p>}
      {items.map((p) => (
        <div key={p.slug} style={cardStyle}>
          <strong>{p.slug}</strong> <span style={{ color: '#888' }}>{p.root}</span>
          <div>状态: {p.aligned ? 'aligned' : 'dirty/未对齐'} · 条目 {p.entries} · 基线 {p.baselineEstablished ? '已建立' : '未建立'}</div>
          <div>MCP: {p.mcpConnected ? '已连接' : '未连接'} · 数据库认知: {p.dbEnabled ? '已启用' : '未启用'}</div>
          <div style={{ color: '#888' }}>updatedAt: {p.updatedAt}</div>
        </div>
      ))}
    </div>
  )
}
