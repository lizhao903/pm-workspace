// 原型标签和网页标签（SPEC-browser-3）：iframe 加载；登记过的原型没在运行时不加载，显示启动提示。
// 不能嵌入的站点（白名单、8 秒超时卡片）归 BR-02a，这里所有地址都直接挂 iframe，拒绝嵌入时用工具栏的「在系统浏览器打开」
import { Button } from '../../core/ui'
import type { TerminalPrototype } from '../../core/data'
import { protoStatusColor, protoStatusLabel, type Tab } from './model'

export function FrameView({ tab, reloadKey, proto, starting, onLoaded, onStart }: {
  tab: Tab
  reloadKey: number
  /** 端口对上的登记原型 */
  proto?: TerminalPrototype
  /** 这个标签在等原型启动 */
  starting: boolean
  onLoaded: () => void
  onStart: (p: TerminalPrototype) => void
}) {
  if (tab.kind === 'proto' && proto && proto.status !== 'running') {
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
      <iframe key={reloadKey} className="br-frame" src={tab.url} title={tab.title} onLoad={onLoaded}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  )
}
