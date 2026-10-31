// 渠道配置（IM-01b）：IM 消息页右上角「渠道配置」打开的抽屉，只列 IM 类连接器。
// 每个渠道显示状态、账号、最近同步时间、出错原因，能测试连接、立即同步、停用和启用、改配置；
// 没接过时给「接入 Slack」「接入 Telegram」两个入口。各渠道的表单在 channelForms.ts 里登记，没登记的去设置里的连接器页配，
// 跳过去时带上实例或工具，那边直接打开对应的抽屉（POL-01）。
// 列表下面是 IM 插件自己的设置：超过几天没处理的消息标为已过期（IM-07），0 为不过期。
import { useState, type CSSProperties } from 'react'
import {
  IM_EXPIRE_DAYS_MAX, errorText, useConnectorDefs, useConnectors, useImSettings, useImSyncConnector, usePatchConnector, usePatchImSettings, useTestConnector,
  type Connector, type ConnectorDef,
} from '../../core/data'
import { Drawer, ErrorState, Field, Input, LoadingState, cls } from '../../core/ui'
import { CHANNEL_FORMS } from './channelForms'
import { addableDefs, ENTRY_TOOLS, imConnectors, imDefs, intervalLabel, SELF_NAMES_FIELD, STATUS_TEXT, syncErrorText, syncText } from './channelModel'
import { timeAgo } from './model'
import { TELEGRAM_TOOL, telegramModeLabel } from './telegramModel'
import './channels.css'

type Note = { ok: boolean; text: string }
/** 抽屉里正在看的：列表，或某个渠道的表单（connector 为空是新建） */
type View = { kind: 'list' } | { kind: 'form'; tool: string; connector: Connector | null }

/** 去设置里的连接器页：connector 打开那个实例，tool 打开这个工具的，都不给是整页 */
export type ManageTarget = { connector?: string; tool?: string }

export function ChannelPanel({ onClose, onManageAll }: { onClose: () => void; onManageAll: (to?: ManageTarget) => void }) {
  const defs = useConnectorDefs()
  const connectors = useConnectors()
  const [view, setView] = useState<View>({ kind: 'list' })
  const list = imConnectors(defs.data, connectors.data)
  const defOf = (tool: string) => imDefs(defs.data).find((d) => d.tool === tool)
  const formDef = view.kind === 'form' ? defOf(view.tool) : undefined
  const Form = view.kind === 'form' ? CHANNEL_FORMS[view.tool] : undefined
  // 表单保存后实例的最新样子从列表缓存里取
  const formConn = view.kind === 'form' && view.connector ? list.find((c) => c.id === view.connector!.id) ?? view.connector : null

  let body
  if (defs.isError || connectors.isError) {
    body = <ErrorState title="渠道没加载出来" error={errorText(defs.error ?? connectors.error)} onRetry={() => { void defs.refetch(); void connectors.refetch() }} />
  } else if (defs.isPending || connectors.isPending) {
    body = <LoadingState />
  } else if (view.kind === 'form' && Form) {
    body = (
      <div className="im-chpanel">
        <button type="button" className="im-chback" onClick={() => setView({ kind: 'list' })}>返回渠道列表</button>
        <div className="im-chform-title">
          <i className="im-ch-dot" style={{ '--c': formDef?.color } as CSSProperties} />
          {formConn ? [formDef?.label ?? view.tool, formConn.name].filter((x, i, a) => a.indexOf(x) === i).join('：') : `接入 ${formDef?.label ?? view.tool}`}
        </div>
        {/* key 按渠道：新建保存后换成编辑同一条，表单不重置，结果提示留着 */}
        <Form key={view.tool} connector={formConn}
          onSaved={(c) => setView({ kind: 'form', tool: c.tool, connector: c })}
          onCancel={() => setView({ kind: 'list' })} />
      </div>
    )
  } else {
    const add = addableDefs(defs.data, connectors.data)
    const open = (tool: string, c: Connector | null) => setView({ kind: 'form', tool, connector: c })
    body = (
      <div className="im-chpanel">
        {list.length === 0 ? (
          <div className="empty empty-compact">
            <div className="empty-title">还没接入 IM 渠道</div>
            <div className="empty-desc">接入后，各渠道里的私信和 @ 会收进 IM 消息，也能直接从这里回复。凭证只存进本机保险箱。</div>
            <div className="im-chentry">
              {ENTRY_TOOLS.map((tool) => <EntryButton key={tool} tool={tool} def={defOf(tool)} onOpen={() => open(tool, null)} />)}
            </div>
          </div>
        ) : (
          <>
            <div className="im-chlist" role="list" aria-label="IM 渠道">
              {list.map((c) => (
                <ChannelCard key={c.id} c={c} def={defOf(c.tool)} hasForm={!!CHANNEL_FORMS[c.tool]}
                  onEdit={() => (CHANNEL_FORMS[c.tool] ? open(c.tool, c) : onManageAll({ connector: c.id }))} />
              ))}
            </div>
            {add.length > 0 && (
              <div className="im-chmore">
                <span className="im-muted">接入更多渠道</span>
                {add.map((d) => <EntryButton key={d.tool} tool={d.tool} def={d} onOpen={() => (CHANNEL_FORMS[d.tool] ? open(d.tool, null) : onManageAll({ tool: d.tool }))} />)}
              </div>
            )}
          </>
        )}
        <button type="button" className="im-chlink" onClick={() => onManageAll()}>在设置里管理全部连接器</button>
        <ExpirySetting />
      </div>
    )
  }

  return (
    <Drawer open onClose={onClose} kicker="IM 消息" aria-label="渠道配置" className="im-chdrawer">
      <h2 className="im-chhead">渠道配置</h2>
      {body}
    </Drawer>
  )
}

