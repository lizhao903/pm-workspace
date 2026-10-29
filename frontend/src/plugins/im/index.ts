// IM 消息插件（IM-02b 起）：清单在后端 internal/plugins/im/plugin.json，这里只有入口。
// 模块 key 是 messages（工作台和菜单按它认，见 core/shell/workspace.ts）；页面是收件箱加消息抽屉，没有二级菜单
import { TODAY_ORDER, definePlugin } from '../../core/plugin'
import { conversationsApi, dataKeys, imApi, queryClient, type Conversation, type ImMessage } from '../../core/data'

// 今日「需要你处理」的 IM 消息组（SPEC-today-1.4）：待处理且不在稍后提醒中的；和消息页共用一份缓存
const pendingNow = (m: ImMessage, now: number) => m.status === 'pending' && !(m.snooze_until && Date.parse(m.snooze_until) > now)

// SOP 节点的会话下拉（SOP-03b）：读数据层里的会话缓存，还没取过就取一次（失败了不反复取）；
// 编辑器订阅了缓存，取回来会重新调。会话也可以从输入里取
function conversationOptions() {
  const key = dataKeys.conversations.list
  const st = queryClient.getQueryState(key)
  if (!st || (st.status === 'pending' && st.fetchStatus === 'idle')) {
    void queryClient.prefetchQuery({ queryKey: key, queryFn: ({ signal }) => conversationsApi.list(signal) })
  }
  const list = queryClient.getQueryData<Conversation[]>(key) ?? []
  return [
    { value: '{{conversation_id}}', label: '取输入里的 conversation_id' },
    ...list.map((c) => ({ value: c.id, label: `${c.kind === 'group' ? '#' : ''}${c.name || c.external_id}（${c.channel}）` })),
  ]
}

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'messages',
      label: 'IM 消息',
      path: 'messages',
      load: () => import('./Page'),
    })
    api.todaySources.register({
      key: 'pending', slot: 'need', label: 'IM 消息', order: TODAY_ORDER.im, more: '/messages',
      queryKey: dataKeys.im.list,
      queryFn: ({ signal }) => imApi.all(signal),
      select: (rows: ImMessage[]) => {
        const now = Date.now()
        const items = rows.filter((m) => pendingNow(m, now)).map((m) => ({
          id: m.id, tone: 'info' as const, title: `${m.contact_name || m.sender_name}：${m.text}`, sub: m.conversation || '私聊',
          at: m.at, action: '回复', to: `/messages?m=${encodeURIComponent(m.id)}`,
        }))
        return { total: items.length, items }
      },
    })
    // SOP 节点的展示；节点本身、必填项在后端登记（SOP-02b），没装 SOP 插件时没人读
    api.sopNodes.register({
      kind: 'im_send_message', label: '发消息', group: '沟通', color: '#0f8a8a', desc: '往指定会话发一条消息',
      fields: [
        { key: 'conversation', label: '会话', type: 'select', required: true, options: conversationOptions },
        { key: 'text', label: '内容', type: 'textarea', required: true, hint: '支持 {{字段}}' },
      ],
    })
    api.sopNodes.register({
      kind: 'im_wait_reply', label: '等待回复', group: '沟通', color: '#0c8599', desc: '等这个会话里对方的下一条消息，超时失败',
      fields: [
        { key: 'conversation', label: '会话', type: 'select', required: true, options: conversationOptions },
        { key: 'timeout', label: '超时', type: 'text', default: '1 小时', hint: '留空是 1 小时，最多 30 天；也认 90s、1h30m' },
      ],
    })
  },
})
