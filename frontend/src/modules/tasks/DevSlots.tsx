// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务抽屉下部开发闭环的四块位置（SPEC-tasks-5）：进展 DEV-08a、产出物 DEV-08b、执行记录 DEV-08c、改动 DEV-08d。
// 四块都已换成真内容；抽屉只负责按这个顺序摆放。待验收时先看改动和产出物，再看进展（PR-07，product-review C-02）。
// 任务详情分标签后，进展、产出物、改动在「开发任务」标签里（DevSlots），执行记录单独一个标签（RunsSlot）。
// 开发任务标签只露「交给执行」（SPEC-tasks-4.87）：进展、产出物自己的「记一条进展」「登记产出物」收进抽屉的「更多」，由 adds 触发。
import type { WorkObject } from '../../core/data'
import { ArtifactsPanel } from './ArtifactsPanel'
import { ChangesPanel } from './Changes'
import { ProgressTimeline } from './ProgressTimeline'
import { RunsBlock } from './Runs'
import { FOCUS_ARTIFACTS } from './drawerTabs'

type SlotProps = { task: WorkObject }

/** 「更多」里点了几次「记一条进展」「登记产出物」：变了就展开对应表单 */
export type DevAdds = { progress: number; artifact: number }

export function ProgressSlot({ task, add }: SlotProps & { add?: number }) {
  return <ProgressTimeline task={task} addSignal={add} />
}

export function ArtifactsSlot({ task, focused, add }: SlotProps & { focused?: boolean; add?: number }) {
  return <ArtifactsPanel task={task} focused={focused} addSignal={add} />
}

export function RunsSlot({ task, focus }: SlotProps & { focus?: string }) {
  return <RunsBlock task={task} focus={focus} />
}

export function ChangesSlot({ task }: SlotProps) {
  return <ChangesPanel task={task} />
}

/** focus：地址上的 ?focus=（TSK-0497，artifacts 是产出物面板） */
export function DevSlots({ task, reviewing, focus, adds }: SlotProps & { reviewing?: boolean; focus?: string; adds?: DevAdds }) {
  const artFocused = focus === FOCUS_ARTIFACTS
  if (reviewing) {
    return (
      <div className="dev-slots">
        <ChangesSlot task={task} />
        <ArtifactsSlot task={task} focused={artFocused} add={adds?.artifact} />
        <ProgressSlot task={task} add={adds?.progress} />
      </div>
    )
  }
  return (
    <div className="dev-slots">
      <ProgressSlot task={task} add={adds?.progress} />
      <ArtifactsSlot task={task} focused={artFocused} add={adds?.artifact} />
      <ChangesSlot task={task} />
    </div>
  )
}
