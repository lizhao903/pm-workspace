import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Project, Prototype } from './projectdata'
import { cls } from './ui'
import { newId } from './ids'

// 终端：顶部标签页切换，每个标签页最多拆成 2x2 四个窗格
// 原型里是模拟终端：认常用命令（cd / ls / cat / git status …），在项目原型目录里 npm run dev 会真的去启动「项目」里的那个原型
// 要接真终端，需要本地起一个服务用 pty 跑 shell、通过 WebSocket 连过来，这一层原型里没有

export interface TermLine { kind: 'in' | 'out' | 'err' | 'sys'; text: string; cwd?: string }
export interface Pane { id: string; cwd: string; lines: TermLine[]; history: string[]; running?: string }
export interface TermTab { id: string; name: string; dir: 'row' | 'col'; panes: Pane[]; focus: string }

const HOME = '/Users/me'
const short = (cwd: string) => (cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd)
const base = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? '/'

export const newPane = (cwd: string): Pane => ({
  id: newId('pn'), cwd, history: [],
  lines: [{ kind: 'sys', text: '模拟终端：支持 cd、ls、pwd、cat、echo、git status、clear、help；在原型目录里 npm run dev 会启动「项目」里的原型' }],
})
export const newTab = (cwd: string, name = ''): TermTab => { const p = newPane(cwd); return { id: newId('tb'), name, dir: 'row', panes: [p], focus: p.id } }

/** 虚拟文件系统：项目目录、它下面的原型目录和关联目录，外加几个常见目录 */
function buildFs(projects: Project[]) {
  const dirs = new Map<string, Set<string>>()
  const files = new Map<string, string>()
  const addDir = (path: string) => {
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (const seg of parts) {
      const parent = cur || '/'
      cur = `${cur}/${seg}`
      if (!dirs.has(parent)) dirs.set(parent, new Set())
      dirs.get(parent)!.add(`${seg}/`)
      if (!dirs.has(cur)) dirs.set(cur, new Set())
    }
  }
  const addFile = (path: string, body: string) => {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    addDir(dir)
    dirs.get(dir)!.add(path.slice(path.lastIndexOf('/') + 1))
    files.set(path, body)
  }
  addDir(HOME); addDir(`${HOME}/Downloads`); addDir(`${HOME}/Desktop`)
  for (const p of projects) {
    if (!p.root) continue
    addDir(p.root)
    addFile(`${p.root}/README.md`, `# ${p.name}\n\n${p.desc}`)
    for (const r of p.related) if (r.path) addDir(r.path)
    for (const x of p.prototypes) {
      const d = `${p.root}/${x.dir}`.replace(/\/+$/, '')
      addDir(d)
      // 原型的启动命令多半就是 npm run dev，package.json 里的 dev 脚本写真正跑的东西，别写成自己调自己
      const script = /^(npm|pnpm|yarn)\b/.test(x.command) ? 'vite' : x.command
      addFile(`${d}/package.json`, JSON.stringify({ name: x.dir || p.name, private: true, scripts: { dev: script } }, null, 2))
    }
    for (const m of p.materials) {
      if (m.kind === 'file') addFile(`${p.root}/${m.value}`, `（${m.name}）`)
      if (m.kind === 'folder') addDir(`${p.root}/${m.value}`)
    }
    for (const d of p.docs) if (d.source.type === 'file') addFile(`${p.root}/${d.source.path}`, `# ${d.title}`)
  }
  return { dirs, files }
}

function resolve(cwd: string, arg: string): string {
  if (!arg || arg === '~') return HOME
  let path = arg.startsWith('/') ? arg : arg.startsWith('~/') ? `${HOME}/${arg.slice(2)}` : `${cwd}/${arg}`
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  path = `/${out.join('/')}`
  return path
}

