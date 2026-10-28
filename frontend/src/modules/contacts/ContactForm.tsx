// 联系人抽屉的表单态（SPEC-contacts-3）：新建和编辑共用，含 IM 身份编辑。
// 资料先存，再按渠道比出身份的增删改；撞名 409 要求加区分（CT-01a），编号已属于别人时先提示，存不上的渠道列在底部。
import { useState, type KeyboardEvent } from 'react'
import {
  errorText, identityOwner, isApiError, useSaveContact, type Contact, type ContactSaved, type Identity,
} from '../../core/data'
import { Avatar, Button, Drawer, Field, Input, SearchSelect, Tag, Textarea, cls } from '../../core/ui'
import {
  IM_CHANNELS, SEG_MAX, dupNameText, groupOptions, validate, type Draft, type GroupItem,
} from './model'
import { ImMark, PhotoPicker } from './parts'

export function ContactForm({ contact, initial, groups, identities, nameOf, onSaved, onCancel, onClose }: {
  /** null 是新建 */
  contact: Contact | null
  initial: Draft
  groups: GroupItem[]
  /** 全部身份：查编号被谁占用、比出这个人要改的身份 */
  identities: Identity[] | undefined
  nameOf: (stakeholderId: string) => string
  /** 存好了（含部分身份没存上）；failed 非空时调用方留在表单 */
  onSaved: (r: ContactSaved) => void
  /** 编辑时回到查看态；新建时关抽屉 */
  onCancel: () => void
  onClose: () => void
}) {
  const creating = !contact
  const save = useSaveContact()
  const [draft, setDraft] = useState<Draft>(initial)
  const [tagInput, setTagInput] = useState('')
  const [tried, setTried] = useState(false)
  // 已经存上的联系人（新建后身份有没存上的，再点保存就是编辑它）
  const [savedId, setSavedId] = useState<string | null>(contact?.id ?? null)
  const [failText, setFailText] = useState<string[]>([])

  const errors = validate(draft)
  const invalid = !!(errors.name || errors.email)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || !!tagInput.trim()
  const mine = (identities ?? []).filter((i) => i.stakeholder_id === savedId)

  const addTag = () => {
    const t = tagInput.trim()
    if (t && !draft.tags.includes(t)) set('tags', [...draft.tags, t])
    setTagInput('')
  }

  const submit = () => {
    setTried(true)
    if (invalid || save.isPending) return
    // 还在输入框里没回车的标签也算上
    const t = tagInput.trim()
    const tags = t && !draft.tags.includes(t) ? [...draft.tags, t] : draft.tags
    setTagInput('')
    const im = Object.fromEntries(Object.entries(draft.im).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
    const fields = {
      name: draft.name.trim(), company: draft.company.trim(), title: draft.title.trim(), phone: draft.phone.trim(),
      email: draft.email.trim(), group: draft.group, tags, photo: draft.photo, note: draft.note,
    }
    setFailText([])
    save.mutate({ id: savedId ?? undefined, fields, im, before: mine }, {
      onSuccess: (r) => {
        setSavedId(r.contact.id)
        if (r.failed.length) {
          setFailText(r.failed.map((f) => {
            const ch = IM_CHANNELS.find((x) => x.key === f.channel)?.label ?? f.channel
            const owner = f.external_id ? identityOwner(identities, f.channel, f.external_id) : undefined
            if (isApiError(f.error, 'conflict') && owner && owner.stakeholder_id !== r.contact.id) {
              return `${ch}编号 ${f.external_id} 已经是 ${nameOf(owner.stakeholder_id)} 的，没有存上`
            }
            return `${ch}没存上：${errorText(f.error)}`
          }))
        }
        onSaved(r)
      },
    })
  }
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  const saveErr = save.error
    ? isApiError(save.error, 'conflict') ? dupNameText(draft.name.trim()) : `没保存成：${errorText(save.error)}`
    : ''
  const opts = groupOptions(groups, draft.group)
  const text = (k: 'name' | 'company' | 'title' | 'phone' | 'email', label: string, ph: string, req = false) => {
    const err = tried && (k === 'name' || k === 'email') ? errors[k] : ''
    return (
      <Field label={label} required={req} error={err || undefined}>
        <Input value={draft[k]} placeholder={ph} autoFocus={k === 'name'} invalid={!!err}
          type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'}
          onChange={(e) => set(k, e.target.value)} onKeyDown={onEnter} />
      </Field>
    )
  }

  return (
    <Drawer open onClose={onClose} kicker={creating ? '新建联系人' : '编辑联系人'} aria-label={creating ? '新建联系人' : `编辑联系人 ${contact.name}`}
      dirty={dirty} dirtyMessage="关闭后，这次填写的联系人资料不会保存。"
      footer={
        <div className="ct-foot-form">
          {(saveErr || failText.length > 0) && (
            <div className="field-err" role="alert">
              {saveErr && <div>{saveErr}</div>}
              {failText.map((t) => <div key={t}>{t}</div>)}
            </div>
          )}
          <div className="ct-foot-btns">
            <Button onClick={onCancel} disabled={save.isPending}>取消</Button>
            <div className="spacer" />
            <Button variant="primary" onClick={submit} disabled={save.isPending}>
              {save.isPending ? '保存中' : creating && !savedId ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      }>
      <div className="form ct-form">
        <div className="ct-name-row">
          <PhotoPicker photo={draft.photo} onChange={(photo) => set('photo', photo)}>
            <Avatar name={draft.name.trim() || '新'} src={draft.photo || undefined} size={48} />
          </PhotoPicker>
          {text('name', '姓名', '例如 许知行', true)}
        </div>
        <div className="field-row">
          {text('company', '公司', '所在单位')}
          {text('title', '职位', '例如 IT 总监')}
        </div>
        <Field label="分组" wrap={false}>
          {opts.length > SEG_MAX + 1 ? (
            <SearchSelect variant="field" value={draft.group} searchPlaceholder="搜分组" aria-label="分组"
              options={opts.map((g) => ({ value: g.key, label: g.label, hint: g.enabled ? undefined : '已停用' }))}
              onChange={(v) => { if (v) set('group', v) }} />
          ) : (
            <div className="seg seg-full ct-seg" role="group" aria-label="分组">
              {opts.map((g) => (
                <button key={g.key} type="button" className={cls(draft.group === g.key && 'on')} aria-pressed={draft.group === g.key}
                  title={g.enabled ? undefined : '已停用'} onClick={() => set('group', g.key)}>{g.label}</button>
              ))}
            </div>
          )}
        </Field>
        <div className="field-row">
          {text('phone', '电话', '手机或座机')}
          {text('email', '邮箱', 'name@company.com')}
        </div>
        <Field label={<>IM 渠道<span className="field-hint">填各渠道上能搜到这个人的编号，没有的留空</span></>} wrap={false}>
          <div className="ct-im-form">
            {IM_CHANNELS.map((ch) => {
              const v = draft.im[ch.key] ?? ''
              const owner = identityOwner(identities, ch.key, v)
              const taken = owner && owner.stakeholder_id !== savedId ? nameOf(owner.stakeholder_id) : ''
              return (
                <div key={ch.key} className="ct-im-form-item">
                  <label className="ct-im-form-row">
                    <ImMark ch={ch} />
                    <Input value={v} placeholder={ch.hint} aria-label={`${ch.label}编号`} className="ct-mono-input"
                      onChange={(e) => set('im', { ...draft.im, [ch.key]: e.target.value })} onKeyDown={onEnter} />
                  </label>
                  {taken && <span className="ct-im-taken">这个编号已经是 {taken} 的</span>}
                </div>
              )
            })}
          </div>
        </Field>
        <Field label="标签" wrap={false}>
          <div className="ct-tag-input">
            {draft.tags.map((t) => (
              <Tag key={t} removeLabel={`移除标签 ${t}`} onRemove={() => set('tags', draft.tags.filter((x) => x !== t))}>{t}</Tag>
            ))}
            <input value={tagInput} aria-label="添加标签" placeholder={draft.tags.length ? '' : '输入后回车添加'}
              onChange={(e) => setTagInput(e.target.value)} onBlur={addTag}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTag() }
                if (e.key === 'Backspace' && !tagInput && draft.tags.length) set('tags', draft.tags.slice(0, -1))
              }} />
          </div>
        </Field>
        <Field label="备注">
          <Textarea rows={5} value={draft.note} placeholder="怎么认识的、关心什么、下次聊什么" onChange={(e) => set('note', e.target.value)} />
        </Field>
      </div>
    </Drawer>
  )
}
