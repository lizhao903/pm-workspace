import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { PageTitle } from './topbar'
import { MODULES, type ModuleKey, type Workbench } from './workspacedata'

// 原型总览：按模块列出每个页面、一句话说明和规格包里的章节
// 规格原文在 web-next/docs/spec，用 glob 带进来：规格包改了这里跟着变，不用手工同步编号
// 状态读规格包 README 的模块清单；页面清单读各模块规格的「页面清单」表，规格还没写到的模块用下面的 DRAFT

const SPEC_DIR = 'web-next/docs/spec'
const files = import.meta.glob<string>('../docs/spec/*.md', { query: '?raw', import: 'default', eager: true })
const specOf = (key: string): string | undefined => files[`../docs/spec/${key}.md`]

export type OverviewKey = ModuleKey | 'settings'
type Status = '已整理' | '整理中' | '待整理'
interface PageRow { name: string; desc: string; entry?: string; spec?: string; view?: string }

const ALL: { key: OverviewKey; label: string; desc: string }[] = [...MODULES, { key: 'settings', label: '设置', desc: '工作台、连接器、模型、Agent、知识库等全局配置（不算模块，总在左下角）' }]

/** README 模块清单：key -> 状态和备注 */
function readStatus(): Record<string, { status: Status; note: string; owner: string }> {
  const out: Record<string, { status: Status; note: string; owner: string }> = {}
  for (const line of (specOf('README') ?? '').split('\n')) {
    const cells = splitRow(line)
    const key = /^`([a-z]+)`$/.exec(cells[1] ?? '')?.[1]
    if (!key || cells.length < 6) continue
    const raw = cells[cells.length - 1]
    const status = (['已整理', '整理中', '待整理'] as Status[]).find((s) => raw.startsWith(s)) ?? '待整理'
    out[key] = { status, note: raw.slice(status.length).replace(/^（(.*)）$/, '$1'), owner: cells[4].replace(/（.*$/, '') }
  }
  return out
}

/** 规格的「页面清单」表：| [SPEC-x-n](#...) | 页面 | 入口 | 说明 | */
function readPages(key: string): PageRow[] {
  const src = specOf(key)
  if (!src) return []
  const at = src.indexOf('### 页面清单')
  if (at < 0) return []
  const rows: PageRow[] = []
  for (const line of src.slice(at).split('\n').slice(1)) {
    if (line.startsWith('### ') || line.startsWith('## ')) break
    const cells = splitRow(line)
    const spec = /^\[(SPEC-[a-z]+-\d+)\]/.exec(cells[0] ?? '')?.[1]
    if (!line.trim() && rows.length) break
    if (spec && cells.length >= 4) rows.push({ spec, name: cells[1], entry: cells[2], desc: cells[3] })
  }
  return rows
}

// 规格还没写到的模块：页面按原型的二级菜单列；PROTO-04f 写好规格后自动换成规格里的页面清单
const DRAFT: Partial<Record<OverviewKey, PageRow[]>> = {
  sop: [
    { name: '执行记录', desc: '每次执行走到哪一步，点开看步骤和产出', view: 'runs' },
    { name: '待我处理', desc: '待检查、待确认、失败的执行', view: 'waiting' },
    { name: '流程库', desc: '标准流程列表，点开看流程详情', view: 'library' },
    { name: '流程编辑', desc: '画流程图：步骤、分支、检查点', view: 'edit:new' },
  ],
  terminal: [{ name: '终端', desc: '分屏终端；在原型目录里 npm run dev 会启动对应原型' }],
  browser: [{ name: '浏览器', desc: '内置浏览器：多标签、看原型、打开 Google Drive 文件' }],
  videos: [
    { name: '全部视频', desc: '按系列分组的视频列表和制作进度', view: 'all' },
    { name: '待我处理', desc: '停在检查点或被退回的视频', view: 'review' },
    { name: '发布记录', desc: '多平台发布的结果和数据', view: 'publish' },
    { name: '系列管理', desc: '系列共用的开场收尾、集数编排', view: 'series' },
    { name: '选题', desc: '给选题打分排优先级，可开拍了就立项', view: 'topics' },
    { name: '素材收件箱', desc: '评论、热榜、竞品、想法，整理成选题', view: 'clips' },
  ],
  markets: [{ name: '行情', desc: '自选列表、K 线、期权 T 型报价' }],
  monitor: [{ name: '盯盘', desc: '市场时段、盯盘墙、价格与异动提醒、触发记录' }],
  strategy: [
    { name: '策略库', desc: '策略列表，点开进编辑器', view: 'list' },
    { name: '回测记录', desc: '回测和参数扫描的结果', view: 'backtests' },
    { name: '运行记录', desc: '在实盘或模拟盘跑的策略', view: 'runs' },
  ],
  trading: [
    { name: '总览', desc: '资产、盈亏和今天的成交', view: 'overview' },
    { name: '持仓', desc: '各账户的持仓', view: 'positions' },
    { name: '委托', desc: '挂单、成交和撤单', view: 'orders' },
    { name: '策略运行', desc: '策略的运行状态，启停', view: 'runs' },
    { name: '交易账户', desc: '券商和交易所账户的连接', view: 'accounts' },
    { name: '风控', desc: '风控规则、熔断和一键全停', view: 'risk' },
  ],
}

