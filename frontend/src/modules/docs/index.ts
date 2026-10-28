import type { ModuleDef } from '../../core/plugin'

export const module: ModuleDef = {
  id: 'docs',
  label: '文档',
  path: 'docs',
  load: () => import('./Page'),
}