export function TerminalPage({ tabs, active, onTabs, onActive, projects, onStartProto, onStopProto, cwd, embedded = false }: {
  tabs: TermTab[]
  active: string
  onTabs: (f: (t: TermTab[]) => TermTab[]) => void
  onActive: (id: string) => void
  projects: Project[]
  onStartProto: (id: string) => void
  onStopProto: (id: string) => void
  /** 新标签页的目录；不传就用第一个有目录的项目 */
  cwd?: string
  /** 嵌在项目详情的展开区域里：不占顶栏，拆分按钮放进标签栏，关掉最后一个标签就是没有终端了 */
  embedded?: boolean
}) {
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  const [renaming, setRenaming] = useState<string | null>(null)
  const defaultCwd = cwd || (projects.find((p) => p.root)?.root ?? HOME)
  const patchTab = (id: string, f: (t: TermTab) => TermTab) => onTabs((ts) => ts.map((t) => (t.id === id ? f(t) : t)))

  const addTab = () => { const t = newTab(defaultCwd); onTabs((ts) => [...ts, t]); onActive(t.id) }
  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id)
    t?.panes.forEach((p) => p.running && onStopProto(p.running))
    const rest = tabs.filter((x) => x.id !== id)
    if (!rest.length && embedded) { onTabs(() => []); onActive(''); return }
    if (!rest.length) { const n = newTab(defaultCwd); onTabs(() => [n]); onActive(n.id); return }
    onTabs(() => rest)
    if (id === active) onActive(rest[Math.max(0, tabs.findIndex((x) => x.id === id) - 1)].id)
  }
  // 拆分：新窗格沿用当前窗格的目录；最多 4 个，排成 2x2
  const split = (dir: 'row' | 'col') => {
    if (!tab || tab.panes.length >= 4) return
    const cur = tab.panes.find((p) => p.id === tab.focus) ?? tab.panes[0]
    const p = newPane(cur.cwd)
    patchTab(tab.id, (t) => ({ ...t, dir: t.panes.length === 1 ? dir : t.dir, panes: [...t.panes, p], focus: p.id }))
  }
  const closePane = (pid: string) => {
    if (!tab) return
    const pane = tab.panes.find((p) => p.id === pid)
    if (pane?.running) onStopProto(pane.running)
    if (tab.panes.length === 1) { closeTab(tab.id); return }
    patchTab(tab.id, (t) => { const panes = t.panes.filter((p) => p.id !== pid); return { ...t, panes, focus: t.focus === pid ? panes[0].id : t.focus } })
  }

  const layout = !tab ? 'l1' : tab.panes.length === 1 ? 'l1' : tab.panes.length === 2 ? (tab.dir === 'row' ? 'l2r' : 'l2c') : tab.panes.length === 3 ? 'l3' : 'l4'
  const tabName = (t: TermTab) => t.name || base(t.panes.find((p) => p.id === t.focus)?.cwd ?? HOME)

  return (
    <div className={cls('term-page', embedded && 'term-embedded')}>
      <div className="term-tabs" role="tablist">
        {tabs.map((t) => {
          const run = t.panes.some((p) => p.running)
          return (
            <div key={t.id} role="tab" aria-selected={t.id === tab?.id} className={cls('term-tab', t.id === tab?.id && 'on')} onClick={() => onActive(t.id)}
              onDoubleClick={() => setRenaming(t.id)} title="双击改名">
              {run && <span className="proto-light pl-running" />}
              {renaming === t.id ? (
                <input autoFocus className="term-tab-input" defaultValue={tabName(t)} onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { patchTab(t.id, (x) => ({ ...x, name: e.target.value.trim() })); setRenaming(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }} />
              ) : <span className="ellipsis">{tabName(t)}</span>}
              {t.panes.length > 1 && <span className="term-tab-n">{t.panes.length}</span>}
              <button className="term-tab-x" title="关闭标签页" onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}>
                <svg viewBox="0 0 16 16" width="9" height="9"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
          )
        })}
        <button className="term-tab-add" onClick={addTab} title="新标签页">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        {embedded && tab && <>
          <span className="spacer" />
          <button className="term-btn term-tabs-btn" disabled={tab.panes.length >= 4} title="向右拆分 (⌘D)" onClick={() => split('row')}>
            <svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
          <button className="term-btn term-tabs-btn" disabled={tab.panes.length >= 4} title="向下拆分 (⇧⌘D)" onClick={() => split('col')}>
            <svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 8h12" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
        </>}
      </div>
      {tab && (
        <div className={cls('term-grid', layout)}>
          {tab.panes.map((p) => (
            <TermPane key={p.id} pane={p} focused={p.id === tab.focus} canSplit={tab.panes.length < 4} projects={projects}
              onFocus={() => patchTab(tab.id, (t) => ({ ...t, focus: p.id }))}
              onPane={(f) => patchTab(tab.id, (t) => ({ ...t, panes: t.panes.map((x) => (x.id === p.id ? f(x) : x)) }))}
              onSplit={split} onClose={() => closePane(p.id)} onStartProto={onStartProto} onStopProto={onStopProto} />
          ))}
        </div>
      )}
    </div>
  )
}

