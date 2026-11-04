// IM 消息插件（IM-02b 起）：清单在后端 internal/plugins/im/plugin.json，这里只有入口。
// 模块 key 是 messages（工作台和菜单按它认，见 core/shell/workspace.ts）；页面是收件箱加消息抽屉，没有二级菜单
import { TODAY_ORDER, definePlugin } from '../../core/plugin'
import { conversationsApi, dataKeys, imApi, projectOptions, queryClient, type Conversation, type ImMessage } from '../../core/data'
import { messageTitle, searchMessages } from './search'
import { SOURCE_KIND } from './sessionModel'

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

// 任务阶段（AUTO-05，契约「任务阶段与提出人」），设置任务阶段节点的下拉用
const TASK_STAGE_OPTIONS = [
  { value: 'received', label: '已接收' }, { value: 'confirm_project', label: '待确认项目' }, { value: 'designing', label: '设计中' },
  { value: 'clarifying', label: '待澄清' }, { value: 'reviewing', label: '评审中' }, { value: 'need_human', label: '需人工' },
  { value: 'developing', label: '开发中' }, { value: 'testing', label: '测试中' }, { value: 'accepting', label: '待验收' },
  { value: 'releasing', label: '待发布' }, { value: 'released', label: '已上线' },
]

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'messages',
      label: 'IM 消息',
      path: 'messages',
      load: () => import('./Page'),
    })
    // 从消息发起的会话（0008）：会话页头部「来源」点回这条消息（合并的一组点回最新一条）
    api.sessionSources.register({
      kind: SOURCE_KIND,
      describe: (ref) => {
        const id = typeof ref.message_id === 'string' ? ref.message_id : ''
        const label = typeof ref.label === 'string' && ref.label ? ref.label : 'IM 消息'
        return { label, to: id ? `/messages?m=${encodeURIComponent(id)}` : '', title: '回到 IM 消息页打开这条消息' }
      },
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
      kind: 'im_get_message', label: '读取消息', group: '沟通', color: '#1971c2', desc: '取出这条消息的正文、发信人、会话和归到的项目（含群组默认项目），交给后面的步骤',
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
    // 消息分流：项目消息先归到项目，项目「沟通」里就能看到
    api.sopNodes.register({
      kind: 'im_set_project', label: '消息归到项目', group: '沟通', color: '#2f9e44', desc: '把消息归到一个项目，项目的沟通里能看到它',
      fields: [
        { key: 'project', label: '项目', type: 'select', required: true, options: () => [
          { value: '{{project_id}}', label: '取输入里的 project_id' }, ...projectOptions(),
        ] },
        { key: 'message', label: '消息', type: 'text', hint: '消息 id，支持 {{字段}}；留空用读取消息的结果或输入里的 message_id' },
      ],
      summary: (c) => {
        if (!c.project) return ''
        const p = projectOptions().find((o) => o.value === c.project)
        return `归到 ${p?.label ?? c.project}`
      },
    })
    // IM 任务回执（SPEC-messages-2.50）：等任务执行完成、在原消息串里回复
    api.sopNodes.register({
      kind: 'im_wait_task', label: '等任务完成', group: '沟通', color: '#0c8599', desc: '等任务交给 Claude Code 执行成功结束或被标为已完成',
      fields: [
        { key: 'task', label: '任务', type: 'text', default: '{{task_id}}', hint: '任务 id，支持 {{字段}}' },
        { key: 'timeout', label: '超时', type: 'text', default: '14 天', hint: '最多等多久，写法同等待回复' },
      ],
    })
    api.sopNodes.register({
      kind: 'im_reply_message', label: '回复原消息', group: '沟通', color: '#0f8a8a', desc: '在原消息所在的串里回复对方',
      fields: [
        { key: 'message', label: '消息', type: 'text', hint: '消息 id，支持 {{字段}}；留空用输入里的 message_id' },
        { key: 'text', label: '内容', type: 'textarea', required: true, hint: '支持 {{字段}}' },
      ],
    })
    // IM 需求自动受理（AUTO-06）：消息转成任务（写提出人、阶段已接收）、改任务阶段并可同时绑项目
    api.sopNodes.register({
      kind: 'im_to_task', label: '转成任务', group: '沟通', color: '#1971c2', desc: '同消息页「转任务」：建任务，记来源消息和提出人，阶段「已接收」；转过的取回原任务',
      fields: [
        { key: 'message', label: '消息', type: 'text', hint: '消息 id，支持 {{字段}}；留空用输入里的 message_id' },
        { key: 'title', label: '标题', type: 'text', hint: '留空取正文前 40 字' },
        { key: 'body', label: '正文', type: 'textarea', hint: '留空是消息原文' },
      ],
    })
    api.sopNodes.register({
      kind: 'im_set_task_stage', label: '设置任务阶段', group: '沟通', color: '#7048e8', desc: '改任务在看板上的阶段，可同时把任务归到项目',
      fields: [
        { key: 'task', label: '任务', type: 'text', default: '{{task.id}}', hint: '任务 id，支持 {{字段}}；留空用输入里的 task.id' },
        { key: 'stage', label: '阶段', type: 'select', options: () => [{ value: '', label: '不改' }, ...TASK_STAGE_OPTIONS] },
        { key: 'project', label: '项目', type: 'select', options: () => [
          { value: '', label: '不改' }, { value: '{{project_id}}', label: '取输入里的 project_id' }, ...projectOptions(),
        ], hint: '也可以写 {{字段}}，认项目 id、编号或名字' },
      ],
      summary: (c) => [c.stage ? `阶段改为${TASK_STAGE_OPTIONS.find((o) => o.value === c.stage)?.label ?? c.stage}` : '', c.project ? '绑定项目' : ''].filter(Boolean).join('，'),
    })
    // 研发 pipeline（AUTO-09）：平台通知，有来源消息时同时在原消息串里回复
    api.sopNodes.register({
      kind: 'im_notify', label: '通知', group: '沟通', color: '#e8590c', desc: '发一条平台通知（关联任务）；填了消息且取得到时，同时在原消息所在的串里回复同样的内容',
      fields: [
        { key: 'text', label: '内容', type: 'textarea', required: true, hint: '支持 {{字段}}' },
        { key: 'title', label: '标题', type: 'text', hint: '留空是「任务编号 任务标题」' },
        { key: 'task', label: '任务', type: 'text', default: '{{task.id}}', hint: '通知关联的任务，支持 {{字段}}；取不到不关联' },
        { key: 'message', label: '回复原消息', type: 'text', hint: '消息 id，支持 {{字段}}（如 {{message_id}}）；留空或取不到只发平台通知' },
        { key: 'level', label: '级别', type: 'select', options: () => [
          { value: '', label: '一般' }, { value: 'success', label: '成功' }, { value: 'error', label: '要处理' },
        ] },
      ],
      summary: (c) => (c.message ? '平台通知，回复原消息' : '平台通知'),
    })
  },
})
