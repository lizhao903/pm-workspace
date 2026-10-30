import { lazy } from 'react'
import { defineCoreModule, registerCoreObjectDrawer, registerCoreSearch } from '../../core/plugin'
import { searchTasks } from './search'

// 内核模块：标 core，不能停用
export const module = defineCoreModule({
  id: 'tasks',
  label: '任务',
  path: 'tasks',
  load: () => import('./Page'),
})

// 给别的模块用的公开入口（今日页打开任务抽屉、待验收确认）。按需加载，样式跟着一起来，不拖大首屏
const withStyles = () => import('./tasks.css')
export const TaskDrawer = lazy(() => Promise.all([import('./TaskDrawer'), withStyles()]).then(([m]) => ({ default: m.TaskDrawer })))
export const ApproveDialog = lazy(() => Promise.all([import('./ApproveDialog'), withStyles()]).then(([m]) => ({ default: m.ApproveDialog })))
export { REVIEW, doneKey, dueDay, priorityRank, terminalOf, timeAgo } from './model'
// 运行异常页的「自动巡检」写定时规则（INC-01b）
export { describeRule, fullRule } from './scheduleModel'

// 插件打开任务抽屉（PJ-01d）：登记到 core/plugin 的「打开对象」，插件按类型拿，不 import 这里
const objectDrawer = () => import('./ObjectDrawer')
registerCoreObjectDrawer({
  typeId: 'task',
  drawer: lazy(objectDrawer),
  approve: lazy(() => objectDrawer().then((m) => ({ default: m.ObjectApprove }))),
})

// 命令面板搜任务（A-01）：编号、标题、正文，回车打开抽屉
registerCoreSearch('tasks', (q) => searchTasks(q, module.path))
