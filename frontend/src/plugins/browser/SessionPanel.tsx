// 会话旁边的浏览器（SPEC-sessions-1.36）：和一级菜单「浏览器」是同一套标签（存后端，两边看到的一样）。
// 会话里出现过链接时，工具栏下面多一行「会话里的链接」，点一个就在这里打开：已经有同一地址的标签切过去，否则新开
import type { SessionToolProps } from '../../core/plugin'
import { cls } from '../../core/ui'
import { displayUrl, sameUrl } from './model'
import { BrowserView } from './Page'
import * as store from './store'
import './browser.css'

export default function BrowserSessionPanel({ links }: SessionToolProps) {
  const { tabs } = store.useBrowserState()
  const cur = tabs.tabs.find((t) => t.id === tabs.active)
  const bar = links.length > 0 && (
    <div className="br-links" role="group" aria-label="会话里的链接">
      <span className="br-links-label">会话里的链接</span>
      <div className="br-links-list">
        {links.map((url) => (
          <button key={url} type="button" title={url} className={cls('br-link', cur && sameUrl(cur.url, url) && 'on')}
            onClick={() => store.openRequest(url)}>
            <span className="ellipsis">{displayUrl(url)}</span>
          </button>
        ))}
      </div>
    </div>
  )
  return <BrowserView bar={bar || undefined} />
}
