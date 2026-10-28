import type { ModuleDef } from '../../core/plugin'

export const module: ModuleDef = {
  id: 'today',
  label: '今日',
  path: 'today',
  load: () => import('./Page'),
}
