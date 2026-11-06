// 群组管理「成员」菜单的「全部加为联系人」（IM 0.30.0，TSK-0724，SPEC-messages-9.13 起）：
// 先列名单确认（这个会话里发过言、没认上联系人的真人，排除机器人和自己），可去掉某人、改名字；分组、公司对这批统一生效。
// 逐个建联系人并挂上渠道身份（同消息抽屉的「新建联系人」，useCreateContactLinked），某个人失败不拦别的，失败的留在名单里写原因。
import { useMemo, useState } from 'react'
import {
  DEFAULT_CONTACT_GROUP, contactGroupOptions, errorText, useConnectors, useCreateContactLinked, useDictionaries,
  type ImConversationSummary, type ImMember,
} from '../../core/data'
import { ConfirmDialog, Field, Input, Select } from '../../core/ui'
import { memberName } from './historyModel'
import { clip100 } from './model'

type Row = { m: ImMember; name: string; on: boolean; error?: string }

export function BatchContactDialog({ s, chLabel, members, onClose, onDone }: {
  s: ImConversationSummary
  chLabel: string
  /** 候选（contactCandidates 筛过的），打开时定下来，建的过程中列表刷新不影响 */
  members: ImMember[]
  onClose: () => void
  onDone: (text: string) => void
}) {
  const create = useCreateContactLinked()
  const dicts = useDictionaries({ withItems: true })
  const connectors = useConnectors()
  const [rows, setRows] = useState<Row[]>(() => members.map((m) => ({ m, name: memberName(m), on: true })))
  const [company, setCompany] = useState('')
  const groups = useMemo(() => contactGroupOptions(dicts.data), [dicts.data])
  const [group, setGroup] = useState('')
  const groupValue = group || (groups.some((g) => g.value === DEFAULT_CONTACT_GROUP) ? DEFAULT_CONTACT_GROUP : groups[0]?.value ?? '')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [created, setCreated] = useState<string[]>([])
  const picked = rows.filter((r) => r.on && r.name.trim())
  const account = clip100(connectors.data?.find((c) => c.id === s.connector_id)?.account ?? '')
  const busy = progress !== null

  const patch = (ext: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.m.external_id === ext ? { ...r, ...p } : r)))

  const confirm = async () => {
    if (busy || !picked.length) return
    const todo = picked
    setProgress({ done: 0, total: todo.length })
    const ok: string[] = []
    const failed = new Map<string, string>()
    for (const [i, r] of todo.entries()) {
      try {
        const res = await create.mutateAsync({
          fields: { name: r.name.trim(), company: company.trim(), group: groupValue },
          identity: { channel: s.channel, external_id: r.m.external_id, display_name: clip100(r.m.sender_name), account },
        })
        if (res.identity) ok.push(res.contact.name)
        else failed.set(r.m.external_id, `联系人建好了，${chLabel}编号没挂上：${errorText(res.error)}（到联系人页手动加 IM 身份）`)
      } catch (e) {
        failed.set(r.m.external_id, errorText(e))
      }
      setProgress({ done: i + 1, total: todo.length })
    }
    setProgress(null)
    const all = [...created, ...ok]
    setCreated(all)
    if (!failed.size) {
      onDone(`已加为联系人 ${all.length} 个：${all.slice(0, 3).join('、')}${all.length > 3 ? ' 等' : ''}；他们在${chLabel}的消息都会显示为联系人名`)
      return
    }
    // 建成的从名单里去掉，失败的留着写原因，可改了名字再点
    const done = new Set(todo.filter((r) => !failed.has(r.m.external_id)).map((r) => r.m.external_id))
    setRows((rs) => rs.filter((r) => !done.has(r.m.external_id)).map((r) => ({ ...r, error: failed.get(r.m.external_id) })))
  }

  const label = progress ? `建立中 ${progress.done}/${progress.total}…` : picked.length ? `加为联系人 ${picked.length} 个` : '加为联系人'
  return (
    <ConfirmDialog open title="全部加为联系人" confirmLabel={label} busy={busy || !picked.length} onConfirm={() => void confirm()}
      onCancel={() => { if (created.length) onDone(`已加为联系人 ${created.length} 个，${rows.length} 个没加上`); else onClose() }}>
      <div className="im-link">
        <div className="im-muted">
          把这个会话里还没认上联系人的人建成联系人，并挂上他们的{chLabel}身份，以前和以后的消息都会显示为联系人名。机器人和你自己不在名单里。
        </div>
        {created.length > 0 && <div className="im-link-note" role="status">已加上 {created.length} 个：{created.join('、')}</div>}
        <div className="im-bc-list" role="list" aria-label="要加的人">
          {rows.map((r) => (
            <div key={r.m.external_id} role="listitem" className="im-bc-row" aria-label={memberName(r.m)}>
              <input type="checkbox" checked={r.on} disabled={busy} aria-label={`加 ${memberName(r.m)}`} onChange={(e) => patch(r.m.external_id, { on: e.target.checked })} />
              <div className="im-bc-main">
                <Input value={r.name} disabled={busy || !r.on} aria-label={`${memberName(r.m)} 的姓名`} invalid={r.on && !r.name.trim()}
                  onChange={(e) => patch(r.m.external_id, { name: e.target.value })} />
                <span className="im-muted im-bc-ext" title={`${chLabel} · ${r.m.external_id}`}>{chLabel} · <span className="im-mono">{r.m.external_id}</span></span>
                {r.error && <span className="im-err">{r.error}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="im-bc-fields">
          <Field label="分组">
            <Select value={groupValue} options={groups} disabled={busy} onValueChange={setGroup} />
          </Field>
          <Field label="公司">
            <Input value={company} placeholder="选填，这批都填上" disabled={busy} onChange={(e) => setCompany(e.target.value)} />
          </Field>
        </div>
        <div className="im-muted">电话、邮箱这些建好后到联系人页补全；同名的联系人已存在时这个人会失败，改个名字再点，或在成员菜单里单个「关联到已有联系人」</div>
      </div>
    </ConfirmDialog>
  )
}
