// 任务来源（SPEC-tasks-0 TaskSource、SPEC-tasks-3）：来源视图的标题、说明、空状态，和列表上的来源标签文字。
// 来源种类在 objects.source，详情在 props.source_ref（契约「任务来源」）。
import type { WorkObject } from '../../core/data'

export type SourceKind = 'manual' | 'im' | 'webhook' | 'schedule' | 'incident'

export const SOURCE_KINDS: SourceKind[] = ['manual', 'im', 'webhook', 'schedule', 'incident']

/** 导入脚本写的任务（source=import）是人整理好导进来的，算进「人工创建」 */
export const IMPORT_SOURCE = 'import'

export const SOURCE_VIEW: Record<SourceKind, { label: string; title: string; desc: string; empty: string; filter: string[] }> = {
  manual: { label: '人工创建', title: '人工创建的任务', desc: '自己手动建的任务', empty: '点右上角新建一个', filter: ['manual', IMPORT_SOURCE] },
  im: { label: 'IM 消息', title: 'IM 消息转的任务', desc: '在 IM 消息里点「转任务」建的，能回看原消息', empty: '在 IM 消息里点「转任务」', filter: ['im'] },
  webhook: {
    label: 'Webhook', title: 'Webhook 转的任务', desc: '外部系统推到接收地址后按映射规则自动建的，能回看原始推送',
    empty: '在「Webhook 接入」里建一个 Webhook，把地址填到外部系统里', filter: ['webhook'],
  },
  schedule: { label: '定时', title: '定时任务建的任务', desc: '定时任务到点自动建的，规则在「定时任务」里改', empty: '定时任务到点会建在这里', filter: ['schedule'] },
  incident: {
    label: '运行异常', title: '运行异常转的研发任务', desc: '从「设置 / 运行异常」转过来的，带着异常详情；做完回去把异常标为已解决',
    empty: '在「设置 / 运行异常」里转任务', filter: ['incident'],
  },
}

export const isSourceKind = (v: string): v is SourceKind => (SOURCE_KINDS as string[]).includes(v)

const refOf = (t: WorkObject): Record<string, unknown> => {
  const r = t.props?.source_ref
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {}
}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export type SourceTagInfo = { text: string; kind: string; title?: string; hookId?: string }

/**
 * 列表上的来源标签。hookName 给出 Webhook 名：undefined 表示列表还没取到（只写「Webhook」），null 表示已删除。
 * 来源为空的老数据不显示标签。
 */
export function sourceTag(t: WorkObject, hookName: (id: string) => string | null | undefined): SourceTagInfo | null {
  const ref = refOf(t)
  switch (t.source) {
    case 'manual':
      return { text: '人工', kind: 'manual' }
    case IMPORT_SOURCE:
      // 和二级菜单「人工创建」叫法一致，悬停才说明是导入的
      return { text: '人工', kind: 'manual', title: '导入：导入脚本建的任务' }
    case 'im': {
      const ch = str(ref.channel)
      const who = str(ref.sender)
      const text = ch && who ? `${ch} · ${who}` : ch ? `IM · ${ch}` : 'IM 消息'
      return { text, kind: 'im', title: str(ref.text) || undefined }
    }
    case 'webhook': {
      const id = str(ref.hook_id)
      const name = id ? hookName(id) : null
      return { text: name === undefined ? 'Webhook' : `Webhook · ${name ?? '已删除'}`, kind: 'webhook', hookId: id || undefined }
    }
    case 'schedule': {
      const name = str(ref.name)
      return { text: name ? `定时 · ${name}` : '定时', kind: 'schedule' }
    }
    case 'incident': {
      const title = str(ref.title)
      return { text: title ? `异常 · ${title}` : '运行异常', kind: 'incident', title: title || undefined }
    }
    case '':
      return null
    default:
      return { text: t.source, kind: 'other' }
  }
}
