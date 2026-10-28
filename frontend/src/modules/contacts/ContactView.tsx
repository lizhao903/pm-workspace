// 联系人抽屉的查看态（SPEC-contacts-2 的资料部分）：列表点一行打开。
// 编辑、新建、头像、记一次联系、IM 身份和删除留给 CT-03b。
import type { ReactNode } from 'react'
import type { Contact } from '../../core/data'
import { Avatar, Drawer, Tag, Tags } from '../../core/ui'
import { ago, groupOf, type GroupItem } from './model'
import { GroupPill } from './parts'

export function ContactView({ contact, groups, star, onClose }: {
  /** null：地址里的联系人不在名册里（已删除或归档） */
  contact: Contact | null
  groups: GroupItem[]
  star: ReactNode
  onClose: () => void
}) {
  if (!contact) {
    return (
      <Drawer open onClose={onClose} kicker="联系人" aria-label="联系人">
        <div className="empty empty-compact">
          <div className="empty-title">这个联系人已删除</div>
          <div className="empty-desc">可能在别处被删掉或归档了</div>
        </div>
      </Drawer>
    )
  }
  const c = contact
  const sub = [c.title, c.company].filter(Boolean).join(' · ')
  const none = <span className="faint">未填写</span>
  return (
    <Drawer open onClose={onClose} kicker="联系人" aria-label={`联系人 ${c.name}`}>
      <div className="ct-head">
        <Avatar name={c.name} src={c.photo || undefined} size={52} />
        <div className="ct-head-text">
          <div className="ct-head-name"><span className="ellipsis">{c.name}</span>{star}</div>
          <div className="muted ellipsis">{sub || <span className="faint">未填写职位与公司</span>}</div>
        </div>
      </div>
      <dl className="ct-kv">
        <dt>分组</dt><dd><GroupPill items={groups} g={groupOf(c)} /></dd>
        <dt>电话</dt><dd className="ct-mono">{c.phone || none}</dd>
        <dt>邮箱</dt><dd>{c.email || none}</dd>
        <dt>标签</dt><dd>{c.tags.length ? <Tags>{c.tags.map((t) => <Tag key={t}>{t}</Tag>)}</Tags> : none}</dd>
        <dt>最近联系</dt><dd>{ago(c.last_contact_at) ?? <span className="faint">未联系</span>}</dd>
        <dt>添加于</dt><dd>{new Date(c.created_at).toLocaleDateString('zh-CN')}</dd>
      </dl>
      <div className="ct-note-title">备注</div>
      {c.note.trim()
        ? <div className="ct-note">{c.note.split('\n').map((p, i) => <p key={i}>{p}</p>)}</div>
        : <div className="faint">还没有备注</div>}
    </Drawer>
  )
}
