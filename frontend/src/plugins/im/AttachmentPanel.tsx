// 消息抽屉里的附件面板（SPEC-messages-3，IM-04b）：文件、图片获取到本地，挑项目加进支持材料；链接不用获取，直接能加。
// 照原型 web-next/src/attachments.tsx AttachmentPanel。项目和资料经 core/data 读（不 import 项目插件）；项目插件没在跑时只能获取，不能加。
import { useState } from 'react'
import {
  ATTACH_KIND, attachmentAdded, attachmentHref, errorText, needsFetch, useAddAttachmentToProject, useAttachmentTargets, useFetchAttachment,
  usePlugins, type AttachmentTargets, type ImAttachmentFile, type ImMessage,
} from '../../core/data'
import { SearchSelect, cls } from '../../core/ui'
import { fmtSize } from './model'

const PROJECTS_PLUGIN = 'projects'

export function AttIcon({ kind }: { kind: ImAttachmentFile['kind'] }) {
  const d = kind === 'link' ? 'M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'
    : kind === 'image' ? 'M3 3.5h10v9H3zM3 10.5l3-3 2.5 2.5L10 8.5l3 3' : 'M4 2.5h5l3 3v8H4zM9 2.5v3h3'
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** 状态行（SPEC-messages-3.2）：链接显示地址；已获取「已获取 · 本地路径」；获取中；失败原因；还没获取 */
function statusLine(a: ImAttachmentFile, fetching: boolean, localErr: string) {
  if (a.kind === 'link') return a.url ?? ''
  if (fetching) return '获取中…'
  if (a.fetch === 'done') return `已获取 · ${a.local ?? ''}`
  if (a.fetch === 'error') return a.error || '获取失败'
  if (localErr) return localErr
  return [ATTACH_KIND[a.kind] ?? a.kind, fmtSize(a.size), '还在平台上，没下载'].filter(Boolean).join(' · ')
}

export function AttachmentPanel({ msg }: { msg: ImMessage }) {
  const plugins = usePlugins()
  // 插件列表读不出来时照样去取，接口 404 再当没有
  const projectsOn = plugins.isError || !!plugins.data?.find((p) => p.id === PROJECTS_PLUGIN)?.running
  const atts = msg.attachments as ImAttachmentFile[]
  const targets = useAttachmentTargets(msg.conversation_id, projectsOn && atts.length > 0)
  const [pick, setPick] = useState<Record<string, string>>({})
  if (!atts.length) return null
  return (
    <>
      <div className="im-section">附件 {atts.length}</div>
      <div className="im-att-list">
        {atts.map((a) => (
          <AttachmentRow key={a.id} msg={msg} a={a} t={targets} projectsOn={projectsOn}
            pick={pick[a.id]} onPick={(v) => setPick({ ...pick, [a.id]: v })} />
        ))}
      </div>
    </>
  )
}

function AttachmentRow({ msg, a, t, projectsOn, pick, onPick }: {
  msg: ImMessage; a: ImAttachmentFile; t: AttachmentTargets; projectsOn: boolean; pick: string | undefined; onPick: (v: string) => void
}) {
  const fetchM = useFetchAttachment()
  const addM = useAddAttachmentToProject()
  const inP = t.projects.filter((p) => attachmentAdded(t.materials.get(p.id), a))
  const isIn = (id: string) => inP.some((p) => p.id === id)
  // 默认选消息所在的第一个项目；已经加进那个项目时改选第一个还没加过的；都没有就空着（SPEC-messages-3.7）
  const def = t.suggested[0] ?? ''
  const target = pick ?? (def && isIn(def) ? t.projects.find((p) => !isIn(p.id))?.id ?? '' : def)
  const fetching = fetchM.isPending || (addM.isPending && needsFetch(a))
  const busy = fetching || addM.isPending
  const canAdd = !!target && !isIn(target) && t.projects.some((p) => p.id === target)
  const localErr = fetchM.isError && a.fetch !== 'error' ? errorText(fetchM.error) : ''
  const addErr = addM.isError && a.fetch !== 'error' ? errorText(addM.error) : ''
  const href = attachmentHref(a)

  const doFetch = () => { addM.reset(); fetchM.mutate({ messageId: msg.id, attachmentId: a.id }) }
  const doAdd = () => { fetchM.reset(); addM.mutate({ message: msg, attachmentId: a.id, projectId: target }) }

  const options = [
    ...t.projects.filter((p) => t.suggested.includes(p.id))
      .map((p) => ({ value: p.id, label: p.name, group: '这条消息所在的项目', hint: isIn(p.id) ? '已加入' : undefined })),
    ...t.projects.filter((p) => !t.suggested.includes(p.id))
      .map((p) => ({ value: p.id, label: p.name, group: t.suggested.length ? '其他项目' : '项目', hint: isIn(p.id) ? '已加入' : undefined })),
  ]

  return (
    <div className={cls('im-att-row', (a.fetch === 'error' || localErr) && !fetching && 'im-att-bad')}>
      <span className={cls('im-att-ico', `im-att-${a.kind}`)}><AttIcon kind={a.kind} /></span>
      <span className="im-att-main">
        {a.kind === 'link' && href
          ? <a className="im-att-name ellipsis" href={href} target="_blank" rel="noopener noreferrer">{a.name}</a>
          : <b className="im-att-name ellipsis">{a.name}</b>}
        <span className="im-att-sub ellipsis" title={statusLine(a, fetching, localErr)}>{statusLine(a, fetching, localErr)}</span>
      </span>
      <span className="im-att-acts">
        {a.kind !== 'link' && a.fetch === 'done' && href && (
          <a className="im-act im-act-quiet" href={href} download={a.name} title="从附件目录读出来，下载到浏览器">打开</a>
        )}
        {needsFetch(a) && (
          <button type="button" className="im-act" disabled={busy} onClick={doFetch}>
            {fetching ? '获取中' : a.fetch === 'error' ? '重试' : '获取'}
          </button>
        )}
        <SearchSelect className="im-att-proj" value={target} onChange={onPick} placeholder="选项目" searchPlaceholder="搜项目" active={false}
          aria-label="加进哪个项目的支持材料" title={projectsOn ? '加进哪个项目的支持材料' : '需要项目插件'} align="end"
          disabled={!projectsOn} missingLabel={() => '已删除的项目'} emptyText={projectsOn ? '还没有项目' : '项目插件没在运行'} options={options} />
        <button type="button" className="im-act im-act-primary" disabled={!canAdd || busy} onClick={doAdd}
          title={needsFetch(a) ? '会先获取到本地再加入' : undefined}>
          {needsFetch(a) ? '获取并加入' : '加入资料'}
        </button>
      </span>
      {inP.length > 0 && <span className="im-att-in">已在 {inP.map((p) => p.name).join('、')} 的支持材料里</span>}
      {addErr && <span className="im-att-in im-err" role="alert">没加进去：{addErr}</span>}
    </div>
  )
}
