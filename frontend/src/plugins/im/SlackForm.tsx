// 渠道配置里的 Slack 表单（IM-01b）：Slack App 的 Bot Token（xoxb-）和 Signing Secret 进保险箱，界面只显示脱敏提示；
// 监听频道（已保存的从列表勾选，core/ui/ChannelPicker）、我的 Member ID、同步间隔是普通配置。保存后自动做一次连通测试，账号写成「Bot 名（Member ID）」。
// 工作台不在公网上时 Slack 的事件推不进来，靠同步间隔定时拉；在公网上可以再配事件订阅，回调地址见表单底部。
// 身份（IM-06）：Bot（默认）或我本人。我本人填同一个 App 的 User OAuth Token（xoxp-），以本人身份读本人能看到的会话、
// 以本人名义回复；本人的 Member ID 由连通测试拿到，不用填。
import { useState } from 'react'
import {
  errorText, useCreateConnector, usePatchConnector, useTestConnector,
  type Connector, type ConnectorPatch,
} from '../../core/data'
import { Checkbox, Field, Input, Select } from '../../core/ui'
import { ChannelPicker } from '../../core/ui/ChannelPicker'
import {
  callbackUrl, intervalLabel, memberIdError, SELF_NAMES_FIELD, SELF_NAMES_HINT, SLACK_AS_BOT, SLACK_AS_USER, SLACK_IDENTITY_FIELD, SLACK_SCOPES,
  SLACK_USER_SCOPES, slackAs, slackTokenError, SYNC_INTERVALS, type SlackAs,
} from './channelModel'

export const SLACK_TOOL = 'slack'
const DEFAULT_INTERVAL = 5

