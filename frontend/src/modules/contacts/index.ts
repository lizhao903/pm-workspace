import { defineCoreModule, registerCoreSearch } from '../../core/plugin'
import { searchContacts } from './search'

// 内核模块：标 core，不能停用
export const module = defineCoreModule({
  id: 'contacts',
  label: '联系人',
  path: 'contacts',
  load: () => import('./Page'),
})

// 命令面板搜联系人（A-01）：姓名、电话、邮箱、IM 编号，回车打开抽屉
registerCoreSearch('contacts', (q) => searchContacts(q, module.path))
