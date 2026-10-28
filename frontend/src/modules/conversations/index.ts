import type { ModuleDef } from '../../core/plugin'

export const module: ModuleDef = {
  id: 'conversations',
  label: '会话',
  path: 'conversations',
  load: () => import('./Page'),
}