// 规格里的页面落在原型的哪个子页：二级菜单、设置分项、项目详情标签；没写的就打开模块入口
const VIEW_OF: Record<string, string> = {
  'SPEC-tasks-2': 'all', 'SPEC-tasks-3': 'manual', 'SPEC-tasks-4': 'all', 'SPEC-tasks-5': 'all', 'SPEC-tasks-6': 'all',
  'SPEC-tasks-7': 'schedules', 'SPEC-tasks-8': 'schedules', 'SPEC-tasks-9': 'hooks', 'SPEC-tasks-10': 'hooks',
  'SPEC-sessions-1': 'chats', 'SPEC-sessions-2': 'runs', 'SPEC-sessions-3': 'outputs',
  'SPEC-projects-2': 'overview', 'SPEC-projects-3': 'overview', 'SPEC-projects-4': 'comms', 'SPEC-projects-5': 'comms',
  'SPEC-projects-6': 'stakeholders', 'SPEC-projects-7': 'tasks', 'SPEC-projects-8': 'docs', 'SPEC-projects-9': 'sop',
  'SPEC-projects-10': 'agents', 'SPEC-projects-11': 'materials', 'SPEC-projects-12': 'prototypes', 'SPEC-projects-13': 'settings', 'SPEC-projects-14': 'overview',
  'SPEC-settings-2': 'workspace', 'SPEC-settings-3': 'connectors', 'SPEC-settings-4': 'connectors', 'SPEC-settings-5': 'connectors',
  'SPEC-settings-6': 'providers', 'SPEC-settings-7': 'providers', 'SPEC-settings-8': 'agents', 'SPEC-settings-9': 'agents',
  'SPEC-settings-10': 'kbs', 'SPEC-settings-11': 'kbs', 'SPEC-settings-12': 'kbs', 'SPEC-settings-13': 'kbs', 'SPEC-settings-14': 'kbs',
  'SPEC-settings-15': 'skills', 'SPEC-settings-16': 'skills', 'SPEC-settings-17': 'enums', 'SPEC-settings-18': 'incidents',
  'SPEC-settings-19': 'incidents', 'SPEC-settings-20': 'domains', 'SPEC-settings-21': 'appearance',
}

const STATUS_COLOR: Record<Status, string> = { 已整理: 'var(--ok)', 整理中: 'var(--accent)', 待整理: 'var(--warn)' }

