// SOP 编排插件（SOP-04b 起）：清单在后端 internal/plugins/sop/plugin.json，这里只有入口。
// 执行状态变化靠事件流：sop.run_status_changed、sop.step_status_changed 报 sop-run，一批事件合成一次刷新；停用插件时退订
import { lazy } from 'react'
import { TODAY_ORDER, definePlugin } from '../../core/plugin'
import {
  WAITING_STAGES, listAllObjects, notifyChange, onServerEvent, sopApi, todayKeys, type SopWaitingItem, type WorkObject,
} from '../../core/data'
import { waitingTodayItems } from './pipelineModel'

const EVENTS = ['sop.run_status_changed', 'sop.step_status_changed']
// 一次动作往往连着发好几条（步骤、执行各一条），合成一次失效
const FLUSH_MS = 80

let offs: (() => void)[] = []
let timer: ReturnType<typeof setTimeout> | undefined

function onEvent() {
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    void notifyChange({ kind: 'sop-run' })
  }, FLUSH_MS)
}

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'sop',
      label: 'SOP',
      path: 'sop',
      load: () => import('./Page'),
    })
    // 设置 > 插件 > SOP 编排（SOP-07、AUTO-12）：同时调模型的步骤数、流水线治理；运行页排队中、超出上限的步骤带入口
    api.settings.register({
      key: 'sop',
      label: 'SOP 编排',
      desc: '执行并发和流水线治理',
      page: lazy(() => import('./Settings')),
    })
    // 任务详情里的「SOP 执行」（SOP-06）：关联到这条任务的执行和「执行 SOP」
    // 任务详情分了标签，这块单独一个「SOP」标签：名字后面是执行条数，有没结束的带状态点；地址带 ?sop_run= 时切过来并定位那次执行
    api.objectSections.register({
      key: 'sop-runs', typeIds: ['task'], order: 50, section: lazy(() => import('./ObjectRuns')),
      tab: { key: 'sop', label: 'SOP', badge: lazy(() => import('./ObjectRunsBadge')), focusParam: 'sop_run' },
    })
    // 任务详情的「流水线」（AUTO-12，SPEC-sop-16）：阶段变化、自动执行的每一步、卡点和预算，排在 SOP 标签前面；看板点卡片默认停在这里
    api.objectSections.register({
      key: 'pipeline', typeIds: ['task'], order: 45, section: lazy(() => import('./Pipeline')),
      tab: { key: 'pipeline', label: '流水线', badge: lazy(() => import('./PipelineBadge')) },
    })
    // 今日「需要你处理」里的「待我处理」（AUTO-12，SPEC-today-1.30）：SOP 里等人的步骤，加停在等人阶段的任务。
    // 键挂在今日前缀下：执行变化（sop-run）和任务变化都会刷今日
    api.todaySources.register({
      key: 'waiting', slot: 'need', label: '待我处理', order: TODAY_ORDER.sop, more: '/sop/waiting',
      queryKey: [...todayKeys.all, 'sop-waiting'],
      queryFn: async ({ signal }) => {
        const [steps, tasks] = await Promise.all([
          sopApi.waiting(signal),
          listAllObjects({ type: ['task'], stage: [...WAITING_STAGES], not_terminal: true }, signal),
        ])
        return { steps, tasks: tasks.data }
      },
      select: (d: { steps: SopWaitingItem[]; tasks: WorkObject[] }) => waitingTodayItems(d.steps, d.tasks),
    })
    offs = EVENTS.map((t) => onServerEvent(t, onEvent))
  },
  deactivate() {
    for (const off of offs) off()
    offs = []
    clearTimeout(timer)
    timer = undefined
  },
})
