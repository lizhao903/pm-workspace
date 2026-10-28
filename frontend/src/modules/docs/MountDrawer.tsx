// 挂载本地目录（SPEC-library-1.11 的正式版）：用 /api/fs/browse 选目录，POST /api/local-dirs 挂上，存在后端，刷新页面还在。
// 只读：后端只列文本文件、只读挂载目录里的非隐藏文件；数据目录和包住数据目录的路径不让挂（403）。
import { useState } from 'react'
import { errorText, isApiError, useFsBrowse, useFsShortcuts, useMountLocalDir, type LocalDir } from '../../core/data'
import { Button, Drawer, Field, Input } from '../../core/ui'

/** 挂载失败的说法：403 是安全限制，409 是已经挂过 */
function mountError(e: unknown): string {
  if (isApiError(e) && e.status === 403) return `这个目录不能挂载：${e.message}`
  if (isApiError(e, 'conflict')) return '这个目录已经挂载过了'
  return `挂载失败：${errorText(e)}`
}

export function MountDrawer({ open, onClose, onMounted, existing }: {
  open: boolean
  onClose: () => void
  onMounted: (dir: LocalDir) => void
  /** 已挂载的目录：选到同一个目录时直接切过去，不再挂一次 */
  existing: LocalDir[]
}) {
  return (
    <Drawer open={open} onClose={onClose} kicker="文档" aria-label="挂载本地目录" className="mount-drawer">
      <MountBody onClose={onClose} onMounted={onMounted} existing={existing} />
    </Drawer>
  )
}

function MountBody({ onClose, onMounted, existing }: Omit<Parameters<typeof MountDrawer>[0], 'open'>) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const list = useFsBrowse(path, true)
  const shortcuts = useFsShortcuts(true)
  const mount = useMountLocalDir()
  const cur = list.data
  const dirs = cur?.entries.filter((e) => e.is_dir) ?? []
  // 隐藏目录挂不了，列出来也只会 403
  const visible = dirs.filter((d) => !d.name.startsWith('.'))
  const same = cur ? existing.find((d) => d.path === cur.path) : undefined

  const submit = () => {
    if (!cur) return
    if (same) { onMounted(same); return }
    mount.mutate({ path: cur.path, name: name.trim() || undefined }, {
      onSuccess: (d) => onMounted(d),
    })
  }

  return (
    <div className="mount-body">
      <h2 className="mount-title">挂载本地目录</h2>
      <p className="mount-desc">只读：列出目录里的文本文件（md、txt、json 等），隐藏文件和 node_modules 这类目录跳过。工作台自己的数据目录不能挂。</p>
      {!!shortcuts.data?.length && (
        <div className="mnt-shortcuts">
          {shortcuts.data.map((s) => (
            <Button key={s.path} size="sm" variant="outline" title={s.path} onClick={() => setPath(s.path)}>{s.label}</Button>
          ))}
        </div>
      )}
      <div className="mnt-cur">
        <Button size="sm" variant="ghost" disabled={!cur?.parent} onClick={() => cur && setPath(cur.parent)}>上一级</Button>
        <span className="mono ellipsis" title={cur?.path}>{cur?.path ?? (path || '...')}</span>
      </div>
      {list.isError
        ? <div className="field-err" role="alert">{errorText(list.error)}</div>
        : (
          <ul className="mnt-list" aria-label="子目录">
            {list.isPending && <li className="mnt-muted">加载中</li>}
            {cur && !visible.length && <li className="mnt-muted">没有子目录</li>}
            {visible.map((d) => (
              <li key={d.path}>
                <button type="button" className="mnt-item" onClick={() => setPath(d.path)}>{d.name}</button>
              </li>
            ))}
          </ul>
        )}
      <Field label="显示名" hint="留空用目录名">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={cur ? cur.path.split('/').filter(Boolean).pop() : ''} />
      </Field>
      {same && <div className="field-hint-line">这个目录已经挂载为「{same.name}」，点下面直接打开</div>}
      {mount.isError && <div className="field-err" role="alert">{mountError(mount.error)}</div>}
      <div className="mnt-foot">
        <span className="spacer" />
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!cur || mount.isPending} onClick={submit}>
          {mount.isPending ? '正在挂载…' : same ? '打开这个目录' : '挂载这个目录'}
        </Button>
      </div>
    </div>
  )
}
