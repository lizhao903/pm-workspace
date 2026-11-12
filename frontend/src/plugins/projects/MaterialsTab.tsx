// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 支持材料标签（SPEC-projects-11，PJ-03b）：文件、文件夹、链接、笔记，按种类、标签筛选。
// 数据走项目插件的 /api/projects/{id}/materials，只存路径和元信息，不读文件内容。
// 原型用浏览器的选择器只拿得到名字；这里文件夹走后端选目录拿绝对路径，文件是「选目录 + 浏览器给的文件名」拼出绝对路径，
// 相对路径按项目目录补全后再存。项目文档仍在「文档」标签，合并成「项目资料」等原型定（PROTO-10 的 P-2）。
// 来自 IM 消息的资料（0009：消息转成的笔记、附件加进的）卡片上标出处，点了打开那条消息（SPEC-projects-11.16）；
// 出处由 IM 插件记（GET /api/im/materials?project_id=），IM 插件没在跑时不标。移除这种资料时一并清掉出处。
// 地址带 ?mt=<资料 id>（从消息上「已转资料」、附件标签「已加入资料」跳过来）时高亮那一条并滚到它。
// 卡片上「编辑」就地展开表单（同原型卡片的「修改」）：名称、内容、标签都能改，笔记和链接、文件和文件夹之间能换种类（项目插件 0.9.1）；
// 来自消息附件的资料种类和路径不能改（附件标签按值认已加入），来自 IM 消息的笔记改了出处照样在（出处按资料 id 记）。
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  MATERIAL_KINDS, MATERIAL_NOTE_MAX, errorText, useAddProjectMaterials, useImMaterialSources, usePatchProjectMaterial, usePlugins, useProjectMaterials, useRemoveProjectMaterial, useUnlinkImMaterial,
  useWorkdirCheck, type ImMaterialSource, type MaterialKind, type ProjectMaterial, type ProjectMaterialInput,
} from '../../core/data'
import { Button, EmptyState, ErrorState, Field, IconButton, IconClose, IconSearch, Input, LoadingState, Textarea, cls } from '../../core/ui'
import { ago } from './model'
import {
  DEFAULT_DIR, allTags, dirOf, editDraftOf, editPatch, foldNote, isPathKind, joinPath, matchMaterial, newestFirst, noteLength, resolvePath, sourceLabel, sourceMessage,
  splitTags, switchableKinds, type EditDraft,
} from './materialModel'
import { PathInput } from './PathInput'
import { ProjectKbStrip } from './ProjectKb'

const kindLabel = (k: MaterialKind) => MATERIAL_KINDS.find((x) => x.key === k)?.label ?? k
const lastSeg = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? ''
/** 没填路径时选文件放在这里，提示里显示 */
const defaultDir = (root: string) => (root ? `${root}/${DEFAULT_DIR}` : DEFAULT_DIR)
const NEED_ABS = '没设项目目录，路径要填绝对路径（以 / 开头），或先在设置里填本地项目目录'
const IM_PLUGIN = 'im'
const MESSAGES_PATH = '/messages'

type Draft = { kind: MaterialKind; name: string; value: string; tags: string }
const EMPTY: Draft = { kind: 'file', name: '', value: '', tags: '' }

