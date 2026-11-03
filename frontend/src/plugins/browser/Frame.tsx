// 原型标签和网页标签（SPEC-browser-3）：iframe 加载；登记过的原型没在运行时不加载，显示启动提示。
// 不能嵌入的站点（BR-02a，SPEC-browser-3.12）：不在白名单的不挂 iframe，直接出卡片；白名单内 8 秒没 load 盖一层卡片，可以「继续等」。
// 白名单内但站点自己拒绝嵌入、load 照样触发时仍是空白或浏览器自带的拒绝页，这时用工具栏的「在系统浏览器打开」
import { useEffect, useState } from 'react'
import { Button } from '../../core/ui'
import type { TerminalPrototype } from '../../core/data'
import { FRAME_TIMEOUT_MS, hostOf, protoStatusColor, protoStatusLabel, type Tab } from './model'

export function FrameView({ tab, reloadKey, proto, starting, allowed, adding, onAllow, onExternal, onLoaded, onStart }: {
  tab: Tab
  reloadKey: number
  /** 端口对上的登记原型 */
  proto?: TerminalPrototype
  /** 这个标签在等原型启动 */
  starting: boolean
  /** 在白名单里才挂 iframe */
  allowed: boolean
  /** 正在加进白名单 */
  adding: boolean
  onAllow: () => void
  onExternal: () => void
  onLoaded: () => void
  onStart: (p: TerminalPrototype) => void
}) {
  const idle = tab.kind === 'proto' && !!proto && proto.status !== 'running'
  const framed = allowed && !idle
  // 超时只记到期的是哪一次加载（地址、刷新次数、继续等的次数），换了加载自然失效，不用在 effect 里清
  const [waits, setWaits] = useState(0)
  const [late, setLate] = useState('')
  const loadKey = `${tab.url}#${reloadKey}#${waits}`
  useEffect(() => {
    if (!framed || !tab.loading) return
    const t = window.setTimeout(() => setLate(loadKey), FRAME_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [framed, tab.loading, loadKey])
  const slow = framed && tab.loading && late === loadKey

  const blocked = (timeout: boolean) => (
    <div className="br-center">
      <div className="br-notice" role="alert">
        <div className="br-notice-title">这个站点不能在这里打开</div>
        <div className="muted">{timeout ? `${hostOf(tab.url)} 8 秒还没加载完，可能不允许嵌入显示` : `${hostOf(tab.url)} 不在白名单里，多数网站不允许嵌入显示`}</div>
        <div className="br-notice-acts">
          <Button variant="primary" onClick={onExternal}>在系统浏览器打开</Button>
          {timeout
            ? <Button variant="outline" onClick={() => setWaits((n) => n + 1)}>继续等</Button>
            : <Button variant="outline" disabled={adding} onClick={onAllow}>{adding ? '正在加入' : '加进白名单再试'}</Button>}
        </div>
      </div>
    </div>
  )

  if (!allowed) return blocked(false)
  if (idle && proto) {
    const busy = starting || proto.status === 'starting'
    return (
      <div className="br-center">
        <div className="br-notice">
          <span className="br-light" style={{ background: protoStatusColor(proto) }} aria-hidden="true" />
          <div className="br-notice-title">这个原型没在运行</div>
          <div className="muted">{proto.project_title} / {proto.name} · 127.0.0.1:{proto.port} · {protoStatusLabel(proto)}</div>
          {proto.status === 'crashed' && proto.error && <div className="br-notice-err">{proto.error}</div>}
          <Button variant="primary" disabled={busy} onClick={() => onStart(proto)}>{busy ? '启动中' : '启动原型'}</Button>
          <div className="faint">启动完成后这里会自动加载</div>
        </div>
      </div>
    )
  }
  return (
    <div className="br-frame-wrap">
      {tab.loading && <div className="br-progress" role="progressbar" aria-label="加载中" />}
      {slow && <div className="br-frame-over">{blocked(true)}</div>}
      <iframe key={reloadKey} className="br-frame" src={tab.url} title={tab.title} onLoad={onLoaded}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  )
}
