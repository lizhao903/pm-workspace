// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 制作流程里一个阶段的执行器（VID-03c，同原型 web-next/src/videos.tsx 的 runnerBox）：配了就显示是谁、能不能跑、上次跑的结果，
// 没配就在当前阶段给个入口。前置检查（检查点没过、不是当前阶段、别的阶段在跑）由后端 409 回原因，这里照原文提示。
// 跑起来以后由 useWatchVideoRun 轮询这个视频，跑完产出物进「待验收」，检查点仍由人确认。
// VID-09b：内容编写的执行器只在这里配，跑（按选题大纲起草）和结果都在编辑区（ScriptDesk.tsx）。
import { useNavigate } from 'react-router'
import {
  errorText, usePutRunner, useRemoveRunner, useRunStage, type Video, type VideoStageKey, type VideoStageRunner,
} from '../../core/data'
import { Button, Field, Input, Select, cls } from '../../core/ui'
import { STAGES, timeAgo } from './model'
import { RUNNER_SKILLS, RUNNER_TYPE, RUNNER_TYPES, findChoice, lastRunLink, runnerName } from './runnerModel'
import type { RunnerChoices } from './runnerChoices'

const PROMPT_MAX = 2000

export function RunnerBox({ v, stage, cur, choices, edit, onEdit }: {
  v: Video
  stage: VideoStageKey
  /** 是不是视频当前所在的阶段；只有当前阶段能跑 */
  cur: boolean
  choices: RunnerChoices
  /** 正在改这个阶段时的草稿 */
  edit: VideoStageRunner | null
  onEdit: (r: VideoStageRunner | null) => void
}) {
  const navigate = useNavigate()
  const put = usePutRunner()
  const remove = useRemoveRunner()
  const run = useRunStage()
  const r = v.runners?.find((x) => x.stage === stage)
  const last = v.last_run?.stage === stage ? v.last_run : undefined
  const running = v.last_run?.status === 'running'
  const saving = put.isPending || remove.isPending
  const label = STAGES.find((s) => s.key === stage)?.label ?? stage

  if (edit) {
    const list = choices.list(edit.type)
    const hit = findChoice(list, edit.ref_id)
    const known = choices.known(edit.type)
    // 后端 ref_id 认 id 也认名称，列表里找得到就换成 id 显示；找不到的留一项占位
    const value = hit?.id ?? edit.ref_id
    const options = [
      ...(!hit ? [{ value: edit.ref_id, label: !edit.ref_id ? '选一个' : known ? `已删除的${RUNNER_TYPE[edit.type]}` : edit.ref_id }] : []),
      ...list.map((c) => ({ value: c.id, label: c.name })),
    ]
    const err = put.error ?? remove.error
    const save = () => {
      if (!hit || saving) return
      remove.reset()
      put.mutate({ id: v.id, stage, type: edit.type, ref_id: hit.id, prompt: edit.prompt?.trim() || undefined }, { onSuccess: () => onEdit(null) })
    }
    const drop = () => {
      if (saving) return
      put.reset()
      remove.mutate({ id: v.id, stage }, { onSuccess: () => onEdit(null) })
    }
    return (
      <div className="vd-runner vd-runner-edit" aria-label={`${label}的执行器`}>
        <div className="vd-runner-row">
          <Field label="交给谁跑" wrap={false}>
            <div className="vd-sort" role="group" aria-label="执行器类型">
              {RUNNER_TYPES.map((t) => (
                <button key={t} type="button" aria-pressed={edit.type === t} className={cls(edit.type === t && 'on')}
                  onClick={() => onEdit({ ...edit, type: t, ref_id: choices.list(t)[0]?.id ?? '' })}>{RUNNER_TYPE[t]}</button>
              ))}
            </div>
          </Field>
          <Field label={RUNNER_TYPE[edit.type]} className="vd-runner-pick"
            hint={!list.length ? (known ? `还没有${RUNNER_TYPE[edit.type]}，先去建一个` : `${RUNNER_TYPE[edit.type]}列表没取回来`) : undefined}>
            <Select value={value} options={options} onValueChange={(x) => onEdit({ ...edit, ref_id: x })} />
          </Field>
        </div>
        <Field label={<>交代给它的话<span className="vd-hint">可不填</span></>}>
          <Input value={edit.prompt ?? ''} maxLength={PROMPT_MAX} placeholder="比如：按 Phase 1 出横竖两套口播稿"
            onChange={(e) => onEdit({ ...edit, prompt: e.target.value })} />
        </Field>
        {err && <div className="vd-err" role="alert">{errorText(err)}</div>}
        <div className="vd-act-row">
          <Button variant="primary" size="sm" disabled={!hit || saving} onClick={save}>保存</Button>
          <Button size="sm" disabled={saving} onClick={() => { put.reset(); remove.reset(); onEdit(null) }}>取消</Button>
          {r && <><span className="spacer" /><Button variant="danger-ghost" size="sm" disabled={saving} onClick={drop}>不用执行器</Button></>}
        </div>
      </div>
    )
  }

  if (!r) {
    if (!cur) return null
    return (
      <div className="vd-runner vd-runner-none">
        <span className="vd-muted">{stage === 'script' ? '没配执行器，按选题大纲起草时用技能「网页演示做视频」' : '没配执行器，产出物手动登记'}</span>
        <button type="button" className="vd-link" onClick={() => onEdit({ stage, type: 'skill', ref_id: RUNNER_SKILLS[0].id })}>配执行器</button>
      </div>
    )
  }

  const name = runnerName(r, choices.list(r.type), choices.known(r.type))
  const busy = last?.status === 'running'
  const link = last ? lastRunLink(last) : null
  const onRun = () => {
    if (running || run.isPending) return
    run.mutate({ id: v.id, stage })
  }
  const otherBusy = running && !busy
  // 内容编写不在这里跑，在编辑区里「按选题大纲起草」，起草的状态也显示在编辑区
  const inDesk = stage === 'script'
  return (
    <div className={cls('vd-runner', last?.status === 'failed' && 'vd-runner-failed')} aria-label={`${label}的执行器`}>
      <div className="vd-runner-head">
        <span className="vd-runner-type">{RUNNER_TYPE[r.type]}</span>
        <span className={cls('ellipsis vd-runner-name', !name && 'vd-faint')} title={r.prompt}>{name ?? `已删除的${RUNNER_TYPE[r.type]}`}</span>
        {r.prompt && <span className="ellipsis vd-runner-prompt">{r.prompt}</span>}
        <span className="spacer" />
        {!busy && <Button size="sm" onClick={() => { run.reset(); onEdit(r) }}>修改</Button>}
        {cur && !inDesk && (
          <Button variant="primary" size="sm" disabled={running || run.isPending} title={otherBusy ? '另一个阶段正在跑，等它跑完' : undefined} onClick={onRun}>
            {busy ? '运行中…' : run.isPending ? '正在发起…' : last?.status === 'failed' ? '重试' : '运行'}
          </Button>
        )}
      </div>
      {run.error && <div className="vd-err" role="alert">{errorText(run.error)}</div>}
      {busy && !inDesk && (
        <div className="vd-runner-state" role="status">
          <i className="spinner vd-spin" aria-hidden="true" />正在跑，开始于 {timeAgo(last.started_at)}；跑完产出物会进「待验收」
          {link && <button type="button" className="vd-link" onClick={() => navigate(link.to)}>{link.label}</button>}
        </div>
      )}
      {last?.status === 'failed' && !inDesk && (
        <div className="vd-cp-reject" role="status">
          运行失败：{last.error || '没有返回原因'}{last.ended_at && ` · ${timeAgo(last.ended_at)}`}
          {link && <> <button type="button" className="vd-link" onClick={() => navigate(link.to)}>{link.label}</button></>}
        </div>
      )}
      {last?.status === 'done' && !inDesk && (
        <div className="vd-runner-state ok" role="status">
          {timeAgo(last.ended_at ?? last.started_at)}跑完，{last.artifact_ids?.length ? `登记了 ${last.artifact_ids.length} 个产出物，待验收` : '没有新产出物'}
          {stage !== 'web' && STAGES.find((x) => x.key === stage)?.checkpoint && <span className="vd-muted">；检查点还要你来确认</span>}
          {link && <button type="button" className="vd-link" onClick={() => navigate(link.to)}>{link.label}</button>}
        </div>
      )}
    </div>
  )
}