function EntryButton({ tool, def, onOpen }: { tool: string; def?: ConnectorDef; onOpen: () => void }) {
  const label = def?.label ?? (tool === 'slack' ? 'Slack' : tool === 'telegram' ? 'Telegram' : tool)
  return (
    <button type="button" className="btn btn-outline im-chentry-btn" disabled={!def} onClick={onOpen}
      title={def ? def.desc : `${label} 渠道还没装好：IM 插件没登记它的连接器`} style={{ '--c': def?.color } as CSSProperties}>
      <i className="im-ch-dot" />接入 {label}
    </button>
  )
}

function ChannelCard({ c, def, hasForm, onEdit }: { c: Connector; def?: ConnectorDef; hasForm: boolean; onEdit: () => void }) {
  const test = useTestConnector()
  const sync = useImSyncConnector()
  const patch = usePatchConnector()
  const [note, setNote] = useState<Note | null>(null)
  const st = STATUS_TEXT[c.status] ?? STATUS_TEXT.connecting
  const paused = c.status === 'paused'
  const off = paused || c.status === 'disconnected'
  const busy = test.isPending || sync.isPending || patch.isPending

  const runTest = () => {
    setNote(null)
    test.mutate(c.id, {
      onSuccess: (r) => setNote(r.ok ? { ok: true, text: `连接正常${r.account ? ` · ${r.account}` : ''}` } : { ok: false, text: r.message || '连不上' }),
      onError: (e) => setNote({ ok: false, text: `测试没发出去：${errorText(e)}` }),
    })
  }
  const runSync = () => {
    setNote(null)
    sync.mutate(c.id, {
      onSuccess: (r) => setNote({ ok: true, text: syncText(r) }),
      onError: (e) => setNote({ ok: false, text: syncErrorText(e) }),
    })
  }
  const toggle = () => {
    setNote(null)
    patch.mutate({ id: c.id, patch: { enabled: off } }, {
      // 重新启用后是「连接中」，顺手测一次
      onSuccess: () => { if (off) runTest() },
      onError: (e) => setNote({ ok: false, text: `${off ? '启用' : '停用'}失败：${errorText(e)}` }),
    })
  }

  return (
    <div role="listitem" className={cls('im-chcard', c.status === 'error' && 'bad', off && 'off')} aria-label={c.name}
      style={{ '--c': def?.color } as CSSProperties}>
      <div className="im-chcard-top">
        <i className="im-ch-dot" />
        <span className="im-chcard-name">{c.name}</span>
        {(def?.label ?? c.tool) !== c.name && <span className="im-muted">{def?.label ?? c.tool}</span>}
        <span className="spacer" />
        <span className={cls('im-chstatus', `im-chstatus-${st.tone}`)}>{st.label}</span>
      </div>
      <div className="im-chcard-meta im-muted">
        {c.account && <span>账号 {c.account}</span>}
        {c.config[SELF_NAMES_FIELD] && <span>我的称呼 {c.config[SELF_NAMES_FIELD]}</span>}
        <span>{c.last_sync_at ? `最近同步 ${timeAgo(c.last_sync_at)}` : '还没同步过'}</span>
        <span>{c.tool === TELEGRAM_TOOL ? telegramModeLabel(c) : intervalLabel(c.interval)}</span>
        <span>{c.direction === 'both' ? '收发' : '只收'}</span>
        {!c.available && <span className="im-err">定义不在了（提供它的插件停用了）</span>}
      </div>
      {c.status === 'error' && c.error && <div className="im-chcard-error" role="note">出错原因：{c.error}</div>}
      {/* 失败原因已经记在连接器上、上面显示过的，不再重复 */}
      {note && !(c.status === 'error' && !note.ok && note.text === c.error) && <div className={note.ok ? 'im-ok' : 'im-err'} role="status">{note.text}</div>}
      <div className="im-chcard-actions">
        <button type="button" className="btn btn-outline btn-sm" disabled={busy || !c.available} onClick={runTest}>{test.isPending ? '测试中…' : '测试连接'}</button>
        <button type="button" className="btn btn-outline btn-sm" disabled={busy || off || !c.available} onClick={runSync}
          title={off ? '停用、断开时不同步' : '不等同步间隔，马上拉一次'}>{sync.isPending ? '同步中…' : '立即同步'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={toggle}>{off ? '启用' : '停用'}</button>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onEdit}>{hasForm ? '配置' : '去设置里配置'}</button>
      </div>
    </div>
  )
}

