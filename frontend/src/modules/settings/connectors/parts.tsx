// 列表和抽屉共用的小件：工具标志、状态点、抽屉顶部的连接状态条，照原型 web-next/src/connectors.tsx ToolLogo、StatusDot、ConnBar。
import { useState, type CSSProperties } from 'react'
import type { Connector, ConnectorDef, ConnectorStatus } from '../../../core/data'
import { Button, cls } from '../../../core/ui'
import { OFF_HINT, STATUS } from './catalog'
import { ago } from './model'

/** 标志：定义给的底色加名称前两个字；没有底色用灰 */
export function ToolLogo({ def, size = 40 }: { def: Pick<ConnectorDef, 'label' | 'color'>; size?: number }) {
  const short = def.label.slice(0, 2)
  const style = { width: size, height: size, fontSize: size * 0.34, '--c': def.color || 'var(--faint)' } as CSSProperties
  return <span className="cn-logo" style={style} aria-hidden="true">{short}</span>
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
