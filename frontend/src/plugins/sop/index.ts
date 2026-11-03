// SOP 编排插件（SOP-04b 起）：清单在后端 internal/plugins/sop/plugin.json，这里只有入口。
// 执行状态变化靠事件流：sop.run_status_changed、sop.step_status_changed 报 sop-run，一批事件合成一次刷新；停用插件时退订
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import { notifyChange, onServerEvent } from '../../core/data'

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
    // 设置 > 插件 > SOP 编排（SOP-07）：同时调模型的步骤数；运行页排队中的步骤带入口
    api.settings.register({
      key: 'sop',
      label: 'SOP 编排',
      desc: '同时调模型的步骤数',
      page: lazy(() => import('./Settings')),
    })
    // 任务详情里的「SOP 执行」（SOP-06）：关联到这条任务的执行和「执行 SOP」
    // 任务详情分了标签，这块单独一个「SOP」标签：名字后面是执行条数，有没结束的带状态点；地址带 ?sop_run= 时切过来并定位那次执行
    api.objectSections.register({
      key: 'sop-runs', typeIds: ['task'], order: 50, section: lazy(() => import('./ObjectRuns')),
      tab: { key: 'sop', label: 'SOP', badge: lazy(() => import('./ObjectRunsBadge')), focusParam: 'sop_run' },
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
