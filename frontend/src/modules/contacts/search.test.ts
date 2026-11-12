// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Contact, Identity } from '../../core/data'
import { contactCommand, findContacts } from './search'

const c = (id: string, name: string, extra: Partial<Contact> = {}) =>
  ({ id, name, phone: '', email: '', company: '', title: '', ...extra }) as Contact
const idn = (stakeholder_id: string, external_id: string) => ({ stakeholder_id, channel: 'slack', external_id, display_name: '' }) as Identity

const list = [
  c('1', '李周七乐'),
  c('2', '周七', { company: 'ExampleCorp', title: 'PM' }),
  c('3', 'Randy', { phone: '137 2200 1234', email: 'randy@x.io' }),
  c('4', '王五'),
]

describe('findContacts', () => {
  it('姓名开头命中的排前面', () => {
    expect(findContacts(list, null, '周七').map((x) => x.id)).toEqual(['2', '1'])
  })

  it('按电话（忽略空格）、邮箱、IM 编号搜', () => {
    expect(findContacts(list, null, '13722').map((x) => x.id)).toEqual(['3'])
    expect(findContacts(list, null, 'RANDY@X').map((x) => x.id)).toEqual(['3'])
    expect(findContacts(list, [idn('4', 'U01ABC')], 'u01abc').map((x) => x.id)).toEqual(['4'])
  })

  it('多个词每个都要命中', () => {
    expect(findContacts(list, null, '周七 examplecorp').map((x) => x.id)).toEqual(['2'])
    expect(findContacts(list, null, '  ')).toEqual([])
  })

  it('回车去联系人页打开抽屉', () => {
    const to: string[] = []
    const cmd = contactCommand(list[1], 'contacts')
    expect(cmd).toMatchObject({ group: '联系人', title: '周七', sub: 'ExampleCorp · PM' })
    void cmd.run({ shell: { navigate: (x) => to.push(x) } })
    expect(to).toEqual(['/contacts?c=2'])
  })
})
