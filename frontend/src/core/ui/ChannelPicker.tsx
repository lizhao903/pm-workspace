// 「监听频道」的列表选择（字段 picker=im_channels）：按已保存的连接器 Token 列出看得到的频道、私有频道、多人私信，
// 搜索、勾选，已选的在上面单独一行，也排在列表前面。存回的还是同一个文本字段（逗号分隔的编号），见 channels.ts。
// 拿不到列表（新建还没保存、没填 Token、渠道报错）时退回文本框；列表里没有的也能点「手动填写」直接写。
// 设置里的连接器抽屉（字段 picker=im_channels）和 IM 页「渠道配置」的 Slack 表单共用。不从 ui/index 导出：它要取数，同 DirPicker。
import { useState } from 'react'
import { errorText, useImConversations } from '../data'
import { Button } from './Button'
import {
  CHANNEL_ROWS_MAX, convLabel, isPicked, KIND_LABEL, orderChannels, removeToken, resolveChannels, toggleChannel,
} from './channelPick'
import { cls } from './cls'
import { Input } from './form'
import './channelPicker.css'

export function ChannelPicker({ label, placeholder, connectorId, value, onChange, invalid }: {
  /** 字段名，拼进各控件的无障碍名字 */
  label: string
  placeholder?: string
  /** 已保存的连接器；新建时为空 */
  connectorId?: string
  value: string
  onChange: (v: string) => void
  invalid?: boolean
}) {
  const [q, setQ] = useState('')
  const [manual, setManual] = useState(false)
  const list = useImConversations(connectorId)
  const text = (
    <Input value={value} placeholder={placeholder} invalid={invalid} aria-label={`${label}（文本）`} onChange={(e) => onChange(e.target.value)} />
  )

  if (!connectorId) {
    return <>{text}<span className="chan-faint">先保存并测试连接后可从列表选择</span></>
  }
  if (list.isPending) {
    return <>{text}<span className="chan-faint">正在读取频道列表…</span></>
  }
  if (list.isError) {
    return (
      <>
        {text}
        <span className="chan-note">
          <span className="danger-text">没能读取频道列表：{errorText(list.error)}；可以直接填编号或 #名字</span>
          <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); void list.refetch() }}>重试</Button>
        </span>
      </>
    )
  }

  const items = list.data.items
  const picked = resolveChannels(value, items)
  const shown = orderChannels(items, value, q)
  return (
    <div className={cls('chan', invalid && 'bad')}>
      <div className="chan-picked" aria-label="已选频道">
        {picked.length === 0 && <span className="chan-faint">还没选，只收私信和多人私信</span>}
        {picked.map(({ token, item }) => (
          <span key={token.key} className={cls('chan-chip', !item && 'missing')}
            title={item ? item.id : 'Token 看不到这个会话：Bot 没被加进去、已改名或列表没列全'}>
            {item ? convLabel(item) : token.raw}
            {!item && <em>未找到</em>}
            <button type="button" aria-label={`移除 ${item ? convLabel(item) : token.raw}`}
              onClick={() => onChange(item ? toggleChannel(value, item, false) : removeToken(value, token.key))}>×</button>
          </span>
        ))}
      </div>
      <div className="chan-bar">
        <Input className="chan-search" placeholder="搜频道名或编号" aria-label="搜频道" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <span className="chan-faint">已选 {picked.length} · 共 {items.length} 个</span>
        <Button size="sm" variant="ghost" disabled={list.isFetching} onClick={(e) => { e.preventDefault(); void list.refetch() }}>
          {list.isFetching ? '刷新中…' : '刷新'}
        </Button>
      </div>
      <div className="chan-list" role="group" aria-label={`${label}列表`}>
        {shown.slice(0, CHANNEL_ROWS_MAX).map((c) => {
          const on = isPicked(value, c)
          return (
            <label key={c.id} className={cls('chan-row', on && 'on')} data-channel-id={c.id}>
              <input type="checkbox" checked={on} onChange={(e) => onChange(toggleChannel(value, c, e.target.checked))} />
              <span className="chan-name ellipsis">{convLabel(c)}</span>
              {c.kind !== 'public' && <span className="chan-tag">{KIND_LABEL[c.kind]}</span>}
              {c.is_archived && <span className="chan-tag warn">已归档</span>}
              <span className="spacer" />
              <code className="chan-faint chan-mono">{c.id}</code>
            </label>
          )
        })}
        {!shown.length && <div className="chan-empty">{items.length ? '没有匹配的频道' : 'Token 还不在任何频道里：Bot 身份先把 Bot 加进频道'}</div>}
        {shown.length > CHANNEL_ROWS_MAX && <div className="chan-faint chan-more">还有 {shown.length - CHANNEL_ROWS_MAX} 个没显示，搜索缩小范围</div>}
      </div>
      {!list.data.complete && <div className="chan-warn">{list.data.note || '列表不完整'}</div>}
      <span className="chan-note">
        <span className="chan-faint">列的是 Token 所在的会话；私信、多人私信本来就全收，勾多人私信不影响。不在列表里的可以手动填</span>
        <Button size="sm" variant="ghost" aria-expanded={manual} onClick={(e) => { e.preventDefault(); setManual(!manual) }}>
          {manual ? '收起手动填写' : '手动填写'}
        </Button>
      </span>
      {manual && text}
    </div>
  )
}
