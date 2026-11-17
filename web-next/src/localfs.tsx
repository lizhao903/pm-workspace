// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 本机目录（FS-01，SPEC-settings-30）：选目录时能走到哪些地方。正式产品 frontend/src/modules/settings/localfs/LocalFsSection.tsx，
// 默认是主目录、/Volumes、/tmp，这里加的额外目录存在后端（数据目录的 fs-roots.json），所有选目录的地方都认。
// 原型没有后端：只在本页记着，不校验目录在不在（浏览器拿不到本机路径），只按规则拦根目录、系统目录和工作台数据目录。
import { useState } from 'react'
import { PageTitle } from './topbar'
import './setx.css'

type FsRoot = { path: string; added_at: string }
const DEFAULTS = ['~（主目录）', '/Volumes', '/tmp']
const BLOCKED = ['/', '/etc', '/System', '/private', '/usr', '/bin', '/sbin', '/var', '/dev', '/Library']
const DATA_DIR = '~/pm-workspace/data'

/** 和后端同一套拦法：要绝对路径；根目录、系统目录、工作台数据目录不能加；已经在里面的不重复加 */
function checkPath(p: string, extra: FsRoot[]): string {
  if (!p.startsWith('/')) return '要写绝对路径，以 / 开头'
  const clean = p.replace(/\/+$/, '') || '/'
  if (clean === '/') return '不能加根目录 /'
  if (BLOCKED.some((b) => b !== '/' && (clean === b || clean.startsWith(`${b}/`)))) return `系统目录不能加：${clean}`
  if (clean.startsWith('/tmp') || clean.startsWith('/Volumes')) return '已经在默认可浏览的范围里'
  if (extra.some((r) => r.path === clean)) return '这个目录已经加过了'
  return ''
}

export function LocalFsPage() {
  const [extra, setExtra] = useState<FsRoot[]>([{ path: '/opt/data', added_at: '2026-11-02T08:00:00Z' }])
  const [path, setPath] = useState('')
  const [err, setErr] = useState('')
  const [removing, setRemoving] = useState<FsRoot | null>(null)
  const submit = () => {
    const p = path.trim()
    if (!p) return
    const why = checkPath(p, extra)
    if (why) { setErr(why); return }
    setExtra((xs) => [...xs, { path: p.replace(/\/+$/, ''), added_at: new Date().toISOString() }])
    setPath('')
  }
  return (
    <div className="page setx-page">
      <PageTitle parent="设置" desc="选工作目录、项目目录、挂载文档目录时能浏览到的范围">本机目录</PageTitle>
      <div className="section-label">默认可浏览</div>
      <ul className="lf-list" aria-label="默认可浏览">
        {DEFAULTS.map((p) => <li key={p} className="lf-row"><span className="lf-path">{p}</span><span className="muted setx-sm">内置，不能删</span></li>)}
      </ul>
      <p className="muted setx-sm">外接盘和分区都挂在 /Volumes 下，选目录时左侧会按当前挂载情况列出每个分区。</p>
      <div className="section-label">额外可浏览目录</div>
      {extra.length ? (
        <ul className="lf-list" aria-label="额外可浏览目录">
          {extra.map((r) => (
            <li key={r.path} className="lf-row">
              <span className="lf-path">{r.path}</span>
              <span className="muted setx-sm">加于 {r.added_at.slice(0, 10)}</span>
              <button className="act act-quiet" onClick={() => setRemoving(r)}>删除</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted setx-sm">还没有。默认范围之外的目录（比如 /opt 下的数据目录）可以在下面加进来。</p>}
      <div className="lf-add">
        <input aria-label="要加的目录" spellCheck={false} value={path} placeholder="目录的绝对路径，例如 /opt/data"
          onChange={(e) => { setPath(e.target.value); setErr('') }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
        <button className="act act-primary" disabled={!path.trim()} onClick={submit}>加入</button>
      </div>
      {err && <div className="danger-text setx-sm" role="alert">{err}</div>}
      <p className="muted setx-sm">必须是已存在的目录。根目录 /、系统目录（/etc、/System、/private、/usr、/bin、/sbin、/var、/dev、/Library）和工作台自己的数据目录（{DATA_DIR}）不能加。只放宽浏览范围，读文件仍只限已挂载的目录，密钥和库文件照样不给读。</p>
      {removing && (
        <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setRemoving(null) }}>
          <div className="qs" role="alertdialog" aria-label="删除可浏览目录">
            <div className="qs-head"><b>删除这个可浏览目录？</b></div>
            <div className="lf-path">{removing.path}</div>
            <div>删掉后选目录时就进不去了，挂在它下面的文档目录也读不了。磁盘上的文件不动。</div>
            <div className="act-row"><span className="spacer" />
              <button className="act act-quiet" onClick={() => setRemoving(null)}>取消</button>
              <button className="act btn-danger" onClick={() => { setExtra((xs) => xs.filter((x) => x.path !== removing.path)); setRemoving(null) }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
