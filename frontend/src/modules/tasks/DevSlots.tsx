// 任务抽屉下部开发闭环的四块位置（SPEC-tasks-5）：进展 DEV-08a、产出物 DEV-08b、执行记录 DEV-08c、改动 DEV-08d。
// 现在只占位，各任务把对应的组件换成真内容；抽屉只负责按这个顺序摆放。
import type { WorkObject } from '../../core/api'

type SlotProps = { task: WorkObject }

function Slot({ task, slot, title, desc }: SlotProps & { slot: string; title: string; desc: string }) {
  return (
    <section className="dev-slot" data-slot={slot} data-task={task.id} aria-label={title}>
      <div className="dev-slot-head"><span className="field-group-title">{title}</span></div>
      <div className="dev-slot-empty">{desc}</div>
    </section>
  )
}

export function ProgressSlot({ task }: SlotProps) {
  return <Slot task={task} slot="progress" title="进展" desc="进展时间线还没接上（DEV-08a）" />
}

export function ArtifactsSlot({ task }: SlotProps) {
  return <Slot task={task} slot="artifacts" title="产出物" desc="产出物还没接上（DEV-08b）" />
}

export function RunsSlot({ task }: SlotProps) {
  return <Slot task={task} slot="runs" title="执行记录" desc="执行记录还没接上（DEV-08c）" />
}

export function ChangesSlot({ task }: SlotProps) {
  return <Slot task={task} slot="changes" title="改动" desc="改动痕迹还没接上（DEV-08d）" />
}

export function DevSlots({ task }: SlotProps) {
  return (
    <div className="dev-slots">
      <ProgressSlot task={task} />
      <ArtifactsSlot task={task} />
      <RunsSlot task={task} />
      <ChangesSlot task={task} />
    </div>
  )
}
