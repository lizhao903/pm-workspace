// SOP 编排插件（SOP-04b 起）：清单在后端 internal/plugins/sop/plugin.json，这里只有入口。
// 执行状态变化靠事件流：sop.run_status_changed、sop.step_status_changed 报 sop-run，一批事件合成一次刷新；停用插件时退订
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
    offs = EVENTS.map((t) => onServerEvent(t, onEvent))
  },
  deactivate() {
    for (const off of offs) off()
    offs = []
    clearTimeout(timer)
    timer = undefined
  },
})
