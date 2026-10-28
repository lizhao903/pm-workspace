import type { ModuleDef } from '../../core/plugin'

export const module: ModuleDef = {
  id: 'tasks',
  label: '任务',
  path: 'tasks',
  load: () => import('./Page'),
}
