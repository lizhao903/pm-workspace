// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息和项目资料互相追溯（0009）：列表行上的「已转资料」小标，抽屉里的「项目资料」一节（转项目资料、转过的资料能点过去）。
import type { ImMessage } from '../../core/data'
import { materialHint, noteMaterials } from './toMaterialModel'

/** 行上的小标：转过资料的，点了打开最近的一条 */
export function MaterialTag({ msgs, onOpen }: { msgs: readonly ImMessage[]; onOpen: (projectId: string, materialId: string) => void }) {
  const notes = noteMaterials(msgs)
  if (!notes.length) return null
  return (
    <button type="button" className="im-state im-state-task" title={`打开${notes.length > 1 ? '最近的一条' : '这条资料'}\n${notes.map(materialHint).join('\n')}`}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onOpen(notes[0].project_id, notes[0].material_id) }}>
      已转资料{notes.length > 1 ? ` ${notes.length}` : ''}
    </button>
  )
}

/** 抽屉里「项目资料」一节：转过的资料；没转过时不显示（「转项目资料」在发送按钮那一行） */
export function MaterialSection({ msgs, onOpen }: {
  msgs: readonly ImMessage[]
  onOpen: (projectId: string, materialId: string) => void
}) {
  const notes = noteMaterials(msgs)
  if (!notes.length) return null
  return (
    <>
      <div className="im-section">项目资料</div>
      {notes.length > 0 && (
        <div className="im-act-row im-links">
          <span className="im-muted">已转资料 {notes.length} 条</span>
          {notes.map((r) => (
            <button key={r.material_id} type="button" className="link-btn" title={materialHint(r)} onClick={() => onOpen(r.project_id, r.material_id)}>
              {r.title || '未命名'}（{r.project_name || '项目'}{r.count > 1 && r.count !== msgs.length ? `，共 ${r.count} 条` : ''}）
            </button>
          ))}
        </div>
      )}
    </>
  )
}
