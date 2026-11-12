// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 选本机目录（FS-01）：任务工作目录、项目目录、文档挂载共用。走后端 /api/fs/browse，拿到的是绝对路径。
// 侧边是起跳点（主目录、外挂分区、额外可浏览目录等），右边是路径输入、面包屑和子目录；越界时显示后端的中文原因。
// 不从 ui/index 导出：它要取数，ui 的其余部分不依赖 core/data。
import { useState, type ReactNode } from 'react'
import { errorText, fsCrumbs, useFsBrowse, useFsShortcuts } from '../data'
import { Button } from './Button'
import { cls } from './cls'
import './dirPicker.css'

/** 浏览部分，路径受控：父组件要拿当前目录时用同一个 path 调 useFsBrowse，缓存是同一份 */
export function DirBrowser({ path, onPath, hideHidden, listHeight }: {
  path: string
  onPath: (p: string) => void
  /** 不列 . 开头的目录（挂载时隐藏目录挂不了） */
  hideHidden?: boolean
  /** 子目录列表的最大高度，默认 220 */
  listHeight?: number
}) {
  const list = useFsBrowse(path, true)
  const shortcuts = useFsShortcuts(true)
  const cur = list.isError ? undefined : list.data
  const dirs = (cur?.entries.filter((e) => e.is_dir) ?? []).filter((d) => !hideHidden || !d.name.startsWith('.'))
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? cur?.path ?? path
  const go = () => {
    const p = shown.trim()
    setTyped(null)
    if (p) onPath(p)
  }
  const crumbs = cur ? fsCrumbs(cur.path, cur.root) : []

  return (
    <div className="dp">
      {!!shortcuts.data?.length && (
        <ul className="dp-side" aria-label="起跳点">
          {shortcuts.data.map((s) => (
            <li key={s.path}>
              <button type="button" title={s.path} className={cls('dp-jump', cur?.path === s.path && 'on')}
                onClick={() => { setTyped(null); onPath(s.path) }}>{s.label}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="dp-main">
        <div className="dp-go">
          <input className="input mono-input" aria-label="目录路径" spellCheck={false} value={shown}
            placeholder="输入或粘贴绝对路径，回车前往"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }} />
          <Button size="sm" variant="outline" onClick={go}>前往</Button>
        </div>
        <div className="dp-crumbs" aria-label="所在位置">
          <Button size="sm" variant="ghost" disabled={!cur?.parent} onClick={() => cur && onPath(cur.parent)}>上一级</Button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="dp-crumb">
              {i > 0 && <span className="dp-sep" aria-hidden="true">/</span>}
              {i === crumbs.length - 1
                ? <span className="dp-here" aria-current="location" title={c.path}>{c.label}</span>
                : <button type="button" className="dp-link" title={c.path} onClick={() => onPath(c.path)}>{c.label}</button>}
            </span>
          ))}
          {!cur && <span className="dp-here">{path || '...'}</span>}
        </div>
        {list.isError
          ? <div className="field-err" role="alert">{errorText(list.error)}</div>
          : (
            <ul className="dp-list" aria-label="子目录" style={{ maxHeight: listHeight ?? 220 }}>
              {list.isPending && <li className="dp-muted">加载中</li>}
              {cur && !dirs.length && <li className="dp-muted">没有子目录</li>}
              {dirs.map((d) => (
                <li key={d.path}>
                  <button type="button" className="dp-item" onClick={() => { setTyped(null); onPath(d.path) }}>{d.name}</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

/** 带「取消 / 选这个目录」的完整选择器 */
export function DirPicker({ start, onPick, onClose, foot, className }: {
  start: string
  onPick: (path: string) => void
  onClose: () => void
  /** 按钮左边的提示，拿到当前目录（可能还没读出来） */
  foot?: (writable: boolean | undefined) => ReactNode
  className?: string
}) {
  const [path, setPath] = useState(start)
  const list = useFsBrowse(path, true)
  const cur = list.isError ? undefined : list.data
  return (
    <div className={cls('dp-picker', className)} role="group" aria-label="选择目录"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
      <DirBrowser path={path} onPath={setPath} />
      <div className="dp-foot">
        {foot?.(cur?.writable)}
        <span className="spacer" />
        <Button size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" variant="primary" disabled={!cur} onClick={() => cur && onPick(cur.path)}>选这个目录</Button>
      </div>
    </div>
  )
}
