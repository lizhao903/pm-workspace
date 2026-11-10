// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「角色」（SPEC-settings-24，AUTO-03 由预置提示词升级）：交给 Claude Code 时选的角色。
// 列表和编辑分开（同设置「Agent」）：/settings/run-prompts 是列表，/settings/run-prompts/new 新建，/settings/run-prompts/<id> 编辑一个。
// 后端只有整组接口（GET / PUT /api/run-prompts），编辑页保存时把这一个换进最新的整组再 PUT；内置角色后端会补回没见过的，删掉的不补回。
// 前端先挡空的、重复的、超长的，其余以后端为准，400 时显示它的 message。
import { useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { errorText, useRunPresets, useSaveRunPresets, type RunPreset } from '../../../core/data'
import { Button, Checkbox, EmptyState, ErrorState, Field, Input, LoadingState, PageTitle, Pill, Select, Textarea } from '../../../core/ui'
import {
  DIR_KIND_OPTIONS, PERMISSION_OPTIONS, PRESET_CONTENT_MAX, PRESET_MAX, PRESET_OUTPUT_MAX, PRESET_SCENE_MAX, blankRole, cleanPresets, presetIssues,
} from './presetModel'
import './runprompts.css'

const ROOT = '/settings/run-prompts'
const DESC = '交给 Claude Code 时选一个角色：执行要求和输出要求拼进提示词，权限决定能不能改文件'

export function RunPresetsSection() {
  const sub = (useParams()['*'] ?? '').split('/').slice(1).join('/')
  const q = useRunPresets()
  if (q.isPending) return <div className="rp-page"><PageTitle parent="设置" desc={DESC}>角色</PageTitle><LoadingState /></div>
  if (q.isError) {
    return (
      <div className="rp-page">
        <PageTitle parent="设置" desc={DESC}>角色</PageTitle>
        <ErrorState title="角色没加载出来" error={errorText(q.error)} onRetry={() => void q.refetch()} />
      </div>
    )
  }
  if (!sub) return <RoleList list={q.data} />
  if (sub === 'new') return <RoleEditor key="new" list={q.data} id={null} />
  return <RoleEditor key={sub} list={q.data} id={sub} />
}

const permLabel = (p: RunPreset) => (p.permission === 'read_only' ? '只读' : '允许改文件')
const dirLabel = (p: RunPreset) => DIR_KIND_OPTIONS.find((o) => o.value === (p.dir_kind ?? 'any'))?.label ?? '不限'
/** 执行要求的第一行，列表里当摘要 */
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

function RoleList({ list }: { list: RunPreset[] }) {
  const navigate = useNavigate()
  const saved = (useLocation().state as { deleted?: string } | null)?.deleted
  const full = list.length >= PRESET_MAX
  return (
    <div className="rp-page">
      <PageTitle parent="设置" count={list.length} desc={DESC}
        actions={<Button variant="primary" disabled={full} title={full ? `最多 ${PRESET_MAX} 个` : undefined} onClick={() => void navigate(`${ROOT}/new`)}>新建角色</Button>}>
        角色
      </PageTitle>
      <div className="rp-muted">
        交给 Claude Code 的弹窗里选一个，标了默认的打开时就选上。只读角色流式执行时不放开文件编辑；终端方式的权限由启动命令决定，只读只写进提示词。
      </div>
      {saved && <div className="rp-ok" role="status">已删除「{saved}」</div>}
      {list.length ? (
        <div className="rp-table" role="table" aria-label="角色">
          <div className="rp-trow rp-th" role="row">
            <span role="columnheader">角色</span><span role="columnheader">权限</span><span role="columnheader">默认目录</span>
          </div>
          {list.map((p) => (
            <button key={p.id} type="button" role="row" className="rp-trow" onClick={() => void navigate(`${ROOT}/${encodeURIComponent(p.id)}`)}>
              <span role="cell" className="rp-cell-main">
                <span className="rp-scene"><b className="ellipsis">{p.scene}</b>{p.default && <Pill label="默认" color="var(--accent)" />}</span>
                <span className="rp-muted ellipsis">{firstLine(p.content)}</span>
              </span>
              <span role="cell" className="rp-muted">{permLabel(p)}</span>
              <span role="cell" className="rp-muted">{dirLabel(p)}</span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState title="还没有角色" desc="交给 Claude Code 时只能手写附加说明。点右上角新建一个"
          action={<Button onClick={() => void navigate(`${ROOT}/new`)}>新建角色</Button>} />
      )}
    </div>
  )
}

type Note = { ok: boolean; text: string }

function RoleEditor({ list, id }: { list: RunPreset[]; id: string | null }) {
  const navigate = useNavigate()
  const save = useSaveRunPresets()
  const base = id ? list.find((p) => p.id === id) : blankRole()
  const [d, setD] = useState<RunPreset | undefined>(base)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  if (!base || !d) {
    return (
      <div className="rp-page">
        <PageTitle parent="角色">找不到</PageTitle>
        <EmptyState title="这个角色不存在或已删除" action={<Button onClick={() => void navigate(ROOT)}>回到角色列表</Button>} />
      </div>
    )
  }

  // 这个角色放回整组里的样子：编辑的换掉原位，新建的接在末尾；设了默认时别的取消默认（单选）
  const merged = (cur: RunPreset): RunPreset[] => {
    const others = list.map((p) => (cur.default && p.id !== id ? { ...p, default: false } : p))
    return id ? others.map((p) => (p.id === id ? cur : p)) : [...others, cur]
  }
  const all = merged(d)
  const idx = id ? all.findIndex((p) => p.id === id) : all.length - 1
  const err = presetIssues(all, idx)
  const bad = Object.keys(err).length > 0
  const changed = !id || JSON.stringify(cleanPresets([d])) !== JSON.stringify(cleanPresets([base]))
  const set = (p: Partial<RunPreset>) => { setD({ ...d, ...p }); setNote(null) }
  const shown = tried || !!id ? err : {}

  const submit = () => {
    setTried(true)
    setNote(null)
    if (bad || !changed || save.isPending) return
    const scene = d.scene.trim()
    save.mutate(cleanPresets(all), {
      onSuccess: (r) => {
        if (id) { setNote({ ok: true, text: '已保存' }); return }
        // 新建的 id 由后端补，按场景名找回来（场景不许重复）
        const made = r.find((p) => p.scene === scene)
        void navigate(made ? `${ROOT}/${encodeURIComponent(made.id)}` : ROOT, { replace: true })
      },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }
  const remove = () => {
    if (!id) return
    save.mutate(cleanPresets(list.filter((p) => p.id !== id)), {
      onSuccess: () => void navigate(ROOT, { replace: true, state: { deleted: base.scene } }),
      onError: (e) => { setConfirmDel(false); setNote({ ok: false, text: `没删掉：${errorText(e)}` }) },
    })
  }

  return (
    <form className="rp-page" aria-label="编辑角色" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <PageTitle parent="角色">{id ? base.scene : '新建角色'}</PageTitle>
      <div className="rp-actions">
        <Button onClick={() => void navigate(ROOT)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          角色
        </Button>
      </div>
      <div className="rp-item">
        <div className="rp-row">
          <Field label="角色场景" required error={shown.scene}>
            <Input value={d.scene} placeholder="如：产品经理工作台" aria-label="角色场景" invalid={!!shown.scene} autoFocus={!id}
              maxLength={PRESET_SCENE_MAX + 10} onChange={(e) => set({ scene: e.target.value })} />
          </Field>
          <Checkbox className="rp-default" checked={d.default} onCheckedChange={(v) => set({ default: !!v })}>默认</Checkbox>
        </div>
        <div className="rp-row rp-opts">
          <Field label="权限">
            <Select value={d.permission ?? 'accept_edits'} aria-label="权限" options={PERMISSION_OPTIONS}
              onValueChange={(v) => set({ permission: v as RunPreset['permission'] })} />
          </Field>
          <Field label="默认目录" hint="项目档案上线后按它选工作目录，现在只记下">
            <Select value={d.dir_kind ?? 'any'} aria-label="默认目录" options={DIR_KIND_OPTIONS}
              onValueChange={(v) => set({ dir_kind: v as RunPreset['dir_kind'] })} />
          </Field>
        </div>
        <Field label="执行要求" required error={shown.content}>
          <Textarea rows={8} value={d.content} placeholder="交给 Claude Code 时要它照做的事" aria-label="执行要求"
            invalid={!!shown.content} maxLength={PRESET_CONTENT_MAX + 100} onChange={(e) => set({ content: e.target.value })} />
        </Field>
        <Field label="输出要求" error={shown.output} hint="可选：结束时要它怎么回报，如用 pmw_finish_run 回报 result 的结构">
          <Textarea rows={3} value={d.output ?? ''} placeholder={'如：结束时用 pmw_finish_run 回报 result：{"verdict": "pass 或 reject", "issues": [...]}'}
            aria-label="输出要求" invalid={!!shown.output} maxLength={PRESET_OUTPUT_MAX + 100} onChange={(e) => set({ output: e.target.value })} />
        </Field>
      </div>
      <div className="rp-actions">
        {id && (confirmDel ? (
          <>
            <span className="rp-muted">删掉「{base.scene}」？已经用它发起的执行不受影响</span>
            <Button size="sm" variant="danger" disabled={save.isPending} onClick={remove}>确认删除</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button>
          </>
        ) : <Button size="sm" variant="ghost" onClick={() => setConfirmDel(true)}>删除角色</Button>)}
        <span className="spacer" />
        {id && changed && <Button size="sm" variant="ghost" onClick={() => { setD(base); setNote(null) }}>撤销改动</Button>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!changed || (tried && bad) || save.isPending}>
          {save.isPending ? '保存中…' : id ? '保存' : '建好'}
        </button>
      </div>
      {note && <div className={note.ok ? 'rp-ok' : 'rp-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
    </form>
  )
}
