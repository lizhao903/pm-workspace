// 转项目资料（0009）：把这条消息（或合并显示的一组）按时间拼成一段对话记录，存成项目的一条笔记资料。
// 项目默认取消息归到的项目（含群组默认），能换；标题默认「<群或对方> <日期> 的消息」，能改；正文能预览和改，最多 5000 字。
// 可选「连附件一起加入资料」：走附件面板同一条路径（没获取的先获取，已在这个项目资料里的跳过）。
// 以前整组转过的先提示，能打开已有的，也能「再转一份」；只有一部分转过的提一句条数。
// 都加上了直接关掉；附件有没加上的、出处没记上的，留在弹窗里说清楚，笔记已经存了。
// 「存好后标为已处理」默认勾上（同回复框的「发送后标为已处理」）：笔记存上后把这些消息里还没处理的批量标为已处理；没标成的也留在弹窗里说。
import { useState } from 'react'
import {
  IM_NOTE_MAX, errorText, needsFetch, useImBatch, useImToMaterial, usePlugins, useProjects, type ImMessage, type ImToMaterialResult,
} from '../../core/data'
import { Checkbox, ConfirmDialog, Field, Input, SearchSelect, Textarea } from '../../core/ui'
import { isOpen } from './model'
import { attachmentsOf, materialBody, materialHint, materialTitle, priorMaterials, projectOf } from './toMaterialModel'

const PROJECTS_PLUGIN = 'projects'

