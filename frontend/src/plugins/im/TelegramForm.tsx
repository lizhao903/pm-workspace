// 渠道配置里的 Telegram 表单（IM-01c）：只接 Bot，填 BotFather 给的 Token（进保险箱，界面只显示脱敏提示），
// 可选填公网地址改用 webhook。保存后自动做一次连通测试，账号写成「名字（@用户名）」，群里 @它 算 @我。
import { useState } from 'react'
import {
  errorText, useCreateConnector, usePatchConnector, useTestConnector,
  type Connector, type ConnectorPatch,
} from '../../core/data'
import { Checkbox, Field, Input } from '../../core/ui'
import { SELF_NAMES_FIELD, SELF_NAMES_HINT } from './channelModel'
import { TELEGRAM_TOOL, telegramTokenOk, webhookUrlError } from './telegramModel'

export function TelegramForm({ connector, onSaved, onCancel }: {
  /** 已有的实例：改配置；没有时新建 */
  connector?: Connector | null
  /** 保存并测试过：带着最新的实例 */
  onSaved?: (c: Connector) => void
  onCancel?: () => void
}) {
  const create = useCreateConnector()
  const patch = usePatchConnector()
  const test = useTestConnector()
  const [name, setName] = useState(connector?.name ?? 'Telegram')
  const [token, setToken] = useState('')
  const [webhook, setWebhook] = useState(connector?.config.webhook_url ?? '')
  const [names, setNames] = useState(connector?.config[SELF_NAMES_FIELD] ?? '')
  const [reply, setReply] = useState((connector?.direction ?? 'both') === 'both')
  const [touched, setTouched] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const hint = connector?.secret_hints.bot_token
  const tokenErr = !token.trim() ? (connector && hint ? undefined : '必填') : telegramTokenOk(token) ? undefined : '格式不对，应形如 123456789:AA…，从 BotFather 复制完整的一串'
  const hookErr = webhookUrlError(webhook)
  const busy = create.isPending || patch.isPending || test.isPending
  const saveErr = create.error ?? patch.error

  const submit = async () => {
    setTouched(true)
    setResult(null)
    if (tokenErr || hookErr || busy) return
    const config = { webhook_url: webhook.trim(), [SELF_NAMES_FIELD]: names.trim() }
    const secrets = token.trim() ? { bot_token: token.trim() } : undefined
    const direction = reply ? 'both' as const : 'receive' as const
    let saved: Connector
    try {
      if (connector) {
        const p: ConnectorPatch = { name: name.trim() || undefined, config, direction }
        if (secrets) p.secrets = secrets
        saved = await patch.mutateAsync({ id: connector.id, patch: p })
      } else {
        saved = await create.mutateAsync({ tool: TELEGRAM_TOOL, name: name.trim() || undefined, config, secrets, direction })
      }
    } catch {
      return
    }
    setToken('')
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
    <form className="im-chform" aria-label="Telegram 渠道配置" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <ol className="im-chform-steps im-muted">
        <li>在 Telegram 里找 <b>@BotFather</b>，发 <code>/newbot</code>，按提示起名字和用户名，拿到 Bot Token。</li>
        <li>要收群里的所有消息：给 BotFather 发 <code>/setprivacy</code>，选这个 Bot，选 <b>Disable</b>，再把 Bot 拉进群（已经在群里的要移出再拉一次）。不关的话只收 @它、回复它和命令。</li>
        <li>把 Token 填在下面，保存后会自动测试连接。只接 Bot，不接个人账号。</li>
      </ol>
      <Field label="名称">
        <Input value={name} placeholder="Telegram" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Bot Token" required={!hint} error={touched ? tokenErr : undefined}
        hint={hint ? `已保存（${hint}），不改留空` : '只存进保险箱，界面上不再显示原文'}>
        <Input type="password" autoComplete="off" value={token} invalid={touched && !!tokenErr}
          placeholder={hint ? '不改留空' : '123456789:AA…'} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="公网地址（可选）" error={touched ? hookErr : undefined}
        hint="不填就由本机定时去 Telegram 拉（getUpdates），本机没有公网也能用；填了改用 webhook，Telegram 推到 地址/api/im/callbacks/telegram">
        <Input value={webhook} invalid={touched && !!hookErr} placeholder="https://bro.vip" onChange={(e) => setWebhook(e.target.value)} />
      </Field>
      <Field label="我的称呼" hint={SELF_NAMES_HINT}>
        <Input value={names} placeholder="李钊, Zhao" onChange={(e) => setNames(e.target.value)} />
      </Field>
      <Checkbox checked={reply} onCheckedChange={setReply}>允许从这里回复（经 Bot 发 sendMessage）</Checkbox>
      {saveErr && <div className="im-err" role="alert">没保存：{errorText(saveErr)}</div>}
      {result && <div className={result.ok ? 'im-ok' : 'im-err'} role="status">{result.text}</div>}
      <div className="im-chform-actions">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>取消</button>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : connector ? '保存并测试' : '接入并测试'}</button>
      </div>
    </form>
  )
}