export function SlackForm({ connector, onSaved, onCancel }: {
  /** 已有的实例：改配置；没有时新建 */
  connector?: Connector | null
  /** 保存并测试过：带着最新的实例 */
  onSaved?: (c: Connector) => void
  onCancel?: () => void
}) {
  const create = useCreateConnector()
  const patch = usePatchConnector()
  const test = useTestConnector()
  const [name, setName] = useState(connector?.name ?? 'Slack')
  const [as, setAs] = useState<SlackAs>(slackAs(connector))
  const [token, setToken] = useState('')
  const [signing, setSigning] = useState('')
  const [channels, setChannels] = useState(connector?.config.channels ?? '')
  const [self, setSelf] = useState(connector?.config.self_user_id ?? '')
  const [names, setNames] = useState(connector?.config[SELF_NAMES_FIELD] ?? '')
  const [every, setEvery] = useState(connector?.interval ?? DEFAULT_INTERVAL)
  const [reply, setReply] = useState((connector?.direction ?? 'both') === 'both')
  const [touched, setTouched] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const tokenHint = connector?.secret_hints.bot_token
  const signingHint = connector?.secret_hints.signing_secret
  const user = as === SLACK_AS_USER
  // 换了身份时已存的 Token 多半对不上，要重新填
  const asChanged = !!connector && as !== slackAs(connector)
  const tokenErr = slackTokenError(token, !!tokenHint && !asChanged, as)
  const selfErr = user ? undefined : memberIdError(self)
  const busy = create.isPending || patch.isPending || test.isPending
  const saveErr = create.error ?? patch.error

  const submit = async () => {
    setTouched(true)
    setResult(null)
    if (tokenErr || selfErr || busy) return
    const config = { [SLACK_IDENTITY_FIELD]: as, channels: channels.trim(), self_user_id: user ? '' : self.trim(), [SELF_NAMES_FIELD]: names.trim() }
    const secrets: Record<string, string> = {}
    if (token.trim()) secrets.bot_token = token.trim()
    if (signing.trim()) secrets.signing_secret = signing.trim()
    const direction = reply ? 'both' as const : 'receive' as const
    let saved: Connector
    try {
      if (connector) {
        const p: ConnectorPatch = { name: name.trim() || undefined, config, direction, interval: every }
        if (Object.keys(secrets).length) p.secrets = secrets
        saved = await patch.mutateAsync({ id: connector.id, patch: p })
      } else {
        saved = await create.mutateAsync({ tool: SLACK_TOOL, name: name.trim() || undefined, config, secrets, direction, interval: every })
      }
    } catch {
      return
    }
    setToken('')
    setSigning('')
    try {
      const r = await test.mutateAsync(saved.id)
      setResult(r.ok ? { ok: true, text: `已连上 ${r.account}` } : { ok: false, text: `已保存，但连不上：${r.message}` })
      onSaved?.(r.connector)
    } catch (e) {
      setResult({ ok: false, text: `已保存，测试没做成：${errorText(e)}` })
      onSaved?.(saved)
    }
  }

  return (
    <form className="im-chform" aria-label="Slack 渠道配置" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <div className="field">
        <span className="field-label">身份</span>
        <div className="im-chform-seg" role="group" aria-label="身份">
          {([SLACK_AS_BOT, SLACK_AS_USER] as const).map((v) => (
            <button key={v} type="button" className={as === v ? 'on' : undefined} aria-pressed={as === v} onClick={() => setAs(v)}>
              {v === SLACK_AS_BOT ? 'Bot' : '我本人（用户 Token）'}
            </button>
          ))}
        </div>
        <span className="im-muted">
          {user
            ? '用你自己的 Slack 账号：读你能看到的私信和频道，回复以你的名义发出；你自己在 Slack 里发的不进待处理，记成那条会话里的回复'
            : '用 Slack App 的 Bot：只看得到 Bot 被拉进去的频道和发给 Bot 的私信，回复以 Bot 名义发出'}
        </span>
      </div>
      {user ? (
        <ol className="im-chform-steps im-muted">
          <li>到 <b>api.slack.com/apps</b> 新建 App（From scratch）或用已有的，选工作区。</li>
          <li>OAuth &amp; Permissions 里给 <b>User Token Scopes</b> 加上 <code>{SLACK_USER_SCOPES.join(' ')}</code>，再 Install（或 Reinstall）to Workspace，自己点 Allow。</li>
          <li>复制同一页上的 <b>User OAuth Token</b>（xoxp- 开头）；用事件订阅时 Basic Information 里复制 Signing Secret。不用邀请 Bot 进频道。</li>
        </ol>
      ) : (
        <ol className="im-chform-steps im-muted">
          <li>到 <b>api.slack.com/apps</b> 新建 App（From scratch），选工作区。</li>
          <li>OAuth &amp; Permissions 里给 Bot Token Scopes 加上 <code>{SLACK_SCOPES.join(' ')}</code>，再 Install to Workspace，复制 Bot User OAuth Token。</li>
          <li>Basic Information 里复制 Signing Secret；在要监听的频道里 <code>/invite</code> 这个 Bot。</li>
        </ol>
      )}
      <Field label="名称">
        <Input value={name} placeholder="Slack" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={user ? 'User Token' : 'Bot Token'} required={!tokenHint || asChanged} error={touched ? tokenErr : undefined}
        hint={tokenHint && !asChanged ? `已保存（${tokenHint}），不改留空` : asChanged ? `换了身份，要重新填${user ? ' xoxp- 的 User Token' : ' xoxb- 的 Bot Token'}` : '只存进保险箱，界面上不再显示原文'}>
        <Input type="password" autoComplete="off" value={token} invalid={touched && !!tokenErr}
          placeholder={tokenHint && !asChanged ? '不改留空' : user ? 'xoxp-…' : 'xoxb-…'} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="Signing Secret"
        hint={signingHint ? `已保存（${signingHint}），不改留空` : '用事件订阅时必填，Slack 推来的消息按它验签；只用定时拉取可以先不填'}>
        <Input type="password" autoComplete="off" value={signing} placeholder={signingHint ? '不改留空' : 'Basic Information 页的 Signing Secret'}
          onChange={(e) => setSigning(e.target.value)} />
      </Field>
      {/* 已保存的连接器从 Token 看得到的会话里勾选；新建或拿不到列表时是文本框（逗号分隔，# 可省，也可以写频道 id） */}
      <Field label="监听频道" wrap={false} hint={`留空只收私信。${user ? '只收你在里面的频道' : 'Bot 要先被邀请进这些频道'}`}>
        <ChannelPicker label="监听频道" placeholder="#product, #feedback，逗号分隔" connectorId={connector?.id} value={channels} onChange={setChannels} />
      </Field>
      {!user && (
        <Field label="我的 Member ID" error={touched ? selfErr : undefined} hint="@ 到它的消息算「@我」；留空只认 @Bot">
          <Input value={self} invalid={touched && !!selfErr} placeholder="U01ABCDEF" onChange={(e) => setSelf(e.target.value)} />
        </Field>
      )}
      <Field label="我的称呼" hint={SELF_NAMES_HINT}>
        <Input value={names} placeholder="张三, Zhang" onChange={(e) => setNames(e.target.value)} />
      </Field>
      <Field label="同步间隔" hint="工作台不在公网上时 Slack 推不进来，靠定时拉 conversations.history 收消息">
        <Select value={String(every)} onValueChange={(v) => setEvery(Number(v))}
          options={SYNC_INTERVALS.map((n) => ({ value: String(n), label: intervalLabel(n) }))} />
      </Field>
      <Checkbox checked={reply} onCheckedChange={setReply}>{user ? '允许从这里回复（以你本人名义发 chat.postMessage）' : '允许从这里回复（经 Bot 发 chat.postMessage）'}</Checkbox>
      <div className="im-chform-note im-muted">
        在公网上时可改用事件订阅：Event Subscriptions 的 Request URL 填 <code className="im-chform-code">{callbackUrl(SLACK_TOOL)}</code>，
        在 {user ? 'Subscribe to events on behalf of users' : 'Subscribe to bot events'} 里订阅 <code>message.channels message.groups message.im message.mpim</code>。
      </div>
      {saveErr && <div className="im-err" role="alert">没保存：{errorText(saveErr)}</div>}
      {result && <div className={result.ok ? 'im-ok' : 'im-err'} role="status">{result.text}</div>}
      <div className="im-chform-actions">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>取消</button>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : connector ? '保存并测试' : '接入并测试'}</button>
      </div>
    </form>
  )
}
