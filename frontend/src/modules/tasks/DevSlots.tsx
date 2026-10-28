// 任务抽屉下部开发闭环的四块位置（SPEC-tasks-5）：进展 DEV-08a、产出物 DEV-08b、执行记录 DEV-08c、改动 DEV-08d。
// 四块都已换成真内容；抽屉只负责按这个顺序摆放。
import type { WorkObject } from '../../core/api'
import { ArtifactsPanel } from './ArtifactsPanel'
import { ChangesPanel } from './Changes'
import { ProgressTimeline } from './ProgressTimeline'
import { RunsBlock } from './Runs'

type SlotProps = { task: WorkObject }

export function ProgressSlot({ task }: SlotProps) {
  return <ProgressTimeline task={task} />
}

export function ArtifactsSlot({ task }: SlotProps) {
  return <ArtifactsPanel task={task} />
}

export function RunsSlot({ task }: SlotProps) {
  return <RunsBlock task={task} />
}

export function ChangesSlot({ task }: SlotProps) {
  return <ChangesPanel task={task} />
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