export function MaterialsTab({ projectId, root, adding, onAdding, onSettings }: {
  projectId: string
  /** 项目目录，相对路径按它补全 */
  root: string
  /** 加材料的内联表单开着没有；右上「加材料」打开 */
  adding: boolean
  onAdding: (on: boolean) => void
  /** 去项目设置（项目知识库入口条用，TSK-0721） */
  onSettings?: () => void
}) {
  const list = useProjectMaterials(projectId)
  const add = useAddProjectMaterials(projectId)
  const remove = useRemoveProjectMaterial(projectId)
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const hit = params.get('mt') ?? ''
  const plugins = usePlugins()
  const imOn = !!plugins.data?.find((p) => p.id === IM_PLUGIN)?.running
  const sources = useImMaterialSources(projectId, imOn)
  const unlink = useUnlinkImMaterial()
  const sourceOf = new Map((sources.data ?? []).map((s) => [s.material_id, s]))
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [formErr, setFormErr] = useState('')
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<MaterialKind | ''>('')
  const [tag, setTag] = useState('')
  // 正在编辑的那一条；一次只开一个
  const [editing, setEditing] = useState('')

  const all = newestFirst(list.data ?? [])
  const tags = allTags(all)
  const rows = all.filter((m) => matchMaterial(m, { q, kind, tag }))
  const kindsShown = MATERIAL_KINDS.filter((k) => all.some((m) => m.kind === k.key))
  const r = root.trim()

  const close = () => { setDraft(EMPTY); setFormErr(''); onAdding(false) }
  const put = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })

  // 发出去；全加上了收起表单，有失败的留着表单、底部提示原因（SPEC-projects-11.21）
  const send = (inputs: ProjectMaterialInput[]) => {
    setFormErr('')
    add.mutate(inputs, {
      onSuccess: ({ failed }) => {
        if (!failed.length) { close(); return }
        const why = errorText(failed[0].error)
        setFormErr(inputs.length > 1
          ? `${failed.map((f) => f.input.name || f.input.value).join('、')} 没加上：${why}`
          : `没加上：${why}`)
      },
      onError: (e) => setFormErr(`没加上：${errorText(e)}`),
    })
  }

  const submit = () => {
    const name = draft.name.trim()
    let value = draft.value.trim()
    if (!name || !value) return
    if (isPathKind(draft.kind)) {
      const abs = resolvePath(value, r)
      if (abs === null) { setFormErr(NEED_ABS); return }
      value = abs
    }
    send([{ kind: draft.kind, name, value, tags: splitTags(draft.tags) }])
  }

  // 浏览器给的文件名拼在输入框里的目录后面；一个填进路径，多个各加一条（SPEC-projects-11.7）
  const pickFiles = (names: string[]) => {
    const dir = dirOf(draft.value)
    if (names.length === 1) {
      put({ value: joinPath(dir, names[0]), name: draft.name || names[0] })
      return
    }
    const paths = names.map((n) => resolvePath(joinPath(dir, n), r))
    if (paths.some((p) => p === null)) { setFormErr(NEED_ABS); return }
    const t = splitTags(draft.tags)
    send(names.map((n, i) => ({ kind: 'file' as const, name: n, value: paths[i]!, tags: t })))
  }

  const pathHint = () => {
    const base = r ? `相对路径按项目目录补全：${r}/…` : '没设项目目录，要填绝对路径'
    return draft.kind === 'file'
      ? `「选择」在本机挑文件所在的目录；浏览器只拿得到文件名，按输入框里的目录拼${draft.value.trim() ? '' : `（没填时放在 ${defaultDir(r)} 下）`}；${base}；选多个文件会各加一条`
      : `「选择」在本机挑文件夹，拿到的是绝对路径；${base}`
  }

  const form = adding && (
    <div className="pj-inline-form" role="group" aria-label="加材料">
      <div className="pj-seg pj-mat-seg" role="group" aria-label="种类">
        {MATERIAL_KINDS.map((k) => (
          <button key={k.key} type="button" className={cls(draft.kind === k.key && 'on')} aria-pressed={draft.kind === k.key} onClick={() => put({ kind: k.key })}>{k.label}</button>
        ))}
      </div>
      <Input aria-label="名称" value={draft.name} placeholder="名称，比如：客户访谈纪要 10/20" onChange={(e) => put({ name: e.target.value })} />
      {draft.kind === 'note' ? (
        <NoteInput value={draft.value} rows={3} onChange={(v) => put({ value: v })} />
      ) : draft.kind === 'link' ? (
        <Input aria-label="链接" className="mono" value={draft.value} placeholder="https://…" spellCheck={false} onChange={(e) => put({ value: e.target.value })} />
      ) : (
        <>
          <div className="pj-mat-pick">
            <PathInput label={draft.kind === 'file' ? '文件路径' : '文件夹路径'} value={draft.value}
              placeholder={draft.kind === 'file' ? '绝对路径或项目目录下的相对路径，比如 materials/interview.md' : '绝对路径或项目目录下的相对路径，比如 materials/screenshots'}
              start={pickStart(draft, r)}
              pickAs={(d) => {
                if (draft.kind === 'file') return joinPath(d, '')
                if (!draft.name.trim()) put({ name: lastSeg(d) })
                return d
              }}
              onChange={(v) => setDraft((cur) => ({ ...cur, value: v }))} />
            {draft.kind === 'file' && (
              <label className="btn btn-outline pj-mat-files">
                选择文件…
                <input type="file" multiple hidden onChange={(e) => {
                  const names = Array.from(e.target.files ?? []).map((f) => f.name)
                  e.target.value = ''
                  if (names.length) pickFiles(names)
                }} />
              </label>
            )}
          </div>
          <span className="pj-muted pj-wrap">{pathHint()}</span>
        </>
      )}
      <Input aria-label="标签" value={draft.tags} placeholder="标签，逗号隔开" onChange={(e) => put({ tags: e.target.value })} />
      {formErr && <div className="pj-err" role="alert">{formErr}</div>}
      <div className="pj-act-row">
        <Button variant="primary" disabled={!draft.name.trim() || !draft.value.trim() || add.isPending || (draft.kind === 'note' && noteLength(draft.value) > MATERIAL_NOTE_MAX)} onClick={submit}>加上</Button>
        <Button onClick={close}>取消</Button>
      </div>
    </div>
  )

  let body
  if (list.isError) body = <ErrorState title="支持材料没加载出来" error={errorText(list.error)} onRetry={() => void list.refetch()} />
  else if (list.isPending) body = <LoadingState />
  else if (!all.length) {
    body = !adding && <EmptyState title="还没有支持材料" desc="访谈纪要、竞品截图、需求原文、参考链接都可以放这里" action={<Button variant="primary" onClick={() => onAdding(true)}>加材料</Button>} />
  } else {
    body = (
      <>
        <div className="pj-toolbar">
          <div className="search">
            <IconSearch />
            <input type="search" placeholder="搜名称、路径、链接、内容" aria-label="搜索材料" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
            {q && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
          </div>
          <div className="pj-seg" role="group" aria-label="种类筛选">
            <button type="button" className={cls(!kind && 'on')} aria-pressed={!kind} onClick={() => setKind('')}>全部<span className="seg-n">{all.length}</span></button>
            {kindsShown.map((k) => (
              <button key={k.key} type="button" className={cls(kind === k.key && 'on')} aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
                {k.label}<span className="seg-n">{all.filter((m) => m.kind === k.key).length}</span>
              </button>
            ))}
          </div>
        </div>
        {tags.length > 0 && (
          <div className="pj-chips" role="group" aria-label="标签筛选">
            <button type="button" className={cls('chip', !tag && 'chip-on')} aria-pressed={!tag} onClick={() => setTag('')}>全部标签</button>
            {tags.map((t) => (
              <button key={t} type="button" className={cls('chip', tag === t && 'chip-on')} aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</button>
            ))}
          </div>
        )}
        {rows.length ? (
          <ul className="pj-mat-list" aria-label="支持材料">
            {rows.map((m) => (
              <MaterialCard key={m.id} m={m} projectId={projectId} root={r} busy={remove.isPending && remove.variables === m.id} hit={hit === m.id} src={sourceOf.get(m.id)}
                editing={editing === m.id} onEdit={(on) => setEditing(on ? m.id : '')}
                onOpenMessage={(id) => navigate(`${MESSAGES_PATH}?m=${encodeURIComponent(id)}`)}
                onRemove={() => {
                  setErr('')
                  remove.mutate(m.id, {
                    onSuccess: () => { if (sourceOf.has(m.id)) unlink.mutate(m.id) },
                    onError: (e) => setErr(`${m.name} 没移除：${errorText(e)}`),
                  })
                }} />
            ))}
          </ul>
        ) : <EmptyState compact title="没有匹配的材料" desc="换个关键词，或清掉类型和标签筛选" />}
      </>
    )
  }

  return (
    <div className="pj-tab">
      <ProjectKbStrip projectId={projectId} onSettings={onSettings} />
      {form}
      {err && <div className="pj-err" role="alert">{err}</div>}
      {body}
    </div>
  )
}

