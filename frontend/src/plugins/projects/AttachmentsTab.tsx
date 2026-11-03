// 附件标签（SPEC-projects-5）：项目沟通消息里的全部附件集中管理——已加入资料的、不加入的、待决定的都列出来。
// 原来是沟通标签顶部的「消息里的附件」收件箱，挪成独立标签；沟通标签只留一行「N 个附件待决定」的入口。
// 消息来源同沟通标签（useProjectMessages：绑定会话 + 归到项目的消息）；获取、加入资料、不加入用 core/data 的 attachments，
// 预览用 core/ui 的 AttachmentPreview（插件间不能 import IM 插件的弹窗）。「已加入」按资料 value 认，「不加入」记在项目 props.skipped_attachments。
// IM 插件没在跑时标签条不显示这个标签；直接打开地址时提示去插件管理。全部走现有接口，没有新后端。
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  attachmentHref, errorText, fmtBytes, needsFetch, useAddAttachmentToProject, useAddAttachmentsToProject, useFetchAttachment, useSkipAttachments,
  type ImMessage,
} from '../../core/data'
import { Button, EmptyState, ErrorState, IconClose, IconSearch, LoadingState, cls } from '../../core/ui'
import { AttachmentKindIcon, AttachmentPreview } from '../../core/ui/AttachmentPreview'
import {
  ATT_KINDS, ATT_SEGS, STATE_LABEL, canBatchAdd, canBatchSkip, fetchLabel, filterRows, kindCounts, segCounts, todoCount,
  type AttKind, type AttRow, type AttState,
} from './attachmentModel'
import { whoName } from './commsModel'
import { ago } from './model'
import { ATT_PAGE, useProjectAttachments } from './projectMessages'

const PLUGINS_PATH = '/settings/plugins'
const MESSAGES_PATH = '/messages'
/** 标签条「附件」上的数字：待决定的个数；没有或还没算出来时不显示 */
export function AttachmentsTabCount({ projectId }: { projectId: string }) {
  const { rows, ready } = useProjectAttachments(projectId)
  const n = ready ? todoCount(rows) : 0
  return n ? <span className="seg-n pj-tab-n" title={`${n} 个附件待决定`}>{n}</span> : null
}

/** 沟通标签里的一行入口：有待决定的附件时出现 */
export function AttachmentsHint({ projectId, onGo }: { projectId: string; onGo: () => void }) {
  const { rows, ready } = useProjectAttachments(projectId)
  const n = ready ? todoCount(rows) : 0
  if (!n) return null
  return (
    <button type="button" className="pj-att-hint-line" onClick={onGo}>
      <AttachmentKindIcon kind="file" />消息里有 {n} 个附件待决定要不要放进支持材料<span className="pj-link">去附件标签</span>
    </button>
  )
}

