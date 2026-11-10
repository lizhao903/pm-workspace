// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 联系人抽屉的查看态（SPEC-contacts-2）：资料、快捷动作、IM 渠道、备注；底部编辑和删除。
// IM 渠道下面一行「自动忽略此人的全部消息」（IM 插件 0.27.0，TSK-0495，MuteRow），IM 插件没在跑时不显示。
// 删除前看负责、参与的事项数：有就拦下，给「改为归档」；名册只在零引用时允许删（回收站里的也算），后端 409 时同样改走归档。
import { useState, type ReactNode } from 'react'
import { errorText, isApiError, useDeleteContact, useUpdateContact, type Contact } from '../../core/data'
import { Avatar, Button, Drawer, IconButton, Tag, Tags, cls } from '../../core/ui'
import { IM_CHANNELS, ago, deleteBlock, groupsOf, type GroupItem } from './model'
import { CopyButton, GroupPills, ImMark, PhotoPicker } from './parts'
import { ContactMuteRow } from './MuteRow'

type Foot =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  /** 有引用，不能删，只能归档 */
  | { kind: 'blocked'; text: string }

function IconEdit() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

export function ContactView({ contact, groups, star, imCount, onEdit, onClose }: {
  /** null：地址里的联系人不在名册里（已删除或归档） */
  contact: Contact | null
  groups: GroupItem[]
  star: ReactNode
  /** 这个人有几个 IM 身份，删除确认里说会一起删 */
  imCount: number
  onEdit: () => void
  onClose: () => void
}) {
  const update = useUpdateContact()
  const del = useDeleteContact()
  const [foot, setFoot] = useState<Foot>({ kind: 'idle' })

  if (!contact) {
    return (
      <Drawer open onClose={onClose} kicker="联系人" aria-label="联系人"
        footer={<><div className="spacer" /><Button onClick={onClose}>关闭</Button></>}>
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
  const im = c.im ?? {}
  const busy = update.isPending || del.isPending

  const askDelete = () => {
    del.reset()
    const block = deleteBlock(c)
    setFoot(block ? { kind: 'blocked', text: block } : { kind: 'confirm' })
  }
  const doDelete = () => {
    del.mutate(c.id, {
      onSuccess: onClose,
      onError: (e) => {
        // 回收站里的事项也算引用，列表上的计数不含它们
        if (isApiError(e, 'conflict')) {
          setFoot({ kind: 'blocked', text: `「${c.name}」还被回收站里的事项引用着，不能删除。可以改为归档，或先清空回收站里的这些事项` })
        }
      },
    })
  }
  const archive = () => update.mutate({ id: c.id, patch: { archived: true } }, { onSuccess: onClose })

  const impact = imCount > 0 ? `删除后 ${imCount} 个 IM 身份一起删除，历史消息不动。` : ''
  const footer = foot.kind === 'confirm' ? (
    <div className="ct-foot-confirm">
      <span className="danger-text">确定删除「{c.name}」？{impact}</span>
      {del.isError && <span className="field-err" role="alert">没删成：{errorText(del.error)}</span>}
      <div className="ct-foot-btns">
        <Button onClick={() => setFoot({ kind: 'idle' })} disabled={busy}>取消</Button>
        <Button variant="danger" onClick={doDelete} disabled={busy}>{del.isPending ? '删除中' : '删除'}</Button>
      </div>
    </div>
  ) : foot.kind === 'blocked' ? (
    <div className="ct-foot-confirm" role="alert">
      <span className="ct-blocked">{foot.text}</span>
      {update.isError && <span className="field-err">没归档成：{errorText(update.error)}</span>}
      <div className="ct-foot-btns">
        <Button onClick={() => setFoot({ kind: 'idle' })} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={archive} disabled={busy}>{update.isPending ? '归档中' : '改为归档'}</Button>
      </div>
    </div>
  ) : (
    <>
      <Button variant="danger-ghost" onClick={askDelete}>删除</Button>
      <div className="spacer" />
      <Button variant="primary" onClick={onEdit}>编辑</Button>
    </>
  )

  return (
    <Drawer open onClose={onClose} kicker="联系人" aria-label={`联系人 ${c.name}`} footer={footer}
      headActions={<IconButton label="编辑" onClick={onEdit}><IconEdit /></IconButton>}>
      <div className="ct-head">
        <PhotoPicker photo={c.photo} onChange={(photo) => update.mutate({ id: c.id, patch: { photo } })}>
          <Avatar name={c.name} src={c.photo || undefined} size={52} />
        </PhotoPicker>
        <div className="ct-head-text">
          <div className="ct-head-name"><span className="ellipsis">{c.name}</span>{star}</div>
          <div className="muted ellipsis">{sub || <span className="faint">未填写职位与公司</span>}</div>
        </div>
      </div>
      <div className="ct-quick">
        <a className={cls('ct-quick-btn', !c.phone && 'disabled')} href={c.phone ? `tel:${c.phone.replace(/\s/g, '')}` : undefined}
          aria-disabled={!c.phone || undefined}>打电话</a>
        <a className={cls('ct-quick-btn', !c.email && 'disabled')} href={c.email ? `mailto:${c.email}` : undefined}
          aria-disabled={!c.email || undefined}>发邮件</a>
        <button type="button" className="ct-quick-btn" disabled={update.isPending}
          onClick={() => update.mutate({ id: c.id, patch: { last_contact_at: new Date().toISOString() } })}>记一次联系</button>
      </div>
      {update.isError && foot.kind !== 'blocked' && <div className="ct-err" role="alert">没改成：{errorText(update.error)}</div>}
      <dl className="ct-kv">
        <dt>分组</dt><dd><GroupPills items={groups} gs={groupsOf(c)} /></dd>
        <dt>电话</dt><dd>{c.phone ? <><span className="ct-mono">{c.phone}</span><CopyButton text={c.phone} label="电话" /></> : none}</dd>
        <dt>邮箱</dt><dd>{c.email ? <>{c.email}<CopyButton text={c.email} label="邮箱" /></> : none}</dd>
        <dt>标签</dt><dd>{c.tags.length ? <Tags>{c.tags.map((t) => <Tag key={t}>{t}</Tag>)}</Tags> : none}</dd>
        <dt>事项</dt>
        <dd>{c.owned_count || c.participating_count
          ? `负责 ${c.owned_count} · 参与 ${c.participating_count}` : <span className="faint">没有负责或参与的事</span>}</dd>
        <dt>最近联系</dt><dd>{ago(c.last_contact_at) ?? <span className="faint">未联系</span>}</dd>
        <dt>添加于</dt><dd>{new Date(c.created_at).toLocaleDateString('zh-CN')}</dd>
      </dl>
      {c.im !== undefined && (
        <>
          <div className="ct-note-title">IM 渠道</div>
          <div className="ct-im-list" role="list" aria-label="IM 渠道">
            {IM_CHANNELS.map((ch) => {
              const id = im[ch.key]
              return (
                <div key={ch.key} role="listitem" aria-label={ch.label} className={cls('ct-im-row', !id && 'is-empty')}>
                  <ImMark ch={ch} />
                  {id ? <span className="ct-mono ellipsis">{id}</span> : <span className="faint">未填写</span>}
                  <span className="spacer" />
                  {id && ch.link && <a className="ct-copy" href={ch.link(id)} target="_blank" rel="noreferrer">打开</a>}
                  {id && <CopyButton text={id} label={`${ch.label}编号`} />}
                </div>
              )
            })}
          </div>
          <ContactMuteRow id={c.id} name={c.name} />
        </>
      )}
      <div className="ct-note-title">备注</div>
      {c.note.trim()
        ? <div className="ct-note">{c.note.split('\n').map((p, i) => <p key={i}>{p}</p>)}</div>
        : <div className="faint">还没有备注</div>}
    </Drawer>
  )
}