/** 过期天数（IM-07）：整数 0..365，0 为不过期；前端只挡不是整数的，超出范围交给后端，原样显示它的 400 */
function ExpirySetting() {
  const settings = useImSettings()
  const save = usePatchImSettings()
  const days = settings.data?.expire_days
  // 没改过时跟着后端的值走
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const value = draft ?? (days === undefined ? '' : String(days))
  const n = Number(value)
  const bad = /^\d+$/.test(value.trim()) ? undefined : '填 0 或正整数'
  const changed = days !== undefined && !bad && n !== days

  const submit = () => {
    setNote(null)
    if (bad || !changed || save.isPending) return
    save.mutate({ expire_days: n }, {
      onSuccess: (r) => { setDraft(null); setNote({ ok: true, text: r.expire_days ? `已保存：超过 ${r.expire_days} 天没处理的消息标为已过期` : '已保存：消息不再过期' }) },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  return (
    <form className="im-chexpire" aria-label="消息过期" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="im-chexpire-title">消息过期</div>
      {settings.isError ? (
        <div className="im-err" role="alert">设置没加载出来：{errorText(settings.error)}</div>
      ) : (
        <>
          <Field label="过期天数" wrap={false} error={draft !== null ? bad : undefined}
            hint="超过 N 天没处理的消息标为已过期，0 为不过期。从收到（或重新打开）时算起，设了稍后还没到点的不算">
            <div className="im-chexpire-row">
              <Input type="number" min={0} max={IM_EXPIRE_DAYS_MAX} step={1} inputMode="numeric" className="im-chexpire-input" aria-label="过期天数"
                value={value} disabled={settings.isPending} invalid={draft !== null && !!bad}
                onChange={(e) => { setDraft(e.target.value); setNote(null) }} />
              <span className="im-muted">天</span>
              <button type="submit" className="btn btn-outline btn-sm" disabled={!changed || save.isPending}>{save.isPending ? '保存中…' : '保存'}</button>
            </div>
          </Field>
          {note && <div className={note.ok ? 'im-ok' : 'im-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
        </>
      )}
    </form>
  )
}