export function AttachmentsTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { rows, ready, noIm, msgs, mats, project, binds } = useProjectAttachments(projectId)
  const skip = useSkipAttachments(projectId)
  const addMany = useAddAttachmentsToProject()
  const [seg, setSeg] = useState<AttState | ''>('todo')
  const [kind, setKind] = useState<AttKind | ''>('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState('')
  const [err, setErr] = useState('')
  const view = `${seg}\u0000${kind}\u0000${q.trim()}`
  const [lim, setLim] = useState({ view, n: ATT_PAGE })
  const limit = lim.view === view ? lim.n : ATT_PAGE
  // 相对时间每分钟重算
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const shown = filterRows(rows, { seg, kind, q })
  const counts = segCounts(rows, { kind, q })
  const kinds = kindCounts(rows, { seg, q })
  // 选中的只认当前筛选里还在、还能批量操作的
  const picked = shown.filter((r) => sel.has(r.key) && canBatchAdd(r))
  const pickable = shown.slice(0, limit).filter(canBatchAdd)
  const allPicked = pickable.length > 0 && pickable.every((r) => sel.has(r.key))
  const busy = skip.isPending || addMany.isPending

  const toggle = (key: string, on: boolean) => {
    const next = new Set(sel)
    if (on) next.add(key)
    else next.delete(key)
    setSel(next)
  }
  const openMessage = (m: ImMessage) => navigate(`${MESSAGES_PATH}?m=${encodeURIComponent(m.id)}`)
  const openMaterial = (id: string) => navigate(`${pathname.replace(/\/attachments\/?$/, '/materials')}?mt=${encodeURIComponent(id)}`)
  const setSkip = (rs: readonly AttRow[], v: boolean) => {
    setErr('')
    skip.mutate({ refs: rs.map((r) => ({ messageId: r.m.id, attachmentId: r.a.id })), skip: v }, {
      onSuccess: () => setSel(new Set([...sel].filter((k) => !rs.some((r) => r.key === k)))),
      onError: (e) => setErr(`没改成：${errorText(e)}`),
    })
  }
  const addPicked = () => {
    const rs = picked
    setErr('')
    addMany.mutate(rs.map((r) => ({ message: r.m, attachmentId: r.a.id, projectId })), {
      onSuccess: ({ failed }) => {
        const bad = new Set(failed.map((f) => `${f.input.message.id}:${f.input.attachmentId}`))
        setSel(new Set([...sel].filter((k) => bad.has(k))))
        if (failed.length) {
          const name = (f: (typeof failed)[number]) => f.input.message.attachments.find((a) => a.id === f.input.attachmentId)?.name ?? f.input.attachmentId
          setErr(`${failed.length} 个没加进去：${failed.map((f) => `${name(f)}（${errorText(f.error)}）`).join('、')}`)
        }
      },
      onError: (e) => setErr(`没加进去：${errorText(e)}`),
    })
  }

  if (noIm) {
    return (
      <EmptyState title="需要 IM 消息插件" desc="附件来自项目沟通里的消息。装上并启用 IM 消息插件后，绑定的群和私聊里的附件会出现在这里"
        action={<Button variant="primary" onClick={() => navigate(PLUGINS_PATH)}>去插件管理</Button>} />
    )
  }
  if (msgs.isError && !msgs.data.length) return <ErrorState title="消息没加载出来" error={errorText(msgs.error)} onRetry={msgs.refetch} />
  if (mats.isError) return <ErrorState title="支持材料没加载出来，判断不了哪些已加入" error={errorText(mats.error)} onRetry={() => void mats.refetch()} />
  if (project.isError && !project.data) return <ErrorState title="项目没加载出来" error={errorText(project.error)} onRetry={() => void project.refetch()} />
  if (!ready || binds.isPending) return <LoadingState />
  if (!rows.length) {
    return <EmptyState title="消息里还没有附件" desc="绑定的群和私聊里、归到这个项目的消息带的文件、图片、链接会出现在这里，逐个决定要不要放进支持材料" />
  }

  const segN = (k: AttState | '') => (k ? counts[k] : counts.all)
  const narrowed = !!kind || !!q.trim()
  const items = shown.map((r) => ({ key: r.key, msg: r.m, a: r.a }))

  return (
    <div className="pj-tab pj-atts">
      <div className="pj-toolbar">
        <div className="pj-seg" role="group" aria-label="去向">
          {ATT_SEGS.map((s) => (
            <button key={s.key || 'all'} type="button" className={cls(seg === s.key && 'on')} aria-pressed={seg === s.key} onClick={() => setSeg(s.key)}>
              {s.label}<span className="seg-n">{segN(s.key)}</span>
            </button>
          ))}
        </div>
        <label className={cls('chip chip-select', kind && 'chip-on')}>
          <select value={kind} aria-label="种类" onChange={(e) => setKind(e.target.value as AttKind | '')}>
            <option value="">全部种类</option>
            {ATT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}（{kinds[k.key]}）</option>)}
          </select>
        </label>
        <div className="search">
          <IconSearch />
          <input type="search" placeholder="搜文件名、发信人、群名" aria-label="搜索附件" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ('') } }} />
          {q && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
        </div>
      </div>
      {picked.length > 0 && (
        <div className="pj-att-bulk" role="group" aria-label="批量操作">
          <span>已选 {picked.length} 个</span>
          <Button size="sm" variant="primary" disabled={busy} onClick={addPicked}>{addMany.isPending ? '加入中…' : '加入资料'}</Button>
          <Button size="sm" disabled={busy || !picked.some(canBatchSkip)} title={picked.some(canBatchSkip) ? '只对待决定的生效' : '选中的都不是待决定的'}
            onClick={() => setSkip(picked.filter(canBatchSkip), true)}>不加入</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSel(new Set())}>取消选择</Button>
        </div>
      )}
      {err && <div className="pj-err" role="alert">{err}</div>}
      {msgs.isError && <ErrorState compact title="有的会话消息没加载出来" error={errorText(msgs.error)} onRetry={msgs.refetch} />}
      {shown.length ? (
        <div className="pj-atl" role="table" aria-label="项目附件">
          <div className="pj-atl-row pj-atl-head" role="row">
            <span role="columnheader">
              <input type="checkbox" aria-label="全选这一页能操作的" checked={allPicked} disabled={!pickable.length}
                onChange={(e) => setSel(e.target.checked ? new Set([...sel, ...pickable.map((r) => r.key)]) : new Set([...sel].filter((k) => !pickable.some((r) => r.key === k))))} />
            </span>
            <span role="columnheader">附件</span>
            <span role="columnheader">来自</span>
            <span role="columnheader">时间</span>
            <span role="columnheader">获取</span>
            <span role="columnheader">去向</span>
            <span role="columnheader" className="pj-atl-ops">操作</span>
          </div>
          {shown.slice(0, limit).map((r) => (
            <AttLine key={r.key} projectId={projectId} r={r} now={now} checked={sel.has(r.key)} busy={busy}
              onCheck={(v) => toggle(r.key, v)} onSkip={(v) => setSkip([r], v)} onPreview={() => setPreview(r.key)}
              onOpenMessage={() => openMessage(r.m)} onOpenMaterial={openMaterial} />
          ))}
        </div>
      ) : (
        <EmptyState compact title={narrowed ? '没有匹配的附件' : seg === 'todo' ? '都处理过了' : `没有${STATE_LABEL[seg || 'todo']}的附件`}
          desc={narrowed ? '换个关键词，或清掉种类筛选' : undefined}
          action={narrowed ? <Button onClick={() => { setQ(''); setKind('') }}>清掉筛选</Button> : seg ? <Button onClick={() => setSeg('')}>看全部</Button> : undefined} />
      )}
      {shown.length > limit && (
        <button type="button" className="pj-more" onClick={() => setLim({ view, n: limit + ATT_PAGE })}>
          再显示 {Math.min(ATT_PAGE, shown.length - limit)} 个<span className="pj-muted">还有 {shown.length - limit} 个</span>
        </button>
      )}
      {preview && <AttachmentPreview items={items} startKey={preview} onClose={() => setPreview('')} />}
    </div>
  )
}

