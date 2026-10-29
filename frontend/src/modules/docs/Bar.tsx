// 顶栏（SPEC-library-1.12 到 1.14）：目录名、刷新（本地目录）、分类或文件类型筛选，工作台文档再加标签筛选。
// 写法照原型 library.tsx 的 LibraryBar；外壳给了顶栏位置就送进顶栏。工作台文档最右是「新建文档」（SPEC-library-1.40）。
// 工作台文档还有「全部项目」下拉（SPEC-library-1.51，C-04）。
import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { Button, cls, SearchSelect, TopbarContext, type SearchOption } from '../../core/ui'
import type { LibraryModel } from './model'

export function LibraryBar({ model, kind, onKind, tags, onTags, tagOptions, project, onProject, projectOptions, onRefresh, refreshing, readAt, onNew, creating }: {
  model: LibraryModel
  kind: string
  onKind: (k: string) => void
  tags: string[]
  onTags: (t: string[]) => void
  tagOptions: SearchOption[]
  project: string
  onProject: (p: string) => void
  /** 空数组表示没有项目也没有文档挂在项目上，不显示下拉 */
  projectOptions: SearchOption[]
  onRefresh: () => void
  refreshing: boolean
  /** 本地目录文件清单读到的时间 */
  readAt: string
  onNew: () => void
  /** 正在新建：按钮置灰 */
  creating: boolean
}) {
  const el = useContext(TopbarContext)
  const { folder } = model
  const body = (
    <div className="lib-bar">
      <div className="lib-bar-title">
        <h1 className="ellipsis" title={folder ? `${folder.path}，读取于 ${readAt}` : undefined}>{model.title}</h1>
        {folder && (
          <button type="button" className="icon-btn icon-btn-sm" onClick={onRefresh} disabled={refreshing}
            title="目录里的文件有改动时重新读一遍" aria-label="重新读取目录">
            <svg className={cls(refreshing && 'lib-spin')} viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
      {model.kinds.length > 1 && (
        <div className="filter-row" role="group" aria-label={folder ? '按文件类型筛选' : '按分类筛选'}>
          <button type="button" className={cls('fchip', !kind && 'on')} aria-pressed={!kind} onClick={() => onKind('')}>
            全部<span className="seg-n">{model.docs.length}</span>
          </button>
          {model.kinds.map((k) => (
            <button type="button" key={k.key} className={cls('fchip', kind === k.key && 'on')} aria-pressed={kind === k.key}
              onClick={() => onKind(kind === k.key ? '' : k.key)}>
              {k.label}<span className="seg-n">{k.count}</span>
            </button>
          ))}
        </div>
      )}
      {!folder && tagOptions.length > 0 && (
        <SearchSelect multiple className="lib-tags" value={tags} onChange={onTags} options={tagOptions}
          placeholder="标签" searchPlaceholder="搜标签" aria-label="按标签筛选" align="end"
          title={tags.length ? `同时带这些标签：${tags.join('、')}` : '按标签筛选，选多个时要同时带上'}
          missingLabel={(v) => v} />
      )}
      {!folder && projectOptions.length > 0 && (
        <SearchSelect className="lib-proj-filter" value={project} onChange={onProject} options={projectOptions}
          noneLabel="全部项目" placeholder="全部项目" searchPlaceholder="搜项目" aria-label="按项目筛选" align="end"
          missingLabel={() => '已删除的项目'} />
      )}
      {!folder && (
        <Button variant="primary" size="sm" className="lib-new" onClick={onNew} disabled={creating} title="新建文档">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          <span className="lib-new-text">新建文档</span>
        </Button>
      )}
    </div>
  )
  if (el) return createPortal(body, el)
  return <div className="page-title">{body}</div>
}
