// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 技能抽屉，照原型 web-next/src/kbskills.tsx SkillDrawer（SPEC-settings-16）。新建、复制、查看、编辑共用。
// 内置和插件的技能只读，只能「复制一份来改」；复制出来的是还没保存的新技能，点「创建」才带 copy_from 落库。
// 和原型不同的地方：删除确认用确认弹窗，弹窗里列出挂着它的 Agent。
import { useMemo, useState } from 'react'
import { errorText, skillReadonly, useConnectors, useCreateSkill, useDeleteSkill, usePatchSkill, type Skill } from '../../../core/data'
import { Avatar, Button, cls, ConfirmDialog, Drawer, Field, Input, SearchSelect, Textarea } from '../../../core/ui'
import {
  BUILTIN_TOOLS, connectorToolOptions, copyForm, createBody, deleteText, EMPTY_FORM, formOf, missingOf, patchBody, pickedTools,
  toggleTool, withPicked, type SkillForm,
} from './model'

/** 在用的 Agent 先露几个 */
const CHIPS = 8

export function SkillDrawer({ skill, copyFrom, pluginName, onCreated, onDuplicate, onClose }: {
  /** 已有的技能；没有就是新建 */
  skill?: Skill
  /** 新建时从这个技能复制 */
  copyFrom?: Skill
  /** 插件技能的插件名 */
  pluginName?: string
  /** 创建成功：抽屉换成编辑这一条 */
  onCreated: (s: Skill) => void
  onDuplicate: (s: Skill) => void
  onClose: () => void
}) {
  const creating = !skill
  const readonly = !!skill && skillReadonly(skill)
  const [form, setForm] = useState<SkillForm>(() => (skill ? formOf(skill) : copyFrom ? copyForm(copyFrom) : EMPTY_FORM))
  const [baseline, setBaseline] = useState(form)
  const [tried, setTried] = useState(false)
  const [allAgents, setAllAgents] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conns = useConnectors()
  const create = useCreateSkill()
  const patch = usePatchSkill()
  const remove = useDeleteSkill()
  const busy = create.isPending || patch.isPending || remove.isPending

  const options = useMemo(() => connectorToolOptions(conns.data ?? []), [conns.data])
  const picked = pickedTools(form.uses)
  const missing = missingOf(form)
  const dirty = !readonly && JSON.stringify(form) !== JSON.stringify(baseline)
  const agents = skill?.agents ?? []

  const settle = (s: Skill) => {
    const f = formOf(s)
    setForm(f)
    setBaseline(f)
    setTried(false)
  }

  function save() {
    setError(null)
    setTried(true)
    if (missing.name || missing.instructions) return
    if (creating) {
      create.mutate(createBody(form, copyFrom?.id), {
        onSuccess: (s) => { settle(s); onCreated(s) },
        onError: (e) => setError(`创建失败：${errorText(e)}`),
      })
      return
    }
    const body = patchBody(form, skill)
    if (!Object.keys(body).length) { setTried(false); return }
    patch.mutate({ id: skill.id, patch: body }, {
      onSuccess: settle,
      onError: (e) => setError(`保存失败：${errorText(e)}`),
    })
  }

  function del() {
    if (!skill) return
    remove.mutate(skill.id, {
      onSuccess: () => { setConfirmDel(false); onClose() },
      onError: (e) => { setConfirmDel(false); setError(`删除失败：${errorText(e)}`) },
    })
  }

  const kicker = creating ? '新建技能' : readonly ? (skill.source === 'builtin' ? '内置技能' : '插件技能') : '技能'
  const lockedBy = skill?.source === 'builtin' ? '内置技能' : `插件「${pluginName ?? skill?.source ?? ''}」提供的技能`

  return (
    <Drawer open onClose={onClose} dirty={dirty} className="sk-drawer" kicker={kicker} aria-label={kicker}
      footer={(requestClose) => readonly ? (
        <>
          <div className="spacer" />
          <Button onClick={requestClose}>关闭</Button>
          <Button variant="primary" onClick={() => onDuplicate(skill!)}>复制一份来改</Button>
        </>
      ) : (
        <>
          {!creating && <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>删除</Button>}
          <div className="spacer" />
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={save}>{creating ? '创建' : '保存'}</Button>
        </>
      )}>
      <div className="sk-form">
        {readonly && <div className="sk-info">{lockedBy}不能直接改；要按自己的习惯调，点下面「复制一份来改」</div>}
        {error && <div className="sk-alert" role="alert">{error}</div>}

        <Field label="名称" required>
          <Input value={form.name} disabled={readonly} autoFocus={creating} invalid={tried && missing.name} placeholder="比如：竞品分析"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="一句话说明">
          <Input value={form.desc} disabled={readonly} onChange={(e) => setForm({ ...form, desc: e.target.value })} />
        </Field>
        <Field label={<>什么时候用<span className="sk-hint">Agent 靠这句话判断该不该用这个技能</span></>}>
          <Input value={form.when} disabled={readonly} placeholder="比如：用户要对比几家竞品、或者问某家竞品最近更新了什么时"
            onChange={(e) => setForm({ ...form, when: e.target.value })} />
        </Field>
        <Field label={<>怎么做<span className="sk-hint">步骤、格式、注意事项</span></>} required>
          <Textarea rows={7} className="sk-prompt" value={form.instructions} disabled={readonly} invalid={tried && missing.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        </Field>

        <Field wrap={false} label={<>用到的工具<span className="sk-hint">只是说明；Agent 有没有这些工具的权限，在 Agent 配置里定</span></>}>
          <div className="sk-chips" role="group" aria-label="内置工具">
            {BUILTIN_TOOLS.map((t) => (
              <label key={t} className={cls('sk-chip', form.uses.includes(t) && 'on', readonly && 'disabled')}>
                <input type="checkbox" disabled={readonly} checked={form.uses.includes(t)}
                  onChange={() => setForm({ ...form, uses: toggleTool(form.uses, t) })} />{t}
              </label>
            ))}
          </div>
          <div className="sk-chips sk-tools" role="group" aria-label="连接器工具">
            {picked.map((t) => (
              <label key={t} className={cls('sk-chip on sk-tool', readonly && 'disabled')} title={t}>
                <input type="checkbox" disabled={readonly} checked
                  onChange={() => setForm({ ...form, uses: withPicked(form.uses, picked.filter((x) => x !== t)) })} />
                <span className="ellipsis">{t}</span>
              </label>
            ))}
            {!readonly && (
              <SearchSelect multiple value={picked} onChange={(xs) => setForm({ ...form, uses: withPicked(form.uses, xs) })}
                placeholder={picked.length ? '加工具' : '加连接器工具'} searchPlaceholder="搜连接器或工具名" options={options}
                emptyText="还没有接入带工具的连接器" missingLabel={(v) => v} menuWidth={360} active={false} />
            )}
            {readonly && !picked.length && <span className="sk-muted">没有用到连接器工具</span>}
          </div>
        </Field>

        <div className="field">
          <span className="field-label">在用的 Agent</span>
          {agents.length ? (
            <div className="sk-agents">
              {(allAgents ? agents : agents.slice(0, CHIPS)).map((a) => (
                <span key={a.id} className="tag sk-agent" title={a.name}><Avatar name={a.name} size={16} /><span className="ellipsis">{a.name}</span></span>
              ))}
              {agents.length > CHIPS && (
                <button type="button" className="sk-link" onClick={() => setAllAgents(!allAgents)}>
                  {allAgents ? '收起' : `还有 ${agents.length - CHIPS} 个`}
                </button>
              )}
            </div>
          ) : <span className="sk-muted">还没有 Agent 挂这个技能</span>}
        </div>
      </div>

      <ConfirmDialog open={confirmDel} danger title={`删除「${skill?.name ?? ''}」？`} confirmLabel="删除" busy={remove.isPending}
        onCancel={() => setConfirmDel(false)} onConfirm={del}
        impactsTitle="挂着它的 Agent" impacts={agents.map((a) => a.name)}>
        {deleteText(agents)}
      </ConfirmDialog>
    </Drawer>
  )
}
