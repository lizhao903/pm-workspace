// 失效规则（CORE-03a）：写操作说清楚「改了什么」，这里决定刷新哪些缓存。
// 组件和模块不自己拼键去失效，一律报一个 Change，规则集中在 invalidationsFor 里，有单元测试盯着。
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useCallback } from 'react'
import { agentKeys } from './agentKeys'
import { dataKeys } from './keys'
import { queryClient } from './queryClient'
import { todayKeys } from './today'

export type Change =
  /** 对象新建、编辑、改状态、删除、恢复，以及带 status 的进展（同一事务改了状态） */
  | { kind: 'object'; id?: string }
  /** 只追加了一条进展，状态没变 */
  | { kind: 'progress'; id: string }
  /** 登记、编辑、删除产出物 */
  | { kind: 'artifact'; objectId?: string }
  /** 执行记录已建好（start 事件），只刷这个对象的执行列表 */
  | { kind: 'run-started'; objectId: string }
  /** 执行收尾或开流失败：执行过程中可能改了对象、记了进展、登记了产出物 */
  | { kind: 'run-settled'; objectId: string }
  /** 发出取消；后端稍后才收尾，以之后读回的为准 */
  | { kind: 'run-canceled' }
  | { kind: 'stakeholder' }
  | { kind: 'dictionary' }
  | { kind: 'object-type' }
  /** 全局会话新建、改标题、删除；删除时产出物的 session_id 被置空 */
  | { kind: 'agent-session' }
  /** 一轮对话收尾（done 或失败）：消息、会话的更新时间和标题都变了，工具可能建了对象、写了文件 */
  | { kind: 'agent-chat'; sessionId?: string }
  /** 插件安装、启停、卸载：插件可能带来或收起对象类型 */
  | { kind: 'plugin' }
  /** 定时任务新建、编辑、启停、删除 */
  | { kind: 'schedule'; id?: string }
  /** 立即执行了一次定时任务：多一条执行记录，建任务类还建出一条任务 */
  | { kind: 'schedule-run'; id: string }
  /** 工作台新建、修改、删除：只换菜单，数据不隔离，不刷别的 */
  | { kind: 'workspace' }
  /** 挂载、移除本地目录（DOC-01b）；顶栏「刷新」也报它，重新读文件清单和打开的文件 */
  | { kind: 'local-dir' }
  /** Webhook 新建、编辑、启停、轮换密钥、删除（TASK-04b） */
  | { kind: 'webhook'; id?: string }
  /** 往收件地址推了一次：多一条投递记录，可能建出一条任务 */
  | { kind: 'webhook-delivery'; id: string }
  /** 模型服务商新建、编辑（含启停、换或清空密钥）、设默认、删除（MP-01b） */
  | { kind: 'agent-provider' }
  /** IM 身份增删改（CT-03b）；删联系人时身份跟着删，也报它 */
  | { kind: 'im-identity' }

// 对象一变，所有对象列表（任务列表、今日、项目的任务标签页）、单个对象及其进展和修订、
// 计数（侧栏红点、逾期徽标）都可能变；干系人名册上的任务数也跟着变；今日聚合（待验收、逾期、今天到期、插件卡片）也是。
// 文档的分类树数量、标签引用数（DOC-01b）也按对象算。
const objectWide: QueryKey[] = [
  dataKeys.objects.all, dataKeys.counts.all, dataKeys.stakeholders.all, todayKeys.all, dataKeys.categories.all, dataKeys.tags.all,
]

/** 一次改动要按前缀失效的查询键 */
export function invalidationsFor(c: Change): QueryKey[] {
  switch (c.kind) {
    case 'object':
      return objectWide
    case 'progress':
      // 进展本身也是一条修订，对象的 updated_at 会变
      return [dataKeys.objects.progress(c.id), dataKeys.objects.revisions(c.id), dataKeys.objects.detail(c.id)]
    case 'artifact':
      // 列表和统计（删除确认里的产出物数）一起刷
      return [dataKeys.artifacts.all]
    case 'run-started':
      // 今日的「正在运行」也要多一行
      return [dataKeys.runs.list(c.objectId), todayKeys.of(), todayKeys.of('task')]
    case 'run-settled':
      return [dataKeys.runs.all, dataKeys.artifacts.all, ...objectWide]
    case 'run-canceled':
      return [dataKeys.runs.all]
    case 'stakeholder':
      // 负责人、参与人的名字跟着对象一起返回
      return [dataKeys.stakeholders.all, dataKeys.objects.all]
    case 'dictionary':
      return [dataKeys.dictionaries.all]
    case 'object-type':
      // 状态集变了，计数口径（终态）也变
      return [dataKeys.objectTypes, dataKeys.counts.all]
    case 'agent-session':
      // 只刷列表：改名不动消息；删掉的会话再去取消息只会拿到 404
      return [agentKeys.sessions.unscoped, dataKeys.artifacts.all]
    case 'agent-chat':
      return [
        c.sessionId ? agentKeys.sessions.messages(c.sessionId) : agentKeys.sessions.all,
        agentKeys.sessions.unscoped, dataKeys.artifacts.all, ...objectWide,
      ]
    case 'plugin':
      // 插件停用后它的今日卡片从聚合里消失
      return [dataKeys.plugins.all, dataKeys.objectTypes, todayKeys.all]
    case 'schedule':
      // 列表（今日的「今天还会自动执行」同一份）；删除时执行记录一起没了
      return c.id ? [todayKeys.schedules, dataKeys.schedules.runsOf(c.id)] : [todayKeys.schedules, dataKeys.schedules.all]
    case 'schedule-run':
      // 建出来的任务要进任务列表、计数和今日；列表的「上次」也在执行记录前缀下
      return [dataKeys.schedules.runsOf(c.id), ...objectWide]
    case 'workspace':
      return [dataKeys.workspaces.list]
    case 'local-dir':
      return [dataKeys.localDirs.all]
    case 'webhook':
      // 列表（二级菜单同一份）；删除时投递记录和影响一起没了
      return c.id
        ? [dataKeys.webhooks.list, dataKeys.webhooks.deliveriesOf(c.id), dataKeys.webhooks.usage(c.id)]
        : [dataKeys.webhooks.all]
    case 'webhook-delivery':
      // 建出来的任务要进任务列表、来源视图条数、计数和今日；「建了任务」一列跟着变
      return [dataKeys.webhooks.deliveriesOf(c.id), dataKeys.webhooks.usage(c.id), ...objectWide]
    case 'agent-provider':
      // 列表（会话里的服务商下拉同一份）；在用的模型下拉跟着按新配置重新测
      return [agentKeys.providers]
    case 'im-identity':
      // 联系人列表的 IM 列由身份合出来，身份列表一刷就跟着变
      return [dataKeys.identities.all]
  }
}

/** 按规则失效；返回的 Promise 在有人在看的查询重新取完后 resolve */
export function applyChange(qc: QueryClient, c: Change): Promise<void> {
  return Promise.all(invalidationsFor(c).map((queryKey) => qc.invalidateQueries({ queryKey }))).then(() => undefined)
}

/** 组件外（模块级状态、流式回调）用：作用在应用唯一的缓存上 */
export const notifyChange = (c: Change) => applyChange(queryClient, c)

/** 组件里用：作用在当前 QueryClientProvider 的缓存上（测试里各自的缓存）；返回的函数引用稳定 */
export function useNotifyChange() {
  const qc = useQueryClient()
  return useCallback((c: Change) => applyChange(qc, c), [qc])
}
