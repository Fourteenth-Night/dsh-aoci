// AOCI 只读面板页：iframe 指向 /aoci/panel/:slug 或直连 loopback 链接（同源代理在 M2 完善）
import React from 'react'

export function PanelPage({ url, title }: { url?: string; title?: string }) {
  if (!url) return <p style={{ padding: 12, color: '#888', fontSize: 13 }}>面板未启动。请先在宿主执行 aoci ui --detach --json 或经由插件打开。</p>
  return (
    <iframe
      title={title ?? 'AOCI panel'}
      src={url}
      style={{ width: '100%', height: '100%', border: 0 }}
      sandbox="allow-scripts allow-same-origin"
    />
  )
}
