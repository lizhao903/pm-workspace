// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 配置页的「触发方式」标签（SPEC-settings-9.24、9.25），结构化条件 match 见 AG-01b4：
// 任务触发选「分配给它」或填标签；IM 触发选连接器、会话、只看与我相关；定时由定时任务的 Agent 动作指过来。
import { useConnectors, useConversations, type AgentTrigger, type AgentTriggerKind, type AgentTriggerMatch } from '../../../core/data'
import { Button, Checkbox, Input, SearchSelect, Select, Switch } from '../../../core/ui'
import { emptyMatch, taskMatchOf, TRIGGER_KINDS, TRIGGER_LABEL, TRIGGER_PLACEHOLDER, triggerHasCondition } from './model'

const kindOptions = TRIGGER_KINDS.map((k) => ({ value: k, label: TRIGGER_LABEL[k] }))
const splitTags = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)

export function TriggersTab({ triggers, onChange, tried }: { triggers: AgentTrigger[]; onChange: (ts: AgentTrigger[]) => void; tried: boolean }) {
  const set = (i: number, t: AgentTrigger) => onChange(triggers.map((y, j) => (j === i ? t : y)))
  return (
    <section className="ag-sec">
      <div className="ag-sec-title">触发方式</div>
      <div className="ag-triggers">
        {triggers.map((t, i) => (
          <TriggerRow key={i} index={i} t={t} only={triggers.length < 2} bad={tried && !triggerHasCondition(t)}
            onChange={(x) => set(i, x)} onRemove={() => onChange(triggers.filter((_, j) => j !== i))} />
        ))}
        <div>
          <Button size="sm" onClick={() => onChange([...triggers, { kind: 'schedule', detail: '' }])}>加一个触发方式</Button>
        </div>
      </div>
    </section>
  )
}

function TriggerRow({ index, t, only, bad, onChange, onRemove }: {
  index: number
  t: AgentTrigger
  only: boolean
  bad: boolean
  onChange: (t: AgentTrigger) => void
  onRemove: () => void
}) {
  const kind = t.kind as AgentTriggerKind
  // 换类型时条件按新类型重来：后端只留各自的字段
  const setKind = (k: AgentTriggerKind) => onChange({ kind: k, detail: k === 'manual' ? '' : t.detail })
  const setMatch = (p: Partial<AgentTriggerMatch>, base: AgentTriggerMatch) => onChange({ ...t, match: { ...base, ...p } })
  return (
    <div className="ag-trigger" data-trigger={index}>
      <div className="ag-trigger-line">
        <Select className="ag-trigger-kind" aria-label="触发类型" value={kind} options={kindOptions} onValueChange={(v) => setKind(v as AgentTriggerKind)} />
        {kind === 'manual'
          ? <span className="ag-sub ag-grow">在「会话」里直接找它</span>
          : <Input className="ag-grow" aria-label="触发条件" invalid={bad} value={t.detail} placeholder={TRIGGER_PLACEHOLDER[kind] ?? ''}
              onChange={(e) => onChange({ ...t, detail: e.target.value })} />}
        <Button size="sm" disabled={only} title={only ? '至少留一个触发方式' : undefined} onClick={onRemove}>删除</Button>
      </div>
      {kind === 'task' && <TaskMatch t={t} onMatch={setMatch} />}
      {kind === 'im' && <ImMatch t={t} onMatch={setMatch} />}
      {kind === 'schedule' && <div className="ag-trigger-more ag-sub">到点由定时任务的「Agent」动作触发：在定时任务里选它，这里的条件只是说明</div>}
    </div>
  )
}

type MatchProps = { t: AgentTrigger; onMatch: (p: Partial<AgentTriggerMatch>, base: AgentTriggerMatch) => void }

function TaskMatch({ t, onMatch }: MatchProps) {
  const m = taskMatchOf(t)
  const none = !m.assigned && !m.tags.length
  return (
    <div className="ag-trigger-more">
      <Checkbox checked={m.assigned} onChange={(e) => onMatch({ assigned: e.target.checked }, m)}>任务分配给它</Checkbox>
      <span className="ag-sub">或者标签含</span>
      <Input key={m.tags.join('，')} className="ag-trigger-tags" aria-label="标签" placeholder="多个用逗号隔开" defaultValue={m.tags.join('，')}
        onBlur={(e) => onMatch({ tags: splitTags(e.target.value) }, m)} />
      {none && <span className="field-err">至少选「任务分配给它」或者填标签</span>}
    </div>
  )
}

function ImMatch({ t, onMatch }: MatchProps) {
  const m = t.match ?? emptyMatch()
  const conns = useConnectors().data ?? []
  const convs = useConversations().data ?? []
  return (
    <div className="ag-trigger-more">
      <span className="ag-trigger-pick">
        <SearchSelect variant="field" aria-label="连接器" value={m.connector_id} noneLabel="全部连接器" placeholder="全部连接器" searchPlaceholder="搜连接器"
          options={conns.map((c) => ({ value: c.id, label: c.name, hint: c.account }))} missingLabel={() => '已删除的连接器'}
          onChange={(v) => onMatch({ connector_id: v ?? '' }, m)} />
      </span>
      <span className="ag-trigger-pick">
        <SearchSelect variant="field" aria-label="会话" value={m.conversation_id} noneLabel="全部会话" placeholder="全部会话" searchPlaceholder="搜群或私聊"
          options={convs.map((c) => ({ value: c.id, label: c.name || c.external_id, hint: c.channel }))} missingLabel={() => '已删除的会话'}
          onChange={(v) => onMatch({ conversation_id: v ?? '' }, m)} />
      </span>
      <Switch checked={m.only_me} onCheckedChange={(v) => onMatch({ only_me: v }, m)}>只看与我相关的</Switch>
    </div>
  )
}