export function OverviewPage({ benches, current, onOpen }: {
  benches: Workbench[]
  current: string
  onOpen: (key: OverviewKey, view?: string) => void
}) {
  const [q, setQ] = useState('')
  const [reading, setReading] = useState<{ key: string; spec: string } | null>(null)
  const status = useMemo(readStatus, [])
  const mods = useMemo(() => ALL.map((m) => {
    const st = status[m.key] ?? { status: '待整理' as Status, note: '', owner: '' }
    const parsed = st.status !== '待整理' ? readPages(m.key) : []
    // 规格里的页面清单优先；子页用编号对，规格新写的页面按名字从 DRAFT 里找
    const pages = parsed.length
      ? parsed.map((p) => ({ ...p, view: VIEW_OF[p.spec!] ?? DRAFT[m.key]?.find((d) => d.name === p.name)?.view }))
      : DRAFT[m.key] ?? []
    return { ...m, ...st, pages, hasSpec: parsed.length > 0 }
  }), [status])

  const bench = benches.find((w) => w.id === current) ?? benches[0]
  // 当前工作台没开的模块，点了先切到开着它的工作台
  const reach = (k: OverviewKey): { ok: boolean; via?: string } => {
    if (k === 'settings' || bench?.modules.includes(k)) return { ok: true }
    const w = benches.find((x) => x.modules.includes(k))
    return w ? { ok: true, via: w.name } : { ok: false }
  }

  const needle = q.trim().toLowerCase()
  const hit = (...xs: (string | undefined)[]) => !needle || xs.some((x) => x?.toLowerCase().includes(needle))
  const shown = mods.map((m) => {
    if (hit(m.label, m.key, m.desc)) return m
    return { ...m, pages: m.pages.filter((p) => hit(p.name, p.desc, p.entry, p.spec)) }
  }).filter((m) => m.pages.length || hit(m.label, m.key, m.desc))
  const done = mods.filter((m) => m.hasSpec).length

  return (
    <div className="page ov-page">
      <PageTitle count={`${MODULES.length} 个模块`} desc="原型每一页是做什么的、对应规格包哪一节；提需求时从这里找页面和编号">原型总览</PageTitle>
      <div className="toolbar">
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索模块、页面、规格编号" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="search-clear" onClick={() => setQ('')} title="清空">
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>}
        </div>
        <span className="faint ov-sum">规格已整理 {done} 个，待整理 {mods.length - done} 个；规格文件在 <code className="mono">{SPEC_DIR}/</code></span>
      </div>

      {!shown.length && <div className="empty"><div className="empty-title">没有匹配的页面</div><div className="faint">换个词，或者清空搜索</div></div>}
      <div className="ov-grid">
        {shown.map((m) => {
          const r = reach(m.key)
          return (
            <section key={m.key} className="ov-mod">
              <header className="ov-head">
                <div className="ov-title">
                  <span className="ov-name">{m.label}</span>
                  <code className="ov-key mono">{m.key}</code>
                  <span className="pill" style={{ '--c': STATUS_COLOR[m.status] } as CSSProperties}><span className="pill-dot" />{m.status === '待整理' ? '规格待整理' : `规格${m.status}`}</span>
                </div>
                <button className="act" disabled={!r.ok} onClick={() => onOpen(m.key)}
                  title={r.via ? `当前工作台没开这个模块，会切到「${r.via}」` : r.ok ? undefined : '没有工作台开着这个模块'}>
                  打开{r.via ? `（切到${r.via}）` : ''}
                </button>
              </header>
              <p className="ov-desc muted">{m.desc}</p>
              <div className="ov-meta faint">
                {m.hasSpec
                  ? <button className="ov-spec" onClick={() => setReading({ key: m.key, spec: `SPEC-${m.key}-0` })} title="看模块概述">SPEC-{m.key}</button>
                  : <span>规格待整理{m.owner ? `，${m.owner} 补` : ''}</span>}
                <span className="mono ov-path">{SPEC_DIR}/{m.key}.md</span>
                {m.note && <span>{m.note}</span>}
              </div>
              <ul className="ov-pages">
                {m.pages.map((p) => (
                  <li key={p.spec ?? p.name} className="ov-row">
                    <button className="ov-page-name" disabled={!r.ok} onClick={() => onOpen(m.key, p.view)} title={p.entry ? `入口：${p.entry}` : '在原型里打开'}>{p.name}</button>
                    <span className="ov-page-desc muted">{p.desc}</span>
                    {p.spec
                      ? <button className="ov-spec" onClick={() => setReading({ key: m.key, spec: p.spec! })}>{p.spec}</button>
                      : <span className="ov-spec-none faint">待整理</span>}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      {reading && <SpecReader at={reading} onGo={setReading} onClose={() => setReading(null)} />}
    </div>
  )
}

/* ---------- 规格章节阅读 ---------- */

function splitRow(line: string): string[] {
  if (!line.startsWith('|')) return []
  // 反引号里的竖线不算分隔
  const cells: string[] = []
  let cur = ''
  let tick = false
  for (let i = 1; i < line.length; i += 1) {
    const c = line[i]
    if (c === '`') tick = !tick
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i += 1; continue }
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  return cells
}

/** 一节：从「## SPEC-x-n 标题」到下一个二级标题 */
function sectionOf(src: string, spec: string): { title: string; body: string } | null {
  const lines = src.split('\n')
  const re = new RegExp(`^## ${spec}(?!\\d)\\s*(.*)$`)
  const at = lines.findIndex((l) => re.test(l))
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  return { title: lines[at].slice(3), body: lines.slice(at + 1, end < 0 ? undefined : end).join('\n') }
}

type Go = (key: string, spec: string) => void

/** 规格里的链接：本文件锚点和其它规格文件在阅读器里翻，截图目录等只显示路径 */
function link(text: ReactNode, href: string, here: string, go: Go, k: number): ReactNode {
  if (/^https?:/.test(href)) return <a key={k} href={href} target="_blank" rel="noreferrer">{text}</a>
  const m = /^(?:([a-z]+)\.md)?#spec-([a-z]+)-(\d+)/.exec(href)
  if (m) return <button key={k} className="ov-link" onClick={() => go(m[1] ?? here, `SPEC-${m[2]}-${m[3]}`)}>{text}</button>
  const f = /^([a-z]+)\.md$/.exec(href)
  if (f && specOf(f[1])) return <button key={k} className="ov-link" onClick={() => go(f[1], `SPEC-${f[1]}-0`)}>{text}</button>
  return <span key={k} className="ov-link-off" title={`${SPEC_DIR}/${href}`}>{text}</span>
}

function inline(text: string, here: string, go: Go): ReactNode[] {
  return text.split(/(!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|<br\s*\/?>)/g).filter(Boolean).map((part, i) => {
    const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(part)
    // 截图放在规格包目录里，原型的 dev server 能直接读到
    if (img) return <img key={i} className="ov-shot" src={encodeURI(`/docs/spec/${img[2]}`)} alt={img[1] || img[2]} loading="lazy" />
    const a = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (a) return link(inline(a[1], here, go), a[2], here, go, i)
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (/^<br/.test(part)) return <br key={i} />
    return part
  })
}

function renderSpec(src: string, here: string, go: Go): ReactNode[] {
  const lines = src.split('\n')
  const out: ReactNode[] = []
  const k = () => `b${out.length}`
  const il = (t: string) => inline(t, here, go)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i += 1 }
      i += 1
      out.push(<pre key={k()}><code>{buf.join('\n')}</code></pre>)
      continue
    }
    const h = /^(#{2,4})\s+(.*)$/.exec(line)
    if (h) {
      const Tag = (['h3', 'h4', 'h4'] as const)[h[1].length - 2]
      out.push(<Tag key={k()}>{il(h[2])}</Tag>)
      i += 1
      continue
    }
    if (line.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(splitRow(lines[i])); i += 1 }
      const [head, ...body] = rows
      const data = body.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)))
      out.push(
        <div key={k()} className="ov-table-wrap">
          <table className="ov-table">
            <thead><tr>{head.map((c, j) => <th key={j}>{il(c)}</th>)}</tr></thead>
            <tbody>{data.map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}>{il(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    const collect = (re: RegExp) => {
      const buf: string[] = []
      while (i < lines.length && (re.test(lines[i]) || (buf.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-\d]/.test(lines[i])))) {
        if (re.test(lines[i])) buf.push(lines[i].replace(re, ''))
        else buf[buf.length - 1] += ` ${lines[i].trim()}`
        i += 1
      }
      return buf
    }
    if (/^\s*-\s+/.test(line)) { out.push(<ul key={k()}>{collect(/^\s*-\s+/).map((t, j) => <li key={j}>{il(t)}</li>)}</ul>); continue }
    if (/^\s*\d+\.\s+/.test(line)) { out.push(<ol key={k()}>{collect(/^\s*\d+\.\s+/).map((t, j) => <li key={j}>{il(t)}</li>)}</ol>); continue }
    if (/^>\s?/.test(line)) { out.push(<blockquote key={k()}>{collect(/^>\s?/).map((t, j) => <p key={j}>{il(t)}</p>)}</blockquote>); continue }
    if (!line.trim()) { i += 1; continue }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*-\s|\s*\d+\.\s|>|```|\|)/.test(lines[i])) { buf.push(lines[i]); i += 1 }
    out.push(<p key={k()}>{il(buf.join(' '))}</p>)
  }
  return out
}

function SpecReader({ at, onGo, onClose }: { at: { key: string; spec: string }; onGo: (x: { key: string; spec: string }) => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const go: Go = (key, spec) => onGo({ key, spec })
  const src = specOf(at.key)
  const sec = src ? sectionOf(src, at.spec) : null
  const path = `${SPEC_DIR}/${at.key}.md`
  const ref = `${at.spec} ${path}`
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  useEffect(() => { setCopied(false); document.querySelector('.ov-reader .drawer-body')?.scrollTo(0, 0) }, [at.key, at.spec])
  return (
    <>
      <div className="ov-scrim" onClick={onClose} />
      <aside className="drawer ov-reader" aria-label="规格章节">
        <div className="drawer-head">
          <span className="drawer-kicker ellipsis">{path}</span>
          <div className="spacer" />
          <button className="act act-quiet" onClick={() => { navigator.clipboard?.writeText(ref); setCopied(true) }} title={ref}>{copied ? '已复制' : '复制编号和路径'}</button>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="drawer-body">
          {sec ? (
            <div className="md ov-md">
              <h2 className="ov-sec-title">{sec.title}</h2>
              {renderSpec(sec.body, at.key, go)}
            </div>
          ) : (
            <div className="empty"><div className="empty-title">规格里没找到 {at.spec}</div><div className="faint">{path} 可能改了编号，到文件里搜一下</div></div>
          )}
        </div>
      </aside>
    </>
  )
}
