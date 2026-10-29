// 渠道配置里的 Slack 表单（IM-01b）：Slack App 的 Bot Token（xoxb-）和 Signing Secret 进保险箱，界面只显示脱敏提示；
// 监听频道、我的 Member ID、同步间隔是普通配置。保存后自动做一次连通测试，账号写成「Bot 名（Member ID）」。
// 工作台不在公网上时 Slack 的事件推不进来，靠同步间隔定时拉；在公网上可以再配事件订阅，回调地址见表单底部。
import { useState } from 'react'
import {
  errorText, useCreateConnector, usePatchConnector, useTestConnector,
  type Connector, type ConnectorPatch,
} from '../../core/data'
import { Checkbox, Field, Input, Select } from '../../core/ui'
import { callbackUrl, intervalLabel, memberIdError, SLACK_SCOPES, slackTokenError, SYNC_INTERVALS } from './channelModel'

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
  const [token, setToken] = useState('')
  const [signing, setSigning] = useState('')
  const [channels, setChannels] = useState(connector?.config.channels ?? '')
  const [self, setSelf] = useState(connector?.config.self_user_id ?? '')
  const [every, setEvery] = useState(connector?.interval ?? DEFAULT_INTERVAL)
  const [reply, setReply] = useState((connector?.direction ?? 'both') === 'both')
  const [touched, setTouched] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const tokenHint = connector?.secret_hints.bot_token
  const signingHint = connector?.secret_hints.signing_secret
  const tokenErr = slackTokenError(token, !!tokenHint)
  const selfErr = memberIdError(self)
  const busy = create.isPending || patch.isPending || test.isPending
  const saveErr = create.error ?? patch.error

  const submit = async () => {
    setTouched(true)
    setResult(null)
    if (tokenErr || selfErr || busy) return
    const config = { channels: channels.trim(), self_user_id: self.trim() }
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
      <ol className="im-chform-steps im-muted">
        <li>到 <b>api.slack.com/apps</b> 新建 App（From scratch），选工作区。</li>
        <li>OAuth &amp; Permissions 里给 Bot Token Scopes 加上 <code>{SLACK_SCOPES.join(' ')}</code>，再 Install to Workspace，复制 Bot User OAuth Token。</li>
        <li>Basic Information 里复制 Signing Secret；在要监听的频道里 <code>/invite</code> 这个 Bot。</li>
      </ol>
      <Field label="名称">
        <Input value={name} placeholder="Slack" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Bot Token" required={!tokenHint} error={touched ? tokenErr : undefined}
        hint={tokenHint ? `已保存（${tokenHint}），不改留空` : '只存进保险箱，界面上不再显示原文'}>
        <Input type="password" autoComplete="off" value={token} invalid={touched && !!tokenErr}
          placeholder={tokenHint ? '不改留空' : 'xoxb-…'} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="Signing Secret"
        hint={signingHint ? `已保存（${signingHint}），不改留空` : '用事件订阅时必填，Slack 推来的消息按它验签；只用定时拉取可以先不填'}>
        <Input type="password" autoComplete="off" value={signing} placeholder={signingHint ? '不改留空' : 'Basic Information 页的 Signing Secret'}
          onChange={(e) => setSigning(e.target.value)} />
      </Field>
      <Field label="监听频道" hint="逗号分隔，# 可省，也可以写频道 id；留空只收私信。Bot 要先被邀请进这些频道">
        <Input value={channels} placeholder="#product, #feedback" onChange={(e) => setChannels(e.target.value)} />
      </Field>
      <Field label="我的 Member ID" error={touched ? selfErr : undefined} hint="@ 到它的消息算「@我」；留空只认 @Bot">
        <Input value={self} invalid={touched && !!selfErr} placeholder="U01ABCDEF" onChange={(e) => setSelf(e.target.value)} />
      </Field>
      <Field label="同步间隔" hint="工作台不在公网上时 Slack 推不进来，靠定时拉 conversations.history 收消息">
        <Select value={String(every)} onValueChange={(v) => setEvery(Number(v))}
          options={SYNC_INTERVALS.map((n) => ({ value: String(n), label: intervalLabel(n) }))} />
      </Field>
      <Checkbox checked={reply} onCheckedChange={setReply}>允许从这里回复（经 Bot 发 chat.postMessage）</Checkbox>
      <div className="im-chform-note im-muted">
        在公网上时可改用事件订阅：Event Subscriptions 的 Request URL 填 <code className="im-chform-code">{callbackUrl(SLACK_TOOL)}</code>，
        订阅 <code>message.channels message.groups message.im message.mpim</code>。
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
