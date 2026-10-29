// IM 消息插件（IM-02b 起）：清单在后端 internal/plugins/im/plugin.json，这里只有入口。
// 模块 key 是 messages（工作台和菜单按它认，见 core/shell/workspace.ts）；页面是收件箱加消息抽屉，没有二级菜单
import { TODAY_ORDER, definePlugin } from '../../core/plugin'
import { dataKeys, imApi, type ImMessage } from '../../core/data'

// 今日「需要你处理」的 IM 消息组（SPEC-today-1.4）：待处理且不在稍后提醒中的；和消息页共用一份缓存
const pendingNow = (m: ImMessage, now: number) => m.status === 'pending' && !(m.snooze_until && Date.parse(m.snooze_until) > now)

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
  },
})