/** 选目录从哪开始：已填的路径（文件取所在目录），相对路径按项目目录补全；都没有时从项目目录开始 */
function pickStart(d: Draft, root: string): string {
  const v = d.value.trim()
  if (!v) return root
  const dir = d.kind === 'file' ? (v.endsWith('/') ? v : dirOf(v)) : v
  return resolvePath(dir, root) ?? ''
}

/** 笔记正文：带字数，超过上限红字 */
function NoteInput({ value, rows, onChange }: { value: string; rows: number; onChange: (v: string) => void }) {
  const n = noteLength(value)
  const over = n > MATERIAL_NOTE_MAX
  return (
    <span className="pj-note-input">
      <Textarea aria-label="内容" rows={rows} value={value} placeholder="内容" invalid={over} onChange={(e) => onChange(e.target.value)} />
      <span className={cls('pj-muted pj-note-n', over && 'pj-err')}>{over ? `超过 ${MATERIAL_NOTE_MAX} 字（现在 ${n} 字），删掉一些` : `${n} / ${MATERIAL_NOTE_MAX}`}</span>
    </span>
  )
}

/** 卡片里就地展开的编辑表单 */
function MaterialEditor({ m, projectId, root, src, onClose }: {
  m: ProjectMaterial; projectId: string; root: string; src?: ImMaterialSource; onClose: () => void
}) {
  const save = usePatchProjectMaterial(projectId)
  const [d, setD] = useState<EditDraft>(() => editDraftOf(m))
  const [err, setErr] = useState('')
  // 消息附件加进来的：种类和路径不动，附件标签按值认它已加入
  const locked = src?.kind === 'attachment'
  const kinds = switchableKinds(m.kind, locked)
  const put = (patch: Partial<EditDraft>) => setD({ ...d, ...patch })
  const submit = () => {
    const patch = editPatch(m, d, root)
    if ('error' in patch) { setErr(patch.error); return }
    if (!Object.keys(patch).length) { onClose(); return }
    setErr('')
    save.mutate({ materialId: m.id, patch }, { onSuccess: onClose, onError: (e) => setErr(`没保存：${errorText(e)}`) })
  }
  const kindHint = locked ? '来自消息附件，种类和路径不能改' : kinds.length > 1 ? `${kinds.map(kindLabel).join('和')}之间能互换` : ''
  return (
    <div className="pj-mat-edit" role="group" aria-label={`编辑 ${m.name}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      {kinds.length > 1 && (
        <Field label="种类" wrap={false} hint={kindHint}>
          <div className="pj-seg pj-mat-seg" role="group" aria-label="种类">
            {kinds.map((k) => (
              <button key={k} type="button" className={cls(d.kind === k && 'on')} aria-pressed={d.kind === k} onClick={() => put({ kind: k })}>{kindLabel(k)}</button>
            ))}
          </div>
        </Field>
      )}
      <Field label="名称"><Input autoFocus value={d.name} placeholder="不填按内容取" onChange={(e) => put({ name: e.target.value })} /></Field>
      {d.kind === 'note' ? (
        <Field label="内容" wrap={false}><NoteInput value={d.value} rows={6} onChange={(v) => put({ value: v })} /></Field>
      ) : locked ? (
        <Field label={d.kind === 'link' ? '链接' : '路径'} wrap={false} hint={kindHint}><code className="pj-mat-val pj-mat-path">{m.value}</code></Field>
      ) : d.kind === 'link' ? (
        <Field label="链接"><Input className="mono" value={d.value} placeholder="https://…" spellCheck={false} onChange={(e) => put({ value: e.target.value })} /></Field>
      ) : (
        <Field label={d.kind === 'file' ? '文件路径' : '文件夹路径'} wrap={false}
          hint={root ? `相对路径按项目目录补全：${root}/…` : '没设项目目录，要填绝对路径'}>
          <PathInput label={d.kind === 'file' ? '文件路径' : '文件夹路径'} value={d.value} placeholder="绝对路径或项目目录下的相对路径"
            start={pickStart({ kind: d.kind, name: d.name, value: d.value, tags: d.tags }, root)} pickAs={(p) => p}
            onChange={(v) => setD((cur) => ({ ...cur, value: v }))} />
        </Field>
      )}
      <Field label="标签"><Input value={d.tags} placeholder="逗号隔开" onChange={(e) => put({ tags: e.target.value })} /></Field>
      {err && <div className="pj-err" role="alert">{err}</div>}
      <div className="pj-act-row">
        <Button variant="primary" size="sm" disabled={save.isPending || !d.value.trim()} onClick={submit}>{save.isPending ? '保存中…' : '保存'}</Button>
        <Button size="sm" onClick={onClose}>取消</Button>
      </div>
    </div>
  )
}

function MaterialCard({ m, projectId, root, busy, hit, src, editing, onEdit, onOpenMessage, onRemove }: {
  m: ProjectMaterial; projectId: string; root: string; busy: boolean
  /** 编辑表单开着 */
  editing: boolean
  onEdit: (on: boolean) => void
  /** 地址里 ?mt= 指的这一条：高亮、滚过来 */
  hit: boolean
  /** 来自 IM 消息的出处；不是的没有 */
  src?: ImMaterialSource
  onOpenMessage: (id: string) => void
  onRemove: () => void
}) {
  const path = isPathKind(m.kind)
  const check = useWorkdirCheck(path ? m.value : '')
  const missing = path && !!check.data && !check.data.exists
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => { if (hit) ref.current?.scrollIntoView?.({ block: 'center' }) }, [hit])
  // 长笔记（比如一段消息记录）先露前几行
  const [open, setOpen] = useState(false)
  const fold = m.kind === 'note' ? foldNote(m.value) : null
  const msgId = src ? sourceMessage(src) : ''
  return (
    <li ref={ref} className={cls('pj-mat', hit && 'pj-mat-hit')} aria-current={hit || undefined}>
      <span className={`pj-mat-kind pj-mk-${m.kind}`}>{kindLabel(m.kind)}</span>
      <div className="pj-mat-text">
        {editing ? <MaterialEditor m={m} projectId={projectId} root={root} src={src} onClose={() => onEdit(false)} /> : <>
        <b className="pj-mat-name">{m.name}</b>
        {m.kind === 'note' ? (
          <>
            <span className="pj-muted pj-mat-note">{fold && !open ? fold.head : m.value}</span>
            {fold && (
              <button type="button" className="pj-mat-fold" onClick={() => setOpen(!open)}>
                {open ? '收起' : `展开全部（还有 ${fold.rest} 行）`}
              </button>
            )}
          </>
        )
          : m.kind === 'link' && /^https?:/i.test(m.value) ? <a className="pj-link pj-mat-val ellipsis" href={m.value} target="_blank" rel="noreferrer" title={m.value}>{m.value}</a>
            : <code className="pj-mat-val pj-mat-path" title={m.value}>{m.value}{m.kind === 'folder' ? '/' : ''}</code>}
        {missing && <span className="field-err">{m.kind === 'folder' ? '找不到文件夹' : '找不到文件'}</span>}
        </>}
        {src && (
          msgId
            ? <button type="button" className="pj-mat-from" title={`打开那条消息${src.message_ids.length > 1 ? `（这组 ${src.message_ids.length} 条里最新的）` : ''}`} onClick={() => onOpenMessage(msgId)}>{sourceLabel(src)}</button>
            : <span className="pj-muted pj-mat-from">{sourceLabel(src)}</span>
        )}
        <span className="pj-muted pj-mat-meta">
          {m.category && <span className="tag">{m.category}</span>}
          {m.tags.length > 0 && <span>{m.tags.map((t) => `#${t}`).join(' ')}</span>}
          <span title={m.created_at}>{ago(m.created_at)}加入</span>
          {m.updated_at && m.updated_at !== m.created_at && <span title={m.updated_at}>· {ago(m.updated_at)}改过</span>}
        </span>
      </div>
      {!editing && (
        <span className="pj-mat-acts">
          <Button size="sm" variant="ghost" aria-label={`编辑 ${m.name}`} onClick={() => onEdit(true)}>编辑</Button>
          <IconButton size="sm" label="移除" disabled={busy} onClick={onRemove}><IconClose size={11} /></IconButton>
        </span>
      )}
    </li>
  )
}
