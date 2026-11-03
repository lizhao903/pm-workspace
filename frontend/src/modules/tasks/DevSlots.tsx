// 任务抽屉下部开发闭环的四块位置（SPEC-tasks-5）：进展 DEV-08a、产出物 DEV-08b、执行记录 DEV-08c、改动 DEV-08d。
// 四块都已换成真内容；抽屉只负责按这个顺序摆放。待验收时先看改动和产出物，再看进展（PR-07，product-review C-02）。
// 任务详情分标签后，进展、产出物、改动在「开发任务」标签里（DevSlots），执行记录单独一个标签（RunsSlot）。
import type { WorkObject } from '../../core/data'
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

export function RunsSlot({ task, focus }: SlotProps & { focus?: string }) {
  return <RunsBlock task={task} focus={focus} />
}

export function ChangesSlot({ task }: SlotProps) {
  return <ChangesPanel task={task} />
}

export function DevSlots({ task, reviewing }: SlotProps & { reviewing?: boolean }) {
  if (reviewing) {
    return (
      <div className="dev-slots">
        <ChangesSlot task={task} />
        <ArtifactsSlot task={task} />
        <ProgressSlot task={task} />
      </div>
    )
  }
  return (
    <div className="dev-slots">
      <ProgressSlot task={task} />
      <ArtifactsSlot task={task} />
      <ChangesSlot task={task} />
    </div>
  )
}
