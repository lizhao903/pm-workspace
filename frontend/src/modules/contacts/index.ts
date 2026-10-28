import type { ModuleDef } from '../../core/plugin'

export const module: ModuleDef = {
  id: 'contacts',
  label: '联系人',
  path: 'contacts',
  load: () => import('./Page'),
}
