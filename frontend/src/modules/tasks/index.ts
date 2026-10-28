import { defineCoreModule } from '../../core/plugin'

// 内核模块：标 core，不能停用
export const module = defineCoreModule({
  id: 'tasks',
  label: '任务',
  path: 'tasks',
  load: () => import('./Page'),
})
