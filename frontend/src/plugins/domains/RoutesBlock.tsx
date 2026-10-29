// 域名表（SPEC-settings-20.8 到 20.19、20.22 到 20.27）：加、改启停、删、测试、复制；手动配的一块，项目原型自动分配的按项目分组。
// 自动分配的行由 DOM-02a 建，这里只显示；改了某一条后端就把它转成手动配置
import { Fragment, useMemo, useState } from 'react'
import {
  errorText, useAddDomainRoute, useCheckDomainRoute, useDeleteDomainRoute, usePatchDomainRoute,
  type DomainRoute, type DomainSettings, type DomainTarget, type TerminalPrototype,
} from '../../core/data'
import { Button, cls, IconButton, IconChevronRight, IconClose, IconSearch, SearchSelect, Switch } from '../../core/ui'
import {
  conflicts, domainUrl, groupAuto, hostError, matchRoute, protoDown, targetLabel, timeAgo, normName,
} from './model'

type Kind = DomainTarget['kind']
const KINDS: [Kind, string][] = [['url', '地址'], ['proto', '项目原型'], ['app', '这个工作台']]
const EMPTY_DRAFT = { host: '', kind: 'url' as Kind, proto: '', url: 'http://127.0.0.1:', note: '' }

export function RoutesBlock({ s, query, protos, suffixBad, copied, onCopy, onAutoProto }: {
  s: DomainSettings
  query: { data?: DomainRoute[]; error: unknown; isError: boolean }
  protos: readonly TerminalPrototype[]
  suffixBad: boolean
  copied: string | null
  onCopy: (key: string, text: string) => void
  onAutoProto: (v: boolean) => void
}) {
  const all = useMemo(() => query.data ?? [], [query.data])
  const add = useAddDomainRoute()
  const patch = usePatchDomainRoute()
  const del = useDeleteDomainRoute()
  const check = useCheckDomainRoute()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [q, setQ] = useState('')
  const [askDel, setAskDel] = useState<string | null>(null)
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set())
  /** 手动展开、收起过的项目组；没动过的按规则 */
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [rowErr, setRowErr] = useState<{ id: string; text: string } | null>(null)

  const dup = conflicts(all, s.aliases)
  const label = (r: DomainRoute) => targetLabel(r, s, protos)
  const kw = q.trim()
  const hit = (r: DomainRoute) => matchRoute(r, kw, label(r))
  const manual = all.filter((r) => !r.auto && hit(r))
  const autoAll = all.filter((r) => r.auto)
  const groups = groupAuto(autoAll.filter(hit), protos, dup)
  // 总数 12 个以内默认全展开；否则有问题的组、搜索命中的组展开
  const groupOpen = (g: { name: string; bad: number }) => toggled[g.name] ?? (!!kw || g.bad > 0 || autoAll.length <= 12)
  const hostErr = hostError(draft.host, all)
  const canAdd = !!draft.host && !hostErr && !add.isPending && (draft.kind !== 'proto' || !!draft.proto)
    && (draft.kind !== 'url' || /^https?:\/\/.+/.test(draft.url.trim()))

  // 原型选项按项目分组，同一项目的排在一起
  const protoOptions = useMemo(() => {
    const order = [...new Set(protos.map((p) => p.project_title))]
    return [...protos].sort((a, b) => order.indexOf(a.project_title) - order.indexOf(b.project_title))
      .map((p) => ({ value: p.id, label: p.name, hint: `:${p.port}`, group: p.project_title, keywords: `${p.project_title} ${p.port}` }))
  }, [protos])

  const fail = (id: string) => (e: unknown) => setRowErr({ id, text: errorText(e) })
  const runCheck = (r: DomainRoute) => {
    setChecking((xs) => new Set(xs).add(r.id))
    check.mutateAsync(r.id).catch(fail(r.id)).finally(() => setChecking((xs) => { const n = new Set(xs); n.delete(r.id); return n }))
  }
  const toggle = (r: DomainRoute, enabled: boolean) => {
    setRowErr(null)
    patch.mutateAsync({ id: r.id, patch: { enabled } }).catch(fail(r.id))
  }
  const remove = (r: DomainRoute) => {
    setRowErr(null)
    del.mutateAsync(r.id).then(() => setAskDel(null), fail(r.id))
  }
  const submit = () => {
    if (!canAdd) return
    const target: DomainTarget = draft.kind === 'app' ? { kind: 'app' }
      : draft.kind === 'proto' ? { kind: 'proto', proto_id: draft.proto } : { kind: 'url', url: draft.url.trim() }
    add.mutateAsync({ host: draft.host, target, enabled: true, note: draft.note.trim() })
      .then(() => { setAdding(false); setDraft(EMPTY_DRAFT); add.reset() }, () => {})
  }

  const row = (r: DomainRoute) => {
    const bad = r.enabled && dup.has(r.fqdn)
    const c = r.check
    const busy = checking.has(r.id)
    const clickable = s.enabled && r.enabled
    return (
      <div key={r.id} className={cls('dm-row', !r.enabled && 'dm-row-off', bad && 'bad')} role="listitem" data-id={r.id}>
        <Switch checked={r.enabled} onCheckedChange={(v) => toggle(r, v)} aria-label={`启用 ${r.fqdn}`} title={r.enabled ? '停用' : '启用'} />
        <span className="dm-host">
          {clickable
            ? <a className="dm-link mono ellipsis" href={domainUrl(r, s)} target="_blank" rel="noreferrer">{r.fqdn}</a>
            : <span className="dm-link off mono ellipsis">{r.fqdn}</span>}
          <span className="dm-hint ellipsis">
            {r.auto && <span className="tag dm-tag">自动</span>}{r.note}
            {bad && <span className="danger-text"> 和另一条同名</span>}
            {protoDown(r, protos) && <span className="dm-faint"> 原型没在运行</span>}
          </span>
        </span>
        <span className="dm-target ellipsis mono" title={label(r)}>{label(r)}</span>
        <span className={cls('dm-check', !busy && c && (c.ok ? 'ok' : 'warn'))} title={c?.message}>
          {busy ? '测试中…' : c ? `${c.ok ? '正常' : '有问题'} · ${timeAgo(c.at)}` : ''}
        </span>
        <span className="dm-acts">
          {askDel === r.id ? (
            <>
              <span className="danger-text">删除这个域名？</span>
              <Button size="sm" onClick={() => setAskDel(null)}>取消</Button>
              <Button size="sm" variant="danger" disabled={del.isPending} onClick={() => remove(r)}>删除</Button>
            </>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => runCheck(r)}>测试</Button>
              <Button size="sm" onClick={() => onCopy('url:' + r.id, domainUrl(r, s))}>{copied === 'url:' + r.id ? '已复制' : '复制'}</Button>
              {!r.auto && r.target.kind !== 'app' && (
                <IconButton size="sm" label={`删除 ${r.fqdn}`} title="删除" onClick={() => setAskDel(r.id)}><IconClose /></IconButton>
              )}
            </>
          )}
        </span>
        {!busy && c && !c.ok && <span className="dm-check-msg">{c.message}</span>}
        {rowErr?.id === r.id && <span className="dm-check-msg danger-text" role="alert">{rowErr.text}</span>}
      </div>
    )
  }

  return (
    <section className={cls('dm-sec dm-routes', !s.enabled && 'dm-off')} aria-label="域名">
      <div className="dm-sec-head">
        <div className="dm-title">域名<span className="dm-title-hint">{all.filter((r) => r.enabled).length} 个启用</span></div>
        <div className="search search-sm dm-search">
          <IconSearch />
          <input placeholder="搜域名、目标地址或端口" aria-label="搜域名" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Switch checked={s.auto_proto} onCheckedChange={onAutoProto}>项目原型自动分配</Switch>
        <Button size="sm" variant="outline" aria-expanded={adding} onClick={() => setAdding(!adding)}>加一个</Button>
      </div>

      {adding && (
        <div className="dm-add" role="form" aria-label="加域名">
          <div className={cls('dm-suffix', hostErr && 'bad')}>
            <input className="mono" placeholder="子域名" aria-label="子域名" value={draft.host} spellCheck={false}
              onChange={(e) => setDraft({ ...draft, host: normName(e.target.value) })} />
            <span className="dm-faint">.{s.suffix}</span>
          </div>
          <div className="dm-seg" role="group" aria-label="目标">
            {KINDS.map(([k, l]) => (
              <button key={k} type="button" className={cls(draft.kind === k && 'on')} aria-pressed={draft.kind === k}
                onClick={() => setDraft({ ...draft, kind: k })}>{l}</button>
            ))}
          </div>
          {draft.kind === 'url' && (
            <input className="input mono dm-grow" aria-label="目标地址" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          )}
          {draft.kind === 'proto' && (
            <SearchSelect variant="field" className="dm-grow" value={draft.proto} placeholder="选原型…" searchPlaceholder="搜原型、项目、端口"
              options={protoOptions} emptyText="还没有项目原型" missingLabel={() => '已删除的原型'} aria-label="目标原型"
              onChange={(v) => setDraft({ ...draft, proto: v })} />
          )}
          <input className="input dm-grow" placeholder="备注（可选）" aria-label="备注" value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          {hostErr && <span className="danger-text">{hostErr}</span>}
          {add.isError && <span className="danger-text" role="alert">{errorText(add.error)}</span>}
          <Button size="sm" variant="primary" disabled={!canAdd} onClick={submit}>添加</Button>
          <Button size="sm" onClick={() => { setAdding(false); add.reset() }}>取消</Button>
        </div>
      )}

      {query.isError && !query.data && <div className="dm-err" role="alert">读不到域名：{errorText(query.error)}</div>}
      {suffixBad && <div className="dm-hint danger-text">后缀不合法，下面的域名都用不了</div>}

      <div className="dm-label-row">手动配置 {manual.length}{kw && <span className="dm-title-hint">搜索「{kw}」</span>}</div>
      {manual.length
        ? <div className="dm-table" role="list" aria-label="手动配置">{manual.map(row)}</div>
        : <div className="dm-empty">{kw ? '没有匹配的手动域名' : '还没有手动配置的域名'}</div>}

      {s.auto_proto && (
        <>
          <div className="dm-label-row">项目原型自动分配 {autoAll.length}<span className="dm-title-hint">跟着原型走，不用手动维护；改了某一条就转成手动配置</span></div>
          {groups.length ? (
            <div className="dm-table" role="list" aria-label="项目原型自动分配">
              {groups.map((g) => {
                const open = groupOpen(g)
                const flip = () => setToggled({ ...toggled, [g.name]: !open })
                return (
                  <Fragment key={g.name}>
                    <div className={cls('dm-row', g.bad > 0 && 'bad')} role="listitem">
                      <IconButton size="sm" label={open ? '收起' : '展开'} aria-expanded={open} onClick={flip}>
                        <span className={cls('dm-chev', open && 'open')}><IconChevronRight /></span>
                      </IconButton>
                      <span className="dm-host">
                        <b className="ellipsis">{g.name}</b>
                        <span className="dm-hint ellipsis">{g.xs.length} 个域名，{g.on} 个启用</span>
                      </span>
                      <span className={cls('dm-target', g.bad > 0 && 'danger-text')}>{g.bad ? `${g.bad} 个冲突或测试失败` : '没有问题'}</span>
                      <span />
                      <span className="dm-acts"><Button size="sm" onClick={flip}>{open ? '收起' : '展开'}</Button></span>
                    </div>
                    {open && g.xs.map(row)}
                  </Fragment>
                )
              })}
            </div>
          ) : <div className="dm-empty">{kw ? '没有匹配的原型域名' : protos.length ? '还没有自动分配的原型域名' : '项目里还没有原型'}</div>}
        </>
      )}
    </section>
  )
}
