// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 开始节点的「IM 消息」（TSK-0481，SPEC-sop-9.27 到 9.31）：只接哪些会话、与我的关系（只要 / 除了）、在 IM 流程里第几个判断、命中后拦截后面的流程。
// 会话从内核会话列表里多选，搜名字，也能搜渠道里的编号（Slack 的 C0…）；不符合条件的消息不发起执行、不留记录。
// 顺序：下拉列出现在的 IM 流程，选第几个就插到那里，其余顺延；不动下拉就不改（新的、刚改成 IM 的排最后）。
import { SOP_IM_RELEVANCES, useConversations, type SopIMDraft } from '../../core/data'
import { Checkbox, SearchSelect, Select, Switch } from '../../core/ui'
import { REL_LABEL, convOptions, toggleRel } from './imtrigger'

export type IMFlowRef = { id: string; name: string; order: number; stop: boolean }

export function StartIM({ im, flowId, imFlows, onChange }: {
  im: SopIMDraft
  /** 正在编辑的流程；新建为空 */
  flowId?: string
  /** 现在的 IM 流程（含这一条，如果它已经是 IM），按顺序 */
  imFlows: readonly IMFlowRef[]
  onChange: (im: SopIMDraft) => void
}) {
  const convs = useConversations().data ?? []
  const others = imFlows.filter((f) => f.id !== flowId)
  const mine = imFlows.find((f) => f.id === flowId)
  // 现在排第几：改过就是改的，没改过是保存过的位置，新的排最后
  const cur = im.order ?? mine?.order ?? others.length + 1
  const slots = Array.from({ length: others.length + 1 }, (_, i) => i + 1)
  const label = (n: number) => {
    const before = others[n - 2]
    if (n === 1) return others.length ? `第 1 个（在「${others[0].name}」之前）` : '第 1 个（目前只有它）'
    return `第 ${n} 个（在「${before.name}」之后）`
  }
  // 排在它前面、会拦截的流程：命中了它就收不到
  const blockers = others.slice(0, cur - 1).filter((f) => f.stop)
  const patch = (p: Partial<SopIMDraft>) => onChange({ ...im, ...p })
  return (
    <div className="sop-start-im">
      <div className="field">
        <span className="field-label">只接这些会话</span>
        <SearchSelect multiple variant="field" aria-label="会话" value={im.conversations} placeholder="全部会话" searchPlaceholder="搜群名或会话编号（如 C0…）"
          options={convOptions(convs)} missingLabel={() => '已删除的会话'} emptyText="还没有会话：IM 连接器收到消息后会登记"
          onChange={(v) => patch({ conversations: v })} />
      </div>
      <div className="field">
        <span className="field-label">与我的关系</span>
        <div className="sop-start-im-rel">
          <Select aria-label="只要还是除了" value={im.relevance_mode} options={[{ value: 'include', label: '只要' }, { value: 'exclude', label: '除了' }]}
            onValueChange={(v) => patch({ relevance_mode: v === 'exclude' ? 'exclude' : 'include' })} />
          {SOP_IM_RELEVANCES.map((r) => (
            <Checkbox key={r} checked={im.relevance.includes(r)} onCheckedChange={(c) => patch({ relevance: toggleRel(im.relevance, r, c) })}>{REL_LABEL[r]}</Checkbox>
          ))}
        </div>
        <span className="sop-muted">{im.relevance.length ? '' : '都不勾是不限。'}不符合会话和关系的消息不会发起这个流程，也不留执行记录</span>
      </div>
      <label className="field">
        <span className="field-label">执行顺序</span>
        <Select aria-label="执行顺序" value={String(cur)} options={slots.map((n) => ({ value: String(n), label: label(n) }))}
          onValueChange={(v) => patch({ order: Number(v) })} />
        <span className="sop-muted">来一条消息时，IM 流程按这个顺序逐个判断、发起</span>
      </label>
      <Switch checked={im.stop} onCheckedChange={(stop) => patch({ stop })}>
        <span>命中后不再触发后面的 IM 流程</span>
      </Switch>
      {im.stop && <span className="sop-muted">这条流程接住（条件符合并发起了）的消息，排在后面的 IM 流程不再处理；不影响 IM 插件自己的处理和 Agent 的 IM 触发</span>}
      {blockers.length > 0 && (
        <div className="sop-start-sched-warn" role="note">
          排在前面的{blockers.map((f) => `「${f.name}」`).join('、')}会拦截：它们接住的消息不会再到这个流程
        </div>
      )}
    </div>
  )
}
