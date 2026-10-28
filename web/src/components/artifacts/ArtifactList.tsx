// 产物列表。产物页和对象详情抽屉共用同一个组件。
//
// 共用是有意的：两处各写一份的话，「本地和云端同时有」这种形状总有一处显示不对，
// 而显示不对的那一处看上去只是「少了个图标」。
import { useCallback, useState } from 'react'
import { api } from '../../lib/api'
import type { Artifact } from '../../lib/types'
import { ARTIFACT_SOURCE_LABELS } from '../../lib/types'
import { Button, ConfirmDialog, RelativeTime } from '../ui'
import { platformColor, platformLabel, usePlatforms } from './platforms'

/** 人读的体积。云端产物 size 恒为 0，那不是「空文件」，所以显示成横杠而不是 0 B。 */
export function formatSize(bytes: number, hasPath: boolean): string {
  if (!hasPath) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  items: Artifact[]
  /** 抽屉里已经知道归属了，不用每行再显示一遍 */
  showObject?: boolean
  onEdit: (a: Artifact) => void
  onChanged: () => void
  emptyHint?: string
}

export default function ArtifactList({ items, showObject = true, onEdit, onChanged, emptyHint }: Props) {
  const platforms = usePlatforms()
  const [deleting, setDeleting] = useState<Artifact | null>(null)
  const [busy, setBusy] = useState(false)

  const doDelete = useCallback(async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await api.deleteArtifact(deleting.id)
      setDeleting(null)
      onChanged()
    } finally {
      setBusy(false)
    }
  }, [deleting, onChanged])

  if (items.length === 0) {
    return <div className="ar-empty faint">{emptyHint ?? '还没有登记任何产物。'}</div>
  }

  return (
    <>
      <ul className="ar-list">
        {items.map((a) => (
          <li key={a.id} className="ar-item">
            <div className="ar-item-main">
              <div className="ar-item-head">
                <span
                  className="ar-platform"
                  style={{ background: platformColor(a.platform, platforms) }}
                  title={`平台：${platformLabel(a.platform, platforms)}`}
                >
                  {platformLabel(a.platform, platforms)}
                </span>
                {/* 只有链接、没填标题时，后端会把标题兜底成链接本身。
                    那种情况下这里不再重复显示一遍——下面的链接行已经是它了。 */}
                {a.title && a.title !== a.url && a.title !== a.path ? (
                  <span className="ar-title truncate" title={a.title}>{a.title}</span>
                ) : null}
                {showObject && (
                  a.object_ref
                    ? <span className="faint ar-scope truncate">{a.object_ref} {a.object_title}</span>
                    // 未归属要显式说出来。留空的话它看起来只是「这一列没数据」，
                    // 而它其实是硬删对象之后产物失去归属的唯一痕迹。
                    : <span className="ar-unscoped">未归属</span>
                )}
              </div>

              {/* 本地和云端都有时两行都出：这一行的用处就是让人能点过去或打开，
                  只显示其中一个等于替用户决定他现在想去哪边。 */}
              <div className="ar-item-loc">
                {a.url && (
                  <a className="ar-link truncate" href={a.url} target="_blank" rel="noreferrer" title={a.url}>
                    {a.url}
                  </a>
                )}
                {a.path && (
                  <span className="ar-path truncate" title={a.path}>
                    {a.rel_path || a.path}
                  </span>
                )}
              </div>

              {a.note && <div className="faint ar-note truncate">{a.note}</div>}
            </div>

            <div className="ar-item-meta">
              <span className="faint">{ARTIFACT_SOURCE_LABELS[a.source] ?? a.source}</span>
              <span className="faint">{formatSize(a.size, a.path !== '')}</span>
              <RelativeTime value={a.updated_at} />
            </div>

            <div className="ar-item-actions">
              <Button small onClick={() => onEdit(a)}>编辑</Button>
              <Button small variant="danger" onClick={() => setDeleting(a)}>删除</Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={deleting !== null}
        title="删除这条产物登记？"
        confirmText="删除登记"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      >
        {/* 这句必须写清楚。用户看到「删除」默认会以为文件也没了，
            而实际上磁盘上的文件和云端的页面都还在——不说清的话，
            他要么不敢删，要么删完以为东西已经清理干净了。 */}
        <p>只删掉工作台里的这条记录。<strong>磁盘上的文件和云端的页面都不会动。</strong></p>
        <p className="faint">{deleting?.title}</p>
      </ConfirmDialog>
    </>
  )
}