export function ToMaterialDialog({ messages, chLabel, doneLabel = '已处理', onCancel, onDone, onOpenMaterial }: {
  /** 「已处理」在设置里的叫法 */
  doneLabel?: string
  /** 这条消息，或合并显示的一组 */
  messages: readonly ImMessage[]
  chLabel: string
  onCancel: () => void
  /** 存好了（附件都加上、出处也记上） */
  onDone: (projectId: string, materialId: string) => void
  onOpenMaterial: (projectId: string, materialId: string) => void
}) {
  const plugins = usePlugins()
  const projectsOn = plugins.isError || !!plugins.data?.find((p) => p.id === PROJECTS_PLUGIN)?.running
  const projects = useProjects()
  const save = useImToMaterial()
  const batch = useImBatch()
  const openIds = messages.filter(isOpen).map((m) => m.id)
  const [alsoDone, setAlsoDone] = useState(true)
  const [doneErr, setDoneErr] = useState<unknown>(null)
  const def = projectOf(messages)
  const [pid, setPid] = useState(def?.id ?? '')
  const [title, setTitle] = useState(() => materialTitle(messages))
  const auto = materialBody(messages, chLabel)
  const [edited, setEdited] = useState<string | null>(null)
  const body = edited ?? auto
  const atts = attachmentsOf(messages)
  const [withAtts, setWithAtts] = useState(false)
  const [result, setResult] = useState<ImToMaterialResult | null>(null)
  const prior = priorMaterials(messages)
  const many = messages.length > 1

  const live = (projects.data?.data ?? []).filter((p) => !p.deleted_at)
  const options = live.map((p) => ({ value: p.id, label: p.title, hint: p.id === def?.id ? '消息归到的项目' : undefined }))
  const len = Array.from(body.trim()).length
  const over = len > IM_NOTE_MAX
  const restore = edited !== null && <>{'；'}<button type="button" className="link-btn" onClick={() => setEdited(null)}>恢复默认</button></>
  const ok = projectsOn && !!pid && live.some((p) => p.id === pid) && !!title.trim() && !!body.trim() && !over

  if (result) {
    const r = result
    return (
      <ConfirmDialog open title="转项目资料" confirmLabel="去看资料" cancelLabel="关闭"
        onConfirm={() => onOpenMaterial(r.material.project_id, r.material.id)} onCancel={() => onDone(r.material.project_id, r.material.id)}>
        <div className="im-start">
          <div>笔记「{r.material.name}」已经存进项目资料。</div>
          {r.attachments.added.length > 0 && <div className="im-muted">一起加上的附件：{r.attachments.added.join('、')}</div>}
          {r.attachments.skipped.length > 0 && <div className="im-muted">本来就在这个项目资料里，跳过：{r.attachments.skipped.join('、')}</div>}
          {r.attachments.failed.map((f) => <div key={f.name} className="im-err" role="alert">附件「{f.name}」没加上：{errorText(f.error)}</div>)}
          {r.linkError !== null && <div className="im-err" role="alert">出处没记上（资料页看不到「来自 IM 消息」，消息上也不标已转）：{errorText(r.linkError)}</div>}
          {doneErr !== null && <div className="im-err" role="alert">没标成{doneLabel}，回列表里手动标：{errorText(doneErr)}</div>}
        </div>
      </ConfirmDialog>
    )
  }

  const submit = () => {
    if (!ok || save.isPending) return
    save.mutate({
      messages, projectId: pid, title, body,
      attachments: withAtts ? atts.map((x) => ({ messageId: x.messageId, attachmentId: x.attachment.id })) : [],
    }, {
      onSuccess: (r) => {
        const finish = (err: unknown) => {
          setDoneErr(err)
          if (err === null && r.linkError === null && !r.attachments.failed.length) onDone(r.material.project_id, r.material.id)
          else setResult(r)
        }
        // 笔记存上了才标；没处理的才标（已处理、已忽略的不动）
        if (alsoDone && openIds.length) batch.mutate({ action: 'done', ids: openIds }, { onSuccess: () => finish(null), onError: (e) => finish(e) })
        else finish(null)
      },
    })
  }

  return (
    <ConfirmDialog open title="转项目资料" busy={save.isPending || batch.isPending || !ok}
      confirmLabel={save.isPending || batch.isPending ? '正在存…' : prior.same.length ? '再转一份' : '存成资料'}
      onConfirm={submit} onCancel={onCancel}>
      <div className="im-start im-to-material">
        {prior.same.length > 0 && (
          <div className="im-banner-warn" role="status">
            <div>{many ? '这组消息' : '这条消息'}已经转过资料：</div>
            {prior.same.map((r) => (
              <div key={r.material_id} className="im-act-row">
                <span className="ellipsis">{materialHint(r)}</span>
                <button type="button" className="link-btn" onClick={() => onOpenMaterial(r.project_id, r.material_id)}>打开已有的</button>
              </div>
            ))}
            <div className="im-muted">要再存一份就点「再转一份」</div>
          </div>
        )}
        {!prior.same.length && prior.partial > 0 && (
          <div className="im-muted">其中 {prior.partial} 条已经转进过别的资料</div>
        )}
        {!projectsOn && <div className="im-banner-warn">项目插件没在运行，存不了资料；先到「设置 / 插件」里启用</div>}
        <Field label="存到哪个项目" wrap={false} hint={def ? (pid === def.id ? '默认是消息归到的项目' : undefined) : '消息没归项目，挑一个'}>
          <SearchSelect variant="field" value={pid} options={options} placeholder="选项目" searchPlaceholder="搜项目" aria-label="存到哪个项目"
            disabled={!projectsOn} missingLabel={() => '已删除的项目'}
            emptyText={projects.isError ? '项目没加载出来' : projects.isPending ? '加载中' : '还没有项目'}
            onChange={(v) => setPid(v)} />
        </Field>
        <Field label="标题">
          <Input value={title} aria-label="标题" maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={`正文（${many ? `${messages.length} 条消息` : '这条消息'}，按时间拼成一段对话记录）`} wrap={false}
          error={over ? <>超过 {IM_NOTE_MAX} 字（现在 {len} 字），删掉一些，或分几次转{restore}</> : undefined}
          hint={<>{len} / {IM_NOTE_MAX} 字，存成项目资料里的笔记，能改{restore}</>}>
          <Textarea rows={10} value={body} aria-label="正文" invalid={over} onChange={(e) => setEdited(e.target.value)} />
        </Field>
        {atts.length > 0 && (
          <div className="im-to-mat-atts">
            <Checkbox checked={withAtts} disabled={!projectsOn} onCheckedChange={setWithAtts}>连附件一起加入资料（{atts.length} 个）</Checkbox>
            {withAtts && (
              <ul className="im-muted">
                {atts.map(({ messageId, attachment: a }) => (
                  <li key={`${messageId}:${a.id}`}>
                    {a.name}
                    {' · '}
                    {a.kind === 'link' ? '链接' : a.fetch === 'done' ? '已获取' : a.fetch === 'error' ? `上次没取到（${a.error || '获取失败'}），会再试一次` : '还没获取，会先获取到本地'}
                  </li>
                ))}
              </ul>
            )}
            {withAtts && atts.some((x) => needsFetch(x.attachment)) && (
              <div className="im-muted">取不到的附件不加，笔记照样存；已经在这个项目资料里的跳过</div>
            )}
          </div>
        )}
        {openIds.length > 0 && (
          <Checkbox checked={alsoDone} onCheckedChange={setAlsoDone}>
            存好后标为{doneLabel}{many && openIds.length < messages.length ? `（还没处理的 ${openIds.length} 条）` : ''}
          </Checkbox>
        )}
        {save.isError && <div className="im-err" role="alert">没存上：{errorText(save.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}
