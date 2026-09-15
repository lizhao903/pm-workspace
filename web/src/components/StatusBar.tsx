// 底部状态栏：本地工具要让人对数据有掌控感，所以把 db 路径/体积/写入时间直接摊开。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useWorkspace } from '../hooks/workspace'
import { useShortcuts } from '../views/ShortcutsPage'
import { agentStatusLabel, getAgentStatus, subscribeAgentStatus } from './agent/status'

function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 0) return '刚刚'
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

export default function StatusBar() {
  const { stats, total, loading, nav } = useWorkspace()
  // Agent 状态由 AgentDock 写进一个模块级 store，这里只读
  const agent = useSyncExternalStore(subscribeAgentStatus, getAgentStatus, getAgentStatus)
  const { items: shortcuts, groups } = useShortcuts()
  const onShortcuts = nav.kind === 'page' && nav.page === 'shortcuts'
  // 相对时间要自己走针，否则「3 分钟前」会一直停在渲染那一刻
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      <span className="status-item truncate" title={stats?.db_path ?? ''}>
        {stats?.db_path ?? '—'}
      </span>
      <span className="status-sep">·</span>
      <span className="status-item">{formatBytes(stats?.db_size ?? 0)}</span>
      <span className="status-sep status-optional">·</span>
      <span className="status-item status-optional">对象 {stats?.objects ?? 0}</span>
      <span className="status-sep status-optional">·</span>
      <span className="status-item status-optional">最后写入 {relTime(stats?.last_write ?? null)}</span>

      <span className="status-item status-push">
        {onShortcuts
          ? `快捷入口 ${shortcuts.length} 个 · 分组 ${groups.filter((g) => g.id !== '').length}`
          : `当前列表 ${loading ? '…' : total} 条`}
      </span>
      <span className="status-sep status-optional">·</span>
      <span className="status-item status-optional">{agentStatusLabel(agent)}</span>
    </>
  )
}