/** 一个附件一行：勾选、名字和种类大小、来自（点开来源消息）、时间、获取状态、去向、操作 */
function AttLine({ projectId, r, now, checked, busy, onCheck, onSkip, onPreview, onOpenMessage, onOpenMaterial }: {
  projectId: string; r: AttRow; now: number; checked: boolean; busy: boolean
  onCheck: (v: boolean) => void; onSkip: (v: boolean) => void; onPreview: () => void
  onOpenMessage: () => void; onOpenMaterial: (id: string) => void
}) {
  const { m, a, state } = r
  const fetchM = useFetchAttachment()
  const addM = useAddAttachmentToProject()
  const fetching = fetchM.isPending || a.fetch === 'fetching' || (addM.isPending && needsFetch(a))
  const fetchErr = a.fetch === 'error' ? a.error || '获取失败' : fetchM.isError ? errorText(fetchM.error) : ''
  const addErr = addM.isError ? errorText(addM.error) : ''
  const href = attachmentHref(a)
  const who = whoName(m)
  const where = m.conversation || '私聊'
  const sub = a.kind === 'link' ? a.url ?? '' : [fmtBytes(a.size), a.fetch === 'done' ? a.local : ''].filter(Boolean).join(' · ')
  return (
    <div className={cls('pj-atl-row', `pj-atl-${state}`, checked && 'on')} role="row" aria-label={a.name}>
      <span role="cell">
        <input type="checkbox" aria-label={`选中 ${a.name}`} checked={checked} disabled={state === 'added'}
          title={state === 'added' ? '已加入资料' : undefined} onChange={(e) => onCheck(e.target.checked)} />
      </span>
      <span role="cell" className="pj-atl-name">
        <span className={cls('pj-att-ico', `pj-att-${a.kind}`)} title={kindName(a.kind)}><AttachmentKindIcon kind={a.kind} /></span>
        <span className="pj-att-main">
          {a.kind === 'link' && a.url
            ? <a className="pj-att-name ellipsis" href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>{a.name}</a>
            : <b className="pj-att-name ellipsis" title={a.name}>{a.name}</b>}
          <span className="pj-att-sub ellipsis" title={sub}><span className="pj-atl-kind">{kindName(a.kind)}</span>{sub && ` · ${sub}`}</span>
        </span>
      </span>
      <span role="cell" className="pj-atl-from">
        <button type="button" className="pj-atl-src" title={`打开来源消息：${m.text}`} onClick={onOpenMessage}>
          <b className="ellipsis">{who}</b><span className="pj-muted ellipsis">{where}</span>
        </button>
      </span>
      <span role="cell" className="pj-muted" title={m.at}>{ago(m.at, now)}</span>
      <span role="cell" className={cls('pj-atl-fetch', !fetching && fetchErr && 'pj-err')} title={fetchErr || undefined}>
        {fetching ? '获取中…' : fetchErr && a.fetch !== 'error' ? '获取失败' : fetchLabel(a)}
      </span>
      <span role="cell" className="pj-atl-state">
        {state === 'added' && r.material
          ? <button type="button" className="pj-link" title="到支持材料里看这一条" onClick={() => onOpenMaterial(r.material!.id)}>已加入资料</button>
          : <span className={cls('pj-atl-tag', `pj-atl-tag-${state}`)}>{STATE_LABEL[state]}</span>}
      </span>
      <span role="cell" className="pj-att-acts pj-atl-ops">
        {needsFetch(a) && !fetching && (
          <button type="button" className="pj-att-act" disabled={addM.isPending}
            onClick={() => { addM.reset(); fetchM.mutate({ messageId: m.id, attachmentId: a.id }) }}>
            {a.fetch === 'error' || fetchM.isError ? '重试' : '获取'}
          </button>
        )}
        {a.kind !== 'link' && <button type="button" className="pj-att-act" onClick={onPreview}>预览</button>}
        {a.kind === 'link' && href && <a className="pj-att-act" href={href} target="_blank" rel="noopener noreferrer">打开</a>}
        {a.kind !== 'link' && href && <a className="pj-att-act" href={href} download={a.name}>下载</a>}
        {state !== 'added' && (
          <button type="button" className="pj-att-act pj-att-primary" disabled={fetching || addM.isPending || busy}
            onClick={() => { fetchM.reset(); addM.mutate({ message: m, attachmentId: a.id, projectId }) }}>
            {addM.isPending ? '加入中…' : needsFetch(a) ? '获取并加入' : '加入资料'}
          </button>
        )}
        {state === 'todo' && <button type="button" className="pj-att-act pj-att-quiet" disabled={busy || addM.isPending} onClick={() => onSkip(true)}>不加入</button>}
        {state === 'skipped' && <button type="button" className="pj-att-act pj-att-quiet" disabled={busy || addM.isPending} onClick={() => onSkip(false)}>撤销不加入</button>}
      </span>
      {addErr && <span className="pj-att-note pj-err" role="alert">没加进去：{addErr}</span>}
    </div>
  )
}

const kindName = (k: AttKind) => ATT_KINDS.find((x) => x.key === k)?.label ?? k
