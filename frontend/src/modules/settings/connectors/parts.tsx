// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 列表和抽屉共用的小件：工具标志、状态点、抽屉顶部的连接状态条，照原型 web-next/src/connectors.tsx ToolLogo、StatusDot、ConnBar。
// OAuthDone 是授权回调回到的窗口（CONN-04b）。
import { useEffect, useState } from 'react'
import { connectorLook, type Connector, type ConnectorDef, type ConnectorStatus } from '../../../core/data'
import { Button, cls, ConnectorLogo } from '../../../core/ui'
import { OFF_HINT, STATUS } from './catalog'
import { ago } from './model'
import { OAUTH_CHANNEL, type OAuthMsg } from './oauth'

/**
 * 标志（TSK-0725）：自己换的图标 > 自定义连接器按地址认出的平台 > 定义的平台图标 > 底色加名称前两个字。
 * 只给 def 时是这个工具的标志；给了 connector 是这个实例的；config 是抽屉里还没保存的配置（按它认平台），src 是还没保存的图标。
 */
export function ToolLogo({ def, size = 40, connector, config, src }: {
  def: Pick<ConnectorDef, 'tool' | 'label' | 'color' | 'logo'>
  size?: number
  connector?: Pick<Connector, 'tool' | 'name' | 'icon' | 'config'>
  config?: Readonly<Record<string, string>>
  src?: string
}) {
  const look = connectorLook(def, connector, config)
  return <ConnectorLogo label={look.label} color={look.color} logo={look.logo} src={src ?? look.src} size={size} />
}

export function StatusDot({ s, pending }: { s: ConnectorStatus; pending?: boolean }) {
  const st = pending ? STATUS.connecting : STATUS[s]
  return <span className={cls('cn-status', `cn-${st.tone}`)}><i />{st.label}</span>
}

/**
 * 抽屉顶部的连接状态条：连着的可以断开（先确认），断开、暂停、异常的可以（重新）连接。
 * 后端的 connecting 是「还没测过」，不是真的在连，所以也给「连接」；真在测的时候（pending）不给按钮。
 */
export function ConnBar({ connector: c, pending, onConnect, onDisconnect }: {
  connector: Connector
  pending: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const s = pending ? 'connecting' : c.status
  const when = c.last_sync_at ? `${ago(c.last_sync_at)}同步` : c.last_tested_at ? `${ago(c.last_tested_at)}测通` : ''
  const text = s === 'connected' ? [c.account, when].filter(Boolean).join(' · ')
    : pending ? '正在连接…'
    : s === 'connecting' ? '还没测过连接'
    : s === 'error' ? c.error || '连接异常'
    : '配置保留，不同步、不调用'
  return (
    <div className={cls('cn-bar', `cn-bar-${STATUS[s].tone}`)}>
      <StatusDot s={s} />
      <span className="cn-bar-text">{text}</span>
      {confirm ? (
        <>
          <span className="danger-text">{OFF_HINT}</span>
          <Button size="sm" onClick={() => setConfirm(false)}>取消</Button>
          <Button size="sm" variant="danger" onClick={() => { setConfirm(false); onDisconnect() }}>断开</Button>
        </>
      ) : pending ? null : s === 'connected' ? (
        <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>断开连接</Button>
      ) : (
        <Button size="sm" variant="primary" disabled={!c.available} onClick={onConnect}>{s === 'error' ? '重新连接' : '连接'}</Button>
      )}
    </div>
  )
}

/** 授权回调回到的窗口：显示结果，告诉抽屉，成功了自己关掉 */
export function OAuthDone({ ok, connector, message }: OAuthMsg) {
  useEffect(() => {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(OAUTH_CHANNEL)
      ch.postMessage({ ok, connector, message } satisfies OAuthMsg)
      ch.close()
    }
    if (ok) {
      const t = setTimeout(() => window.close(), 800)
      return () => clearTimeout(t)
    }
  }, [ok, connector, message])
  return (
    <div className="page cn-page">
      <div className="cn-oauth-done" role="status">
        <h2>{ok ? '授权完成' : '授权没完成'}</h2>
        <div className="cn-faint">{ok ? '可以关掉这个窗口，回到工作台继续。' : `${message || '对方没有给出原因'}。回到工作台重试。`}</div>
      </div>
    </div>
  )
}
