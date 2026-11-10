// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置里的「本机目录」（FS-01）：选目录时能走到哪些地方。默认是主目录、/Volumes、/tmp，
// 这里加的额外目录存在后端（数据目录的 fs-roots.json），所有选目录的地方都认。
import { useState } from 'react'
import { errorText, QueryState, useAddFsRoot, useFsRoots, useRemoveFsRoot, type FsRoot } from '../../../core/data'
import { Button, ConfirmDialog, PageTitle } from '../../../core/ui'
import './localfs.css'

export function LocalFsSection() {
  const q = useFsRoots()
  const add = useAddFsRoot()
  const remove = useRemoveFsRoot()
  const [path, setPath] = useState('')
  const [removing, setRemoving] = useState<FsRoot | null>(null)
  const submit = () => {
    const p = path.trim()
    if (!p) return
    add.mutate(p, { onSuccess: () => setPath('') })
  }

  return (
    <div className="lf-page">
      <PageTitle parent="设置" desc="选工作目录、项目目录、挂载文档目录时能浏览到的范围">本机目录</PageTitle>
      <QueryState query={q}>
        {(d) => (
          <>
            <div className="lf-label">默认可浏览</div>
            <ul className="lf-list" aria-label="默认可浏览">
              {d.defaults.map((p) => (
                <li key={p} className="lf-row"><span className="lf-path">{p}</span><span className="lf-sub">内置，不能删</span></li>
              ))}
            </ul>
            <p className="lf-hint">外接盘和分区都挂在 /Volumes 下，选目录时左侧会按当前挂载情况列出每个分区。</p>

            <div className="lf-label">额外可浏览目录</div>
            {d.extra.length
              ? (
                <ul className="lf-list" aria-label="额外可浏览目录">
                  {d.extra.map((r) => (
                    <li key={r.path} className="lf-row">
                      <span className="lf-path">{r.path}</span>
                      <span className="lf-sub">加于 {r.added_at.slice(0, 10)}</span>
                      <Button size="sm" variant="ghost" onClick={() => { remove.reset(); setRemoving(r) }}>删除</Button>
                    </li>
                  ))}
                </ul>
              )
              : <p className="lf-hint">还没有。默认范围之外的目录（比如 /opt 下的数据目录）可以在下面加进来。</p>}
            <div className="lf-add">
              <input className="input mono-input" aria-label="要加的目录" spellCheck={false} value={path}
                placeholder="目录的绝对路径，例如 /opt/data"
                onChange={(e) => { setPath(e.target.value); if (add.isError) add.reset() }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
              <Button variant="primary" disabled={!path.trim() || add.isPending} onClick={submit}>{add.isPending ? '正在加…' : '加入'}</Button>
            </div>
            {add.isError && <div className="field-err" role="alert">{errorText(add.error)}</div>}
            <p className="lf-hint">必须是已存在的目录。根目录 /、系统目录（/etc、/System、/private、/usr、/bin、/sbin、/var、/dev、/Library）和工作台自己的数据目录不能加。只放宽浏览范围，读文件仍只限已挂载的目录，密钥和库文件照样不给读。</p>
          </>
        )}
      </QueryState>
      <ConfirmDialog open={!!removing} title="删除这个可浏览目录？" danger confirmLabel="删除" busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.path, { onSuccess: () => setRemoving(null) })}>
        <p className="lf-mono">{removing?.path}</p>
        <p>删掉后选目录时就进不去了，挂在它下面的文档目录也读不了。磁盘上的文件不动。</p>
        {remove.isError && <div className="field-err" role="alert">{errorText(remove.error)}</div>}
      </ConfirmDialog>
    </div>
  )
}
