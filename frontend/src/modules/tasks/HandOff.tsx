// 交给 Claude Code（DEV-09，照原型 devloop.tsx 的 RunDialog 和 quicksession.tsx 的弹窗样式）。
// 弹窗里选工作目录、只读或允许写入、附加说明；默认只读，勾「允许写入」先二次确认。
// 发起走 runLive.startRun，输出在执行记录里流式显示；同一任务有执行在跑时按钮变成「查看运行中」。
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkObject } from '../../core/api'
import { useWorkdirCheck, workdirUsable } from '../../core/api/taskEdit'
import { useTaskRuns } from '../../core/api/taskRuns'
import { Button, Checkbox, ConfirmDialog, Field, IconButton, IconClose, Textarea } from '../../core/ui'
import { restoreFocus, trapTab } from '../../core/ui/focus'
import { defaultWorkdir, runRequest, runningOf } from './handoffModel'
import { startRun, useLiveRuns } from './runLive'
import { WorkdirField } from './WorkdirField'
import './handoff.css'

// 和 WorkdirField 一样停手片刻再校验，两边查询键相同，只发一次请求
const CHECK_DELAY = 400

// 滚到执行记录里那一条；还没拿到 run id 时滚到执行记录这一块
function scrollToRun(taskId: string, runId?: string) {
  const find = (sel: string, f: (el: HTMLElement) => boolean) => Array.from(document.querySelectorAll<HTMLElement>(sel)).find(f)
  const el = (runId && find('[data-run]', (x) => x.dataset.run === runId))
    || find('[data-slot="runs"]', (x) => x.dataset.task === taskId)
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

export function HandOffButton({ task, workdir, inherit }: {
  task: WorkObject
  /** 抽屉里当前填的工作目录（可能还没保存） */
  workdir: string
  inherit?: { project: string; dir: string }
}) {
  const [open, setOpen] = useState(false)
  const rows = useTaskRuns(task.id)
  const live = useLiveRuns()
  const running = runningOf(task.id, rows.data, live)

  if (running !== undefined) {
    return (
      <Button size="sm" variant="outline" onClick={() => scrollToRun(task.id, running)}>
        <span className="ho-light" aria-hidden="true" />查看运行中
      </Button>
    )
  }
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>交给 Claude Code</Button>
      {open && (
        <RunDialog task={task} workdir={workdir} inherit={inherit} onClose={() => setOpen(false)}
          onStart={() => {
            setOpen(false)
            requestAnimationFrame(() => scrollToRun(task.id))
          }} />
      )}
    </>
  )
}

export function RunDialog({ task, workdir, inherit, onStart, onClose }: {
  task: WorkObject
  workdir: string
  inherit?: { project: string; dir: string }
  /** 已经发起，弹窗该关了 */
  onStart: () => void
  onClose: () => void
}) {
  const init = defaultWorkdir(workdir, inherit?.dir)
  const [dir, setDir] = useState(init.dir)
  const [allow, setAllow] = useState(false)
  const [asking, setAsking] = useState(false)
  const [extra, setExtra] = useState('')
  const [checked, setChecked] = useState(init.dir)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const [prev] = useState(() => document.activeElement)

  useEffect(() => {
    const p = dir.trim()
    if (p === checked) return
    const t = setTimeout(() => setChecked(p), CHECK_DELAY)
    return () => clearTimeout(t)
  }, [dir, checked])
  const check = useWorkdirCheck(checked)
  const typing = dir.trim() !== checked

  const closeFn = useRef(onClose)
  const askingRef = useRef(asking)
  useEffect(() => {
    closeFn.current = onClose
    askingRef.current = asking
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      // 二次确认开着时键盘归它；选目录里的 Esc 只收起目录
      if (!el || askingRef.current) return
      if (e.key === 'Escape') {
        if (e.target instanceof Element && e.target.closest('.wd-picker')) return
        e.preventDefault()
        e.stopPropagation()
        closeFn.current()
      } else if (e.key === 'Tab') {
        trapTab(el, e)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restoreFocus(prev)
    }
  }, [prev])

  let dirErr = ''
  if (!dir.trim()) dirErr = '选一个工作目录，任务和所属项目都没设'
  const usable = !typing && !!check.data && workdirUsable(check.data)
  const ready = !dirErr && usable && !asking

  let source = '这次执行用的目录'
  if (init.from === 'task' && dir.trim() === init.dir) source = '任务上设的'
  else if (init.from === 'project' && dir.trim() === init.dir) source = `继承自所属项目「${inherit?.project ?? ''}」`

  const submit = () => {
    if (!ready) return
    startRun(task.id, runRequest(dir, extra, allow))
    onStart()
  }

  return createPortal(
    <>
      <div className="dialog-scrim ho-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div ref={ref} className="ho" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}>
          <div className="ho-head">
            <b id={`${id}-t`}>交给 Claude Code</b>
            <span className="ho-sub ellipsis" title={`${task.ref} ${task.title}`}>{task.ref} {task.title}</span>
            <span className="spacer" />
            <IconButton label="关闭 (Esc)" onClick={onClose}><IconClose /></IconButton>
          </div>
          <div className="ho-dir">
            <WorkdirField value={dir} onChange={setDir} />
            {dirErr
              ? <span className="field-err" role="alert">{dirErr}</span>
              : <span className="field-hint-line">{source}</span>}
          </div>
          <div className="ho-perm">
            <Checkbox className="ho-check" checked={allow}
              onCheckedChange={(v) => { if (v) setAsking(true); else setAllow(false) }}>
              允许写入
            </Checkbox>
            <span className="field-hint-line">
              {allow ? '会以 acceptEdits 权限模式运行：可以直接改工作目录里的文件' : '默认只读：只跑一遍看它打算怎么做，不改文件'}
            </span>
          </div>
          <Field label="附加说明">
            <Textarea rows={3} value={extra} autoFocus
              placeholder="可选：这次要特别注意的事，会接在任务内容后面发给 Claude Code"
              onChange={(e) => setExtra(e.target.value)} />
          </Field>
          <div className="ho-foot">
            <span className="field-hint-line">执行过程会流式显示在任务的执行记录里</span>
            <span className="spacer" />
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!ready} onClick={submit}>
              {typing && !dirErr ? '正在校验目录' : allow ? '开始执行（允许写入）' : '开始执行（只读）'}
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog open={asking} danger title="允许写入？" confirmLabel="确认允许写入" cancelLabel="算了，只读"
        onConfirm={() => { setAllow(true); setAsking(false) }} onCancel={() => setAsking(false)}>
        会以 acceptEdits 权限模式运行：Claude Code 可以不经确认直接改「{dir.trim() || '工作目录'}」里的文件。
        其他需要权限的操作仍会被挡下，任何情况下都不会跳过权限确认。
      </ConfirmDialog>
    </>,
    document.body,
  )
}
