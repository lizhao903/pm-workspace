import { defineCoreModule } from '../../core/plugin'

// 内核模块：标 core，不能停用
export const module = defineCoreModule({
  id: 'today',
  label: '今日',
  path: 'today',
  load: () => import('./Page'),
})
