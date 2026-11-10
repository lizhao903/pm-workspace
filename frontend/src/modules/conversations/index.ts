// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { defineCoreModule } from '../../core/plugin'

// 内核模块：标 core，不能停用
export const module = defineCoreModule({
  id: 'conversations',
  label: '会话',
  path: 'conversations',
  load: () => import('./Page'),
})