function TermPane({ pane, focused, canSplit, projects, onFocus, onPane, onSplit, onClose, onStartProto, onStopProto }: {
  pane: Pane
  focused: boolean
  canSplit: boolean
  projects: Project[]
  onFocus: () => void
  onPane: (f: (p: Pane) => Pane) => void
  onSplit: (dir: 'row' | 'col') => void
  onClose: () => void
  onStartProto: (id: string) => void
  onStopProto: (id: string) => void
}) {
  const [input, setInput] = useState('')
  const [hi, setHi] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const fs = buildFs(projects)
  const protoAt = (cwd: string): { proto: Prototype; project: Project } | null => {
    for (const project of projects) for (const proto of project.prototypes) if (`${project.root}/${proto.dir}`.replace(/\/+$/, '') === cwd) return { proto, project }
    return null
  }
  // 窗格里跑着的原型：跟着「项目」那边的状态把日志接过来
  const runningProto = pane.running ? projects.flatMap((p) => p.prototypes).find((x) => x.id === pane.running) : undefined
  const seen = useRef(0)
  useEffect(() => {
    if (!runningProto) { seen.current = 0; return }
    // 格子自己已回显过命令和 ^C，日志里的这两种行不再接
    const fresh = runningProto.logs.slice(seen.current).filter((l) => !l.startsWith('$ ') && l !== '^C')
    if (fresh.length) { seen.current = runningProto.logs.length; onPane((p) => ({ ...p, lines: [...p.lines, ...fresh.map((t) => ({ kind: (/Error|失败/.test(t) ? 'err' : 'out') as TermLine['kind'], text: t }))] })) }
    if (runningProto.status === 'stopped' || runningProto.status === 'error') {
      seen.current = 0
      onPane((p) => ({ ...p, running: undefined, lines: [...p.lines, ...(runningProto.status === 'error' && runningProto.error ? [{ kind: 'err' as const, text: runningProto.error }] : [])] }))
    }
  }, [runningProto?.logs.length, runningProto?.status])
  useEffect(() => { outRef.current?.scrollTo({ top: outRef.current.scrollHeight }) }, [pane.lines.length])
  useEffect(() => { if (focused) inputRef.current?.focus() }, [focused])

  const print = (lines: TermLine[], patch: Partial<Pane> = {}) => onPane((p) => ({ ...p, ...patch, lines: [...p.lines, ...lines] }))
  const out = (t: string): TermLine => ({ kind: 'out', text: t })
  const err = (t: string): TermLine => ({ kind: 'err', text: t })

  const run = (raw: string) => {
    const cmd = raw.trim()
    const echo: TermLine = { kind: 'in', text: raw, cwd: pane.cwd }
    const history = cmd ? [...pane.history.filter((h) => h !== cmd), cmd].slice(-100) : pane.history
    setInput(''); setHi(null)
    if (!cmd) { print([echo]); return }
    const [name, ...args] = cmd.split(/\s+/)
    const arg = args.join(' ')
    const ok = (lines: TermLine[], patch: Partial<Pane> = {}) => print([echo, ...lines], { history, ...patch })
    switch (name) {
      case 'clear': onPane((p) => ({ ...p, lines: [], history })); return
      case 'help': ok(['可用命令：cd ls pwd cat echo date whoami clear history git status node -v npm -v', 'npm run dev / npm start：在项目原型目录里启动原型，Ctrl+C 停止', '这是原型里的模拟终端，不会真的执行系统命令'].map(out)); return
      case 'pwd': ok([out(pane.cwd)]); return
      case 'whoami': ok([out('me')]); return
      case 'date': ok([out(new Date().toString())]); return
      case 'echo': ok([out(arg.replace(/^["']|["']$/g, ''))]); return
      case 'history': ok(history.map((h, i) => out(`${String(i + 1).padStart(4)}  ${h}`))); return
      case 'cd': {
        const to = resolve(pane.cwd, arg)
        if (!fs.dirs.has(to)) { ok([err(`cd: no such file or directory: ${arg}`)]); return }
        ok([], { cwd: to }); return
      }
      case 'ls': {
        const at = arg && !arg.startsWith('-') ? resolve(pane.cwd, arg) : pane.cwd
        const items = fs.dirs.get(at)
        if (!items) { ok([err(`ls: ${arg}: No such file or directory`)]); return }
        ok([out([...items].sort().join('    ') || '')]); return
      }
      case 'cat': {
        const f = resolve(pane.cwd, arg)
        if (!arg) { ok([err('cat: 要给一个文件')]); return }
        if (fs.dirs.has(f)) { ok([err(`cat: ${arg}: Is a directory`)]); return }
        const body = fs.files.get(f)
        ok(body === undefined ? [err(`cat: ${arg}: No such file or directory`)] : body.split('\n').map(out)); return
      }
      case 'node': ok([out(args[0] === '-v' || args[0] === '--version' ? 'v22.11.0' : '原型终端里不能交互式跑 node')]); return
      case 'git':
        if (args[0] === 'status') ok(['On branch main', 'Changes not staged for commit:', '  modified:   src/App.tsx', '', 'Untracked files:', '  web-next/'].map(out))
        else ok([err(`git ${args[0] ?? ''}：原型终端只支持 git status`)])
        return
      case 'npm':
      case 'pnpm':
      case 'yarn': {
        if (args[0] === '-v' || args[0] === '--version') { ok([out('10.9.0')]); return }
        const isDev = (args[0] === 'run' && (args[1] === 'dev' || args[1] === 'start')) || args[0] === 'start' || args[0] === 'dev'
        if (!isDev) { ok([err(`${name} ${args.join(' ')}：原型终端只支持 npm run dev / npm start`)]); return }
        const hit = protoAt(pane.cwd)
        if (!hit) { ok([err('npm ERR! Missing script: "dev"'), err('当前目录不是「项目」里登记的原型目录')]); return }
        if (hit.proto.status === 'running') { ok([err(`「${hit.proto.name}」已经在 ${hit.proto.port} 端口运行，先在别处停掉或在这里 Ctrl+C`)]); return }
        seen.current = 0
        ok([out(`> ${hit.proto.command}`), { kind: 'sys', text: `启动「${hit.project.name} / ${hit.proto.name}」，Ctrl+C 停止` }], { running: hit.proto.id })
        onStartProto(hit.proto.id)
        return
      }
      default: ok([err(`zsh: command not found: ${name}`)])
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!pane.running) run(input); return }
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      if (pane.running) { onStopProto(pane.running); print([{ kind: 'in', text: '^C', cwd: pane.cwd }]) }
      else { print([{ kind: 'in', text: `${input}^C`, cwd: pane.cwd }]); setInput('') }
      return
    }
    if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); onPane((p) => ({ ...p, lines: [] })); return }
    if (e.key === 'ArrowUp' && pane.history.length) {
      e.preventDefault()
      const i = hi === null ? pane.history.length - 1 : Math.max(0, hi - 1)
      setHi(i); setInput(pane.history[i])
    }
    if (e.key === 'ArrowDown' && hi !== null) {
      e.preventDefault()
      const i = hi + 1
      if (i >= pane.history.length) { setHi(null); setInput('') } else { setHi(i); setInput(pane.history[i]) }
    }
    if (e.key === 'Tab') {
      // 补全：只补目录和文件名的最后一段
      e.preventDefault()
      const parts = input.split(' ')
      const last = parts.pop() ?? ''
      const dir = last.includes('/') ? resolve(pane.cwd, last.slice(0, last.lastIndexOf('/')) || '/') : pane.cwd
      const prefix = last.slice(last.lastIndexOf('/') + 1)
      const hits = [...(fs.dirs.get(dir) ?? [])].filter((x) => x.startsWith(prefix))
      if (hits.length === 1) setInput([...parts, last.slice(0, last.lastIndexOf('/') + 1) + hits[0]].join(' '))
      else if (hits.length > 1) print([{ kind: 'in', text: input, cwd: pane.cwd }, out(hits.join('    '))])
    }
    if (e.key.toLowerCase() === 'd' && e.metaKey && canSplit) { e.preventDefault(); onSplit(e.shiftKey ? 'col' : 'row') }
  }

  return (
    <div className={cls('term-pane', focused && 'focus')} onMouseDown={onFocus} onClick={() => inputRef.current?.focus()}>
      <div className="term-pane-head">
        <span className="term-cwd ellipsis" title={pane.cwd}>{short(pane.cwd)}</span>
        {runningProto && <span className="term-run"><span className="proto-light pl-running" />{runningProto.name} :{runningProto.port}</span>}
        <span className="spacer" />
        <button className="term-btn" disabled={!canSplit} title="向右拆分" onClick={(e) => { e.stopPropagation(); onSplit('row') }}>
          <svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
        <button className="term-btn" disabled={!canSplit} title="向下拆分" onClick={(e) => { e.stopPropagation(); onSplit('col') }}>
          <svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 8h12" stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
        <button className="term-btn" title="关闭窗格" onClick={(e) => { e.stopPropagation(); onClose() }}>
          <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="term-out" ref={outRef}>
        {pane.lines.map((l, i) => (
          <div key={i} className={`tl tl-${l.kind}`}>
            {l.kind === 'in' && <span className="term-prompt">{base(l.cwd ?? pane.cwd)} $ </span>}{l.text}
          </div>
        ))}
        <div className="tl tl-in term-input-line">
          {!pane.running && <span className="term-prompt">{base(pane.cwd)} $ </span>}
          <input ref={inputRef} className="term-input" value={input} spellCheck={false} autoComplete="off"
            placeholder={pane.running ? '运行中，Ctrl+C 停止' : ''} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} />
        </div>
      </div>
    </div>
  )
}
