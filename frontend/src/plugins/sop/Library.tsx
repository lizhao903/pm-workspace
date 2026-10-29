// 流程库（SPEC-sop-2）：全部流程的卡片，有执行停下来等人的排在前面。统计（执行次数、待处理、最近执行）按执行列表现算。
// 用到当前工作台没开的模块的流程（比如产品经理工作台里的「视频周更」）标「需要视频模块」，排在最后（SPEC-sop-2.11）
import { useState } from 'react'
import type { SopFlow } from '../../core/data'
import { Button, EmptyState, IconSearch, PageTitle, cls } from '../../core/ui'
import { libPass, libraryRows, timeAgo, type FlowStat, type LibFilter } from './model'
import { IconPlus } from './parts'
import { needsText } from './scope'

const FILTERS: [LibFilter, string][] = [['', '全部'], ['pending', '有待处理'], ['never', '没执行过']]

export function Library({ flows, stats, needs, trigger, onOpen, onNew, now }: {
  flows: readonly SopFlow[]
  stats: Map<string, FlowStat>
  /** 流程要的、当前工作台没开的模块名 */
  needs: (f: SopFlow) => string[]
  /** 触发方式的显示名 */
  trigger: (t: string) => string
  onOpen: (id: string) => void
  onNew: () => void
  now: number
}) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<LibFilter>('')
  const rows = libraryRows(flows, stats, f, q, { trigger, elsewhere: (x) => needs(x).length > 0 })
  const filtered = !!(f || q.trim())
  return (
    <div className="sop-page">
      <PageTitle parent="SOP" count={flows.length} desc="全部标准流程；有执行停下来等你的排在前面"
        actions={<Button variant="primary" onClick={onNew}><IconPlus />新建 SOP</Button>}>
        流程库
      </PageTitle>
      <div className="sop-toolbar">
        <div className="sop-seg" role="group" aria-label="筛选流程">
          {FILTERS.map(([k, l]) => (
            <button key={k} type="button" className={cls(f === k && 'on')} aria-pressed={f === k} onClick={() => setF(k)}>
              {l}<span className="seg-n">{flows.filter((x) => libPass(x, k, stats)).length}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input placeholder="搜索流程名、说明、触发方式" aria-label="搜索流程" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <EmptyState
          title={filtered ? '没有匹配的流程' : '还没有标准流程'}
          desc={filtered ? '换个筛选条件试试' : '把反复做的事情编排成 SOP，每次按同样的步骤执行'}
          action={!filtered && <Button variant="primary" onClick={onNew}><IconPlus />新建 SOP</Button>} />
      ) : (
        <div className="sop-lib-grid">
          {rows.map((s) => {
            const x = stats.get(s.id)
            const need = needs(s)
            return (
              <button key={s.id} type="button" className={cls('sop-lib-card', need.length > 0 && 'elsewhere')} onClick={() => onOpen(s.id)}>
                <span className="sop-lib-head">
                  <span className="sop-lib-name ellipsis" title={s.name}>{s.name}</span>
                  {!!x?.pending && <span className="sop-lib-pending">{x.pending} 个待处理</span>}
                  {need.length > 0 && <span className="sop-lib-need" title="这个工作台没开这个模块，执行时可能选不到要的数据">{needsText(need)}</span>}
                </span>
                <span className="sop-lib-desc" title={s.desc}>{s.desc || '没有说明'}</span>
                <span className="sop-lib-meta">
                  <span>{s.steps.length} 步</span>
                  <span>{x ? `执行 ${x.n} 次` : '没执行过'}</span>
                  {x && <span>{timeAgo(new Date(x.last).toISOString(), now)}执行</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
