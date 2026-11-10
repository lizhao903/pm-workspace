// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 数据与备份：库在哪、多大、schema 是什么版本、怎么拿走。
// 本地单文件工具的信任基础在这一页——用户要能确认自己的数据没被锁在工具里。
import { useCallback, useEffect, useState } from 'react'
import { useWorkspace } from '../../hooks/workspace'
import { api } from '../../lib/api'
import type { BackupInfo, MigrationRecord, Stats } from '../../lib/types'
import { Button, RelativeTime, formatDateTime } from '../../components/ui'
import { SectionHead, useAsyncAction } from './common'

function formatBytes(n: number): string {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export default function DataSection() {
  const { stats: wsStats } = useWorkspace()
  const { busy, error, run } = useAsyncAction()

  const [stats, setStats] = useState<Stats | null>(wsStats)
  const [migrations, setMigrations] = useState<MigrationRecord[]>([])
  const [migLoaded, setMigLoaded] = useState(false)
  const [backup, setBackup] = useState<BackupInfo | null>(null)

  const load = useCallback(async () => {
    try { setStats(await api.stats()) } catch { /* 读失败保留 workspace 里那份 */ }
    try { setMigrations(await api.migrations()) } catch { setMigrations([]) } finally { setMigLoaded(true) }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="st-sec">
      <SectionHead
        title="数据与备份"
        desc="这个工作台的全部数据都在一个 SQLite 文件里。这一页告诉你它在哪、有多大、schema 是哪个版本，以及怎么随时把它完整拿走。"
        actions={<Button small disabled={busy} onClick={() => void load()}>刷新</Button>}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="st-card">
        <div className="card-title">数据库</div>
        <div className="kv st-kv">
          <span className="faint">文件路径</span>
          <span className="mono st-break">{stats?.db_path || '—'}</span>
          <span className="faint">文件体积</span>
          <span>{stats ? formatBytes(stats.db_size) : '—'}</span>
          <span className="faint">工作对象数</span>
          <span>{stats?.objects ?? '—'}</span>
          <span className="faint">最后写入</span>
          <span>
            {stats?.last_write
              ? <>{formatDateTime(stats.last_write)} <span className="faint">（<RelativeTime value={stats.last_write} />）</span></>
              : '—'}
          </span>
          <span className="faint">程序版本</span>
          <span className="mono">{stats?.version || '—'}</span>
        </div>
      </div>

      <div className="st-card">
        <div className="card-title">
          迁移版本
          <span className="faint st-title-note">每条迁移的 checksum 都记在库里；版本对得上，才说明这个库的 schema 和当前程序匹配</span>
        </div>
        {!migLoaded ? <div className="skeleton v-sk v-sk-title" /> : null}
        {migLoaded && migrations.length === 0 ? (
          <div className="faint st-pad">暂时读不到迁移记录。</div>
        ) : null}
        {migrations.length > 0 ? (
          <div className="v-table-wrap">
            <table className="v-table st-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>checksum</th>
                  <th>应用时间</th>
                </tr>
              </thead>
              <tbody>
                {migrations.map((m) => (
                  <tr key={m.version}>
                    <td className="mono">{m.version}</td>
                    <td className="mono faint" title={m.checksum}>{m.checksum.slice(0, 8)}</td>
                    <td>{formatDateTime(m.applied_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="st-card">
        <div className="card-title">快照</div>
        <p className="faint st-note">
          在库文件旁边的 backups/ 目录里复制出一个完整副本（VACUUM INTO），不影响正在跑的实例。改动大的操作之前先拍一张。
        </p>
        <div className="st-inline-acts st-left">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void run(async () => { setBackup(await api.snapshot()) })}
          >
            {busy ? '生成中…' : '立即快照'}
          </Button>
          {backup ? (
            <span className="muted">
              已生成：<span className="mono st-break">{backup.path}</span>（{formatBytes(backup.size)}）
            </span>
          ) : null}
        </div>
      </div>

      <div className="st-card">
        <div className="card-title">导出</div>
        <p className="faint st-note">
          导出是防数据锁定的保证：JSON 保留完整结构，可以喂给别的工具；Markdown 是人能直接读的纯文本，
          即使这个工作台哪天没了，导出的文件在任何编辑器里照样打得开。
        </p>
        <div className="st-inline-acts st-left">
          {/* 直接开新窗口下载，不走 fetch：浏览器要接管 Content-Disposition */}
          <Button onClick={() => window.open(api.exportUrl('json'))}>导出 JSON</Button>
          <Button onClick={() => window.open(api.exportUrl('markdown'))}>导出 Markdown</Button>
        </div>
      </div>
    </div>
  )
}
