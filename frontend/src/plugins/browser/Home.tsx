// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 新标签页（SPEC-browser-2）：最近打开、项目原型、Google 账号三块卡片。
// 原型列表和状态读项目插件的接口（经 core/data），浏览器插件不存原型。Drive 的文件浏览正式版不搬，卡片里只给账号状态和打开 Drive 网页
import { useState } from 'react'
import { Button, cls } from '../../core/ui'
import { prototypeUp, type BrowserGoogleState, type TerminalPrototype } from '../../core/data'
import { IconChev, IconX, KindIcon } from './icons'
import {
  PROTO_GROUP_SHOW, PROTO_MATCH_LIMIT, PROTO_SEARCH_MIN, displayUrl, groupProtos, protoMatcher, protoStatusColor, protoStatusLabel, protoUrl,
  timeAgo, type ProtoGroup, type Recent,
} from './model'

export const DRIVE_URL = 'https://drive.google.com/drive/my-drive'

export function HomeView({ prototypes, protoError, pendingProto, google, recent, onOpen, onStart, onLogin }: {
  prototypes: readonly TerminalPrototype[]
  /** 原型列表读不到（项目插件没开）时的说明 */
  protoError: string
  pendingProto?: string
  google: BrowserGoogleState | undefined
  recent: readonly Recent[]
  onOpen: (url: string, title?: string) => void
  onStart: (p: TerminalPrototype) => void
  onLogin: () => void
}) {
  const [q, setQ] = useState('')
  /** 手动展开收起过的组；key 加 :all 是「还有 N 个」点开过 */
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const { words, hit } = protoMatcher(q)
  const groups = groupProtos(prototypes)
  const running = prototypes.filter((p) => prototypeUp(p.status)).length
  const shown = words.length ? groups.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length) : groups
  const matched = shown.reduce((n, g) => n + g.items.length, 0)
  // 每组露哪几条：搜索时命中的全展开、总数封顶；不搜索时按展开收起，展开的先露 6 条
  const views: { g: ProtoGroup; isOpen: boolean; items: TerminalPrototype[]; rest: number }[] = []
  let budget = words.length ? PROTO_MATCH_LIMIT : Infinity
  for (const g of shown) {
    const isOpen = words.length > 0 || (open[g.key] ?? (g.live || prototypes.length <= PROTO_SEARCH_MIN || g.items.some((p) => p.id === pendingProto)))
    const full = words.length > 0 || !!open[`${g.key}:all`]
    const cap = full ? budget : Math.min(budget, PROTO_GROUP_SHOW)
    const items = isOpen && cap > 0 ? g.items.slice(0, cap) : []
    budget -= items.length
    views.push({ g, isOpen, items, rest: !full && isOpen ? g.items.length - items.length : 0 })
  }

  const row = (p: TerminalPrototype) => {
    const waiting = pendingProto === p.id
    return (
      <div key={p.id} className="br-proto">
        <span className="br-light" style={{ background: protoStatusColor(p) }} aria-hidden="true" />
        <div className="br-proto-text">
          <div className="ellipsis br-proto-name">{p.name}</div>
          <div className="faint ellipsis">127.0.0.1:{p.port} · {protoStatusLabel(p)}</div>
        </div>
        {prototypeUp(p.status) ? (
          <Button size="sm" variant="primary" onClick={() => onOpen(protoUrl(p))}>打开</Button>
        ) : waiting || p.status === 'starting' ? (
          <Button size="sm" variant="outline" disabled>{waiting ? '启动后自动打开' : '启动中'}</Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onStart(p)}>{p.status === 'crashed' ? '重新启动并打开' : '启动并打开'}</Button>
        )}
      </div>
    )
  }

  const account = google?.signed_in ? google.account : null

  return (
    <div className="br-home">
      {recent.length > 0 && (
        <section className="br-card" aria-label="最近打开">
          <div className="br-card-head"><h2>最近打开</h2></div>
          <div className="br-recent">
            {recent.map((r) => (
              <button key={r.url} type="button" className="br-recent-row" onClick={() => onOpen(r.url, r.title)}>
                <KindIcon kind={r.kind} />
                <span className="ellipsis br-recent-title">{r.title}</span>
                <span className="faint ellipsis br-recent-url">{displayUrl(r.url)}</span>
                <span className="faint br-recent-at">{timeAgo(r.at)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="br-card" aria-label="项目原型">
        <div className="br-card-head br-card-head-wrap">
          <h2>项目原型</h2><span className="faint br-card-sub">{running} / {prototypes.length} 个在运行</span>
          {prototypes.length > PROTO_SEARCH_MIN && (
            <div className="search search-sm br-proto-search">
              <input value={q} placeholder="搜原型、项目、端口" aria-label="搜索项目原型" onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
              {q && <button type="button" className="search-clear" aria-label="清空" onClick={() => setQ('')}><IconX size={10} /></button>}
            </div>
          )}
        </div>
        {protoError && !prototypes.length ? <div className="br-none">{protoError}</div>
          : !prototypes.length ? <div className="br-none">「项目」里还没有登记原型</div>
          : !shown.length ? <div className="br-none">没有匹配「{q.trim()}」的原型</div>
          : (
            <div className="br-pgroups">
              {views.map(({ g, isOpen, items, rest }) => {
                return (
                  <div key={g.key} className="br-pgroup">
                    <button type="button" className="br-pgroup-head" aria-expanded={isOpen} disabled={words.length > 0}
                      onClick={() => setOpen((s) => ({ ...s, [g.key]: !isOpen }))}>
                      <IconChev open={isOpen} />
                      <span className="ellipsis br-pgroup-name">{g.name}</span>
                      <span className={cls('br-pgroup-meta', g.running > 0 && 'on')}>
                        {words.length ? `${g.items.length} 个匹配` : g.running ? `${g.running} 个在运行` : `${g.items.length} 个原型`}
                        {!words.length && g.failed > 0 && <span className="br-pgroup-bad"> · {g.failed} 个启动失败</span>}
                      </span>
                    </button>
                    {items.length > 0 && (
                      <div className="br-protos">
                        {items.map(row)}
                        {rest > 0 && <button type="button" className="br-pgroup-rest" onClick={() => setOpen((s) => ({ ...s, [`${g.key}:all`]: true }))}>还有 {rest} 个原型</button>}
                      </div>
                    )}
                  </div>
                )
              })}
              {words.length > 0 && matched > PROTO_MATCH_LIMIT && <div className="br-none">还有 {matched - PROTO_MATCH_LIMIT} 个匹配的没显示，继续输入筛选</div>}
            </div>
          )}
      </section>

      <section className="br-card" aria-label="Google 账号">
        <div className="br-card-head"><h2>Google Drive</h2>{account && <span className="faint ellipsis">{account.email}</span>}</div>
        {account ? (
          <div className="br-drive-guest">
            <span className="muted">已连上 Google 账号，设置 / 连接器里的 Google Drive{google?.calendar?.authorized_at ? '、Google 日历' : ''}可以用了。云端硬盘的文件浏览以后接上，现在按网页打开。</span>
            <Button variant="outline" onClick={() => onOpen(DRIVE_URL)}>打开 Google Drive</Button>
          </div>
        ) : (
          <div className="br-drive-guest">
            <span className="muted">登录 Google 后，设置 / 连接器里的 Google Drive、Google 日历会一并连上</span>
            <Button variant="primary" onClick={onLogin}>登录 Google</Button>
          </div>
        )}
      </section>
    </div>
  )
}
