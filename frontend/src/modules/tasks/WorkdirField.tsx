// 工作目录：可以手填，也可以用 /api/fs/browse 选；改动后停手片刻就用 /api/agent/workdir/check 校验（SPEC-tasks-4.27）。
import { useEffect, useId, useState } from 'react'
import { useFsBrowse, useFsShortcuts, useWorkdirCheck, workdirUsable } from '../../core/api/taskEdit'
import { Button, cls } from '../../core/ui'

// 停手多久再校验
const CHECK_DELAY = 400

export function WorkdirField({ value, onChange, inherit }: {
  value: string
  onChange: (v: string) => void
  /** 所属项目的工作目录，任务没设时继承它 */
  inherit?: { project: string; dir: string }
}) {
  const labelId = useId()
  const [checked, setChecked] = useState(value.trim())
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    const p = value.trim()
    if (p === checked) return
    const id = setTimeout(() => setChecked(p), CHECK_DELAY)
    return () => clearTimeout(id)
  }, [value, checked])
  const check = useWorkdirCheck(checked)
  const typing = value.trim() !== checked

  let hint = null
  if (!value.trim()) {
    hint = inherit
      ? <span className="field-hint-line">没设时用所属项目「{inherit.project}」的目录</span>
      : null
  } else if (!typing && check.data) {
    hint = workdirUsable(check.data)
      ? <span className="field-hint-line wd-ok">目录可用</span>
      : <span className="field-err" role="alert">不可用：{check.data.message || '目录不能用'}</span>
  } else if (!typing && check.isError) {
    hint = <span className="field-err">校验失败：{check.error.message}</span>
  }
  const bad = !typing && !!check.data && !!value.trim() && !workdirUsable(check.data)

  return (
    // 选目录时占满一行，目录列表不至于挤在半格里
    <div className={cls('field', picking && 'wd-wide')}>
      <span className="field-label" id={labelId}>工作目录</span>
      <div className="wd-row">
        <input className={cls('input mono-input', bad && 'bad')} aria-labelledby={labelId} aria-invalid={bad || undefined}
          value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={inherit ? `继承自项目：${inherit.dir}` : '本机绝对路径'} />
        <Button variant="outline" aria-expanded={picking} onClick={() => setPicking(!picking)}>{picking ? '收起' : '选目录'}</Button>
      </div>
      {hint}
      {picking && (
        <DirPicker start={value.trim() || inherit?.dir || ''}
          onPick={(p) => { onChange(p); setPicking(false) }} onClose={() => setPicking(false)} />
      )}
    </div>
  )
}

function DirPicker({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start)
  const list = useFsBrowse(path, true)
  const shortcuts = useFsShortcuts(true)
  const cur = list.data
  const dirs = cur?.entries.filter((e) => e.is_dir) ?? []

  return (
    <div className="wd-picker" role="group" aria-label="选择目录"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
      {!!shortcuts.data?.length && (
        <div className="wd-shortcuts">
          {shortcuts.data.map((s) => (
            <Button key={s.path} size="sm" variant="outline" title={s.path} onClick={() => setPath(s.path)}>{s.label}</Button>
          ))}
        </div>
      )}
      <div className="wd-cur">
        <Button size="sm" variant="ghost" disabled={!cur?.parent} onClick={() => cur && setPath(cur.parent)}>上一级</Button>
        <span className="mono ellipsis" title={cur?.path}>{cur?.path ?? (path || '...')}</span>
      </div>
      {list.isError
        ? <div className="field-err">{list.error.message}</div>
        : (
          <ul className="wd-list">
            {list.isPending && <li className="wd-muted">加载中</li>}
            {cur && !dirs.length && <li className="wd-muted">没有子目录</li>}
            {dirs.map((d) => (
              <li key={d.path}>
                <button type="button" className="wd-item" onClick={() => setPath(d.path)}>{d.name}</button>
              </li>
            ))}
          </ul>
        )}
      <div className="wd-foot">
        {cur && !cur.writable && <span className="field-hint-line">这个目录不可写</span>}
        <span className="spacer" />
        <Button size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" variant="primary" disabled={!cur} onClick={() => cur && onPick(cur.path)}>选这个目录</Button>
      </div>
    </div>
  )
}
