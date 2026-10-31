// IM 消息插件（IM-02b 起）：清单在后端 internal/plugins/im/plugin.json，这里只有入口。
// 模块 key 是 messages（工作台和菜单按它认，见 core/shell/workspace.ts）；页面是收件箱加消息抽屉，没有二级菜单
import { TODAY_ORDER, definePlugin } from '../../core/plugin'
import { conversationsApi, dataKeys, imApi, queryClient, type Conversation, type ImMessage } from '../../core/data'
import { messageTitle, searchMessages } from './search'

// 今日「需要你处理」的 IM 消息组（SPEC-today-1.4）：与我相关（@我、@所有人、私聊）、待处理且不在稍后提醒中的，
// 其余群消息只在消息页（B-01）；@我 的排在同组前面。和消息页共用一份缓存
const pendingNow = (m: ImMessage, now: number) =>
  !!m.relevance && m.status === 'pending' && !(m.snooze_until && Date.parse(m.snooze_until) > now)

export function todayNeeds(rows: readonly ImMessage[], now: number) {
  const items = rows.filter((m) => pendingNow(m, now)).map((m) => ({
    id: m.id, tone: 'info' as const, rank: m.relevance === 'me' ? 0 : 1, title: `${m.contact_name || m.sender_name}：${m.text}`, sub: m.conversation || '私聊',
    at: m.at, action: '回复', to: `/messages?m=${encodeURIComponent(m.id)}`,
  }))
  return { total: items.length, items }
}

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
    // 命令面板搜消息：和消息页共用一份缓存，半分钟内不重取；回车打开消息抽屉
    api.commands.provide('im_messages', async (q) => {
      const rows = await queryClient.fetchQuery({ queryKey: dataKeys.im.list, queryFn: ({ signal }) => imApi.all(signal), staleTime: 30_000 })
      return searchMessages(rows, q).map((m) => ({
        id: `im.open.${m.id}`, group: '消息', title: messageTitle(m), sub: m.conversation || '私聊',
        keywords: `${m.sender_name} ${m.contact_name}`,
        run: ({ shell }) => shell.navigate(`/messages?m=${encodeURIComponent(m.id)}`),
      }))
    })
    api.todaySources.register({
      key: 'pending', slot: 'need', label: 'IM 消息', order: TODAY_ORDER.im, more: '/messages',
      queryKey: dataKeys.im.list,
      queryFn: ({ signal }) => imApi.all(signal),
      select: (rows: ImMessage[]) => todayNeeds(rows, Date.now()),
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
    // 来消息自动分诊（SOP-05）：触发方式是 IM 的流程输入里有 message_id，这两个节点留空就用它
    api.sopNodes.register({
      kind: 'im_get_message', label: '读取消息', group: '沟通', color: '#1971c2', desc: '取出这条消息的正文、发信人和会话，交给后面的步骤',
      fields: [
        { key: 'message', label: '消息', type: 'text', hint: '消息 id，支持 {{字段}}；留空用输入里的 message_id' },
      ],
    })
    api.sopNodes.register({
      kind: 'im_mark_message', label: '标记消息', group: '沟通', color: '#5c7cfa', desc: '把消息标成已处理、忽略或已读',
      fields: [
        { key: 'state', label: '标记为', type: 'select', required: true, default: 'ignore', options: () => [
          { value: 'ignore', label: '忽略' }, { value: 'done', label: '已处理' }, { value: 'read', label: '已读（仍待处理）' }, { value: 'reopen', label: '改回待处理' },
        ] },
        { key: 'message', label: '消息', type: 'text', hint: '消息 id，支持 {{字段}}；留空用输入里的 message_id' },
      ],
    })
  },
})
