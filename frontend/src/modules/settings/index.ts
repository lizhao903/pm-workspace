import type { ModuleDef } from '../../core/plugin'

export const module: ModuleDef = {
  id: 'settings',
  label: '设置',
  path: 'settings',
  load: () => import('./Page'),
}
