// 流程库（SPEC-sop-2）：全部流程的卡片，有执行停下来等人的排在前面。统计（执行次数、待处理、最近执行）按执行列表现算。
// 用到当前工作台没开的模块的流程（比如产品经理工作台里的「视频周更」）标「需要视频模块」，排在最后（SPEC-sop-2.11）
// 文件夹（TSK-0482，SPEC-sop-2.15 起）：只有一级。顶部一行文件夹筛选，写法同文档顶栏的分类筛选（fchip「名字 + 数量」，点选、再点取消）；
// 新建、改名、删除同交易自选组的组管理（「+」新建，选中一个文件夹后铅笔进行内编辑行）。删非空文件夹先确认，里面的流程回「未分类」。
// 搜索不分文件夹；卡片右下角的文件夹名点开能移到别的文件夹（只换文件夹，不升版本）
import { useState } from 'react'
import { errorText, useDeleteSopFolder, useMoveSopFlows, useSaveSopFolder, type SopFlow, type SopFolder } from '../../core/data'
import { Button, ConfirmDialog, EmptyState, IconButton, IconSearch, Input, PageTitle, SearchSelect, cls } from '../../core/ui'
import {
  FOLDER_ALL, FOLDER_NONE, UNCATEGORIZED, folderChips, folderNameError, folderOf, folderPass, libPass, libraryRows, timeAgo,
  type FlowStat, type FolderKey, type LibFilter,
} from './model'
import { IconPlus } from './parts'
import { IMBar } from './IMBar'
import { ScheduleBar } from './ScheduleBar'
import { needsText } from './scope'
import { ruleTextFixes } from './repair'

const FILTERS: [LibFilter, string][] = [['', '全部'], ['pending', '有待处理'], ['never', '没执行过']]

const IconPencil = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
)

export function Library({ flows, folders, folder, onFolder, stats, needs, trigger, onOpen, onNew, now }: {
  flows: readonly SopFlow[]
  /** 文件夹，按新建先后 */
  folders: readonly SopFolder[]
  /** 当前文件夹筛选：'' 全部，'none' 未分类，其余是文件夹 id（记在地址的 ?folder= 上） */
  folder: FolderKey
  onFolder: (k: FolderKey) => void
  stats: Map<string, FlowStat>
  /** 流程要的、当前工作台没开的模块名 */
  needs: (f: SopFlow) => string[]
  /** 触发方式的显示名 */
  trigger: (t: string) => string
  onOpen: (id: string) => void
  /** 新建流程；在某个文件夹里点的，新流程默认放进这个文件夹 */
  onNew: (folderId: string | null) => void
  now: number
}) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<LibFilter>('')
  const searching = !!q.trim()
  // 选中的文件夹被删了（别处删的）按全部看
  const key: FolderKey = folder && folder !== FOLDER_NONE && !folders.some((x) => x.id === folder) ? FOLDER_ALL : folder
  const nameOf = (s: SopFlow) => folders.find((x) => x.id === folderOf(s, folders))?.name ?? ''
  const rows = libraryRows(flows, stats, f, q, {
    trigger, elsewhere: (x) => needs(x).length > 0, folder: (x) => folderPass(x, key, folders), folderName: nameOf,
  })
  const cur = folders.find((x) => x.id === key)
  const newHere = () => onNew(cur?.id ?? null)
  return (
    <div className="sop-page">
      <PageTitle parent="SOP" count={flows.length} desc="全部标准流程；有执行停下来等你的排在前面"
        actions={<Button variant="primary" onClick={newHere}><IconPlus />新建 SOP</Button>}>
        流程库
      </PageTitle>
      <div className="sop-toolbar">
        <div className="sop-seg" role="group" aria-label="筛选流程">
          {FILTERS.map(([k, l]) => (
            <button key={k} type="button" className={cls(f === k && 'on')} aria-pressed={f === k} onClick={() => setF(k)}>
              {l}<span className="seg-n">{flows.filter((x) => libPass(x, k, stats) && (searching || folderPass(x, key, folders))).length}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input placeholder="搜索流程名、说明、触发方式、文件夹" aria-label="搜索流程" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <FolderBar flows={flows} folders={folders} current={key} searching={searching} onPick={onFolder} />
      {!rows.length ? (
        <EmptyState
          title={searching || f ? '没有匹配的流程' : key ? '这个文件夹里还没有流程' : '还没有标准流程'}
          desc={searching || f ? '换个筛选条件试试' : key ? '在别的文件夹的卡片上点文件夹名移过来，或在这里新建' : '把反复做的事情编排成 SOP，每次按同样的步骤执行'}
          action={!(searching || f) && <Button variant="primary" onClick={newHere}><IconPlus />新建 SOP</Button>} />
      ) : (
        <div className="sop-lib-grid">
          {rows.map((s) => <Card key={s.id} s={s} x={stats.get(s.id)} need={needs(s)} folders={folders} now={now} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  )
}

function Card({ s, x, need, folders, now, onOpen }: {
  s: SopFlow
  x?: FlowStat
  need: string[]
  folders: readonly SopFolder[]
  now: number
  onOpen: (id: string) => void
}) {
  const move = useMoveSopFlows()
  const fid = folderOf(s, folders)
  // 条件是一句话的步骤（TSK-0498）：执行到必然失败，卡片右上角红标「需修复」，悬停写明是哪几步
  const fixes = ruleTextFixes(s.issues, s.steps, s.trigger)
  // 定时触发的流程卡片下面接一行规则、下次执行和启停开关（TSK-0463）；开关不能放进按钮里，挂在卡片外面。
  // 移到文件夹（TSK-0482）同理挂在卡片按钮外面，右下角
  return (
    <div className="sop-lib-cell">
      <div className="sop-lib-main">
        <button type="button" className={cls('sop-lib-card', need.length > 0 && 'elsewhere', folders.length > 0 && 'with-folder')} onClick={() => onOpen(s.id)}>
          <span className="sop-lib-head">
            <span className="sop-lib-name ellipsis" title={s.name}>{s.name}</span>
            {fixes.length > 0 && (
              <span className="sop-lib-pending sop-lib-broken" title={`这些步骤的条件是一句话，执行到这里会失败：${fixes.map((f) => `「${f.name}」`).join('、')}`}>
                需修复
              </span>
            )}
            {!!x?.pending && <span className="sop-lib-pending">{x.pending} 个待处理</span>}
            {need.length > 0 && <span className="sop-lib-need" title="这个工作台没开这个模块，执行时可能选不到要的数据">{needsText(need)}</span>}
          </span>
          <span className="sop-lib-desc" title={s.desc}>{s.desc || '没有说明'}</span>
          <span className="sop-lib-meta">
            <span>{s.steps.length} 步</span>
            <span>{x ? `执行 ${x.n} 次` : '没执行过'}</span>
            {x && <span>{timeAgo(new Date(x.last).toISOString(), now)}执行</span>}
          </span>
        </button>
        {folders.length > 0 && (
          <SearchSelect variant="plain" className={cls('sop-lib-move', !fid && 'none')} value={fid ?? ''} placeholder={UNCATEGORIZED}
            noneLabel={UNCATEGORIZED} searchPlaceholder="搜文件夹" align="end" disabled={move.isPending}
            options={folders.map((d) => ({ value: d.id, label: d.name }))}
            aria-label={`「${s.name}」移到文件夹`} title={move.isError ? `没移成：${errorText(move.error)}` : '移到文件夹'}
            onChange={(v) => { if ((v || null) !== fid) move.mutate({ flowIds: [s.id], folderId: v || null }) }} />
        )}
      </div>
      <ScheduleBar flow={s} now={now} className="sop-lib-sched" />
      {/* IM 触发的顺序、过滤条件、拦截（TSK-0481） */}
      <IMBar flow={s} className="sop-lib-sched" />
    </div>
  )
}

/** 文件夹一行：全部、各文件夹、未分类（各带数量），后面是新建和改名 / 删除当前文件夹 */
function FolderBar({ flows, folders, current, searching, onPick }: {
  flows: readonly SopFlow[]
  folders: readonly SopFolder[]
  current: FolderKey
  searching: boolean
  onPick: (k: FolderKey) => void
}) {
  const save = useSaveSopFolder()
  const del = useDeleteSopFolder()
  // 行内编辑：new 新建，否则是在改名的文件夹 id
  const [edit, setEdit] = useState<{ id: 'new' | string; name: string } | null>(null)
  const [ask, setAsk] = useState<SopFolder | null>(null)
  const cur = folders.find((x) => x.id === current)
  const chips = folderChips(flows, folders)
  const issue = edit ? folderNameError(edit.name, folders, edit.id === 'new' ? undefined : edit.id) : ''
  const open = (e: { id: 'new' | string; name: string }) => { save.reset(); del.reset(); setEdit(e) }
  const commit = () => {
    if (!edit || issue) return
    const name = edit.name.trim()
    save.mutate({ id: edit.id === 'new' ? undefined : edit.id, name }, {
      onSuccess: (f) => { setEdit(null); if (edit.id === 'new') onPick(f.id) },
    })
  }
  const remove = (f: SopFolder) => del.mutate(f.id, { onSuccess: () => { setAsk(null); setEdit(null); onPick(FOLDER_ALL) } })
  const askRemove = (f: SopFolder) => {
    // 空文件夹直接删；里面有流程的先确认
    const n = flows.filter((x) => folderPass(x, f.id, folders)).length
    if (n) setAsk(f)
    else remove(f)
  }
  const askN = ask ? flows.filter((x) => folderPass(x, ask.id, folders)).length : 0
  const err = save.isError ? errorText(save.error) : del.isError ? `没删成：${errorText(del.error)}` : ''

  return (
    <>
      <div className={cls('sop-folders', searching && 'searching')} role="group" aria-label="按文件夹筛选">
        {folders.length > 0 && (
          <>
            <button type="button" className={cls('fchip', !current && 'on')} aria-pressed={!current} onClick={() => onPick(FOLDER_ALL)}>
              全部<span className="seg-n">{flows.length}</span>
            </button>
            {chips.map((c) => (
              <button type="button" key={c.key} className={cls('fchip', current === c.key && 'on')} aria-pressed={current === c.key}
                title={c.key === FOLDER_NONE ? '没放进文件夹的流程' : c.label} onClick={() => onPick(current === c.key ? FOLDER_ALL : c.key)}>
                <span className="sop-folder-name">{c.label}</span><span className="seg-n">{c.count}</span>
              </button>
            ))}
          </>
        )}
        <IconButton size="sm" label="新建文件夹" onClick={() => open({ id: 'new', name: '' })}><IconPlus /></IconButton>
        {folders.length === 0 && <button type="button" className="sop-folder-hint" onClick={() => open({ id: 'new', name: '' })}>新建文件夹，给流程分类</button>}
        {cur && (
          <IconButton size="sm" label={`改名或删除「${cur.name}」`} onClick={() => open({ id: cur.id, name: cur.name })}><IconPencil /></IconButton>
        )}
        {searching && folders.length > 0 && <span className="sop-folder-note">搜索时在全部文件夹里找</span>}
      </div>
      {edit && (
        <div className="sop-folder-edit" role="group" aria-label={edit.id === 'new' ? '新建文件夹' : '改文件夹'}>
          <Input autoFocus value={edit.name} placeholder="文件夹名称" aria-label="文件夹名称" invalid={!!edit.name.trim() && !!issue}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(null) }} />
          <Button variant="primary" size="sm" disabled={!!issue || save.isPending} onClick={commit}>{edit.id === 'new' ? '新建' : '保存'}</Button>
          {edit.id !== 'new' && cur && (
            <Button variant="danger-ghost" size="sm" disabled={del.isPending} onClick={() => askRemove(cur)}>删除文件夹</Button>
          )}
          <Button size="sm" onClick={() => setEdit(null)}>取消</Button>
          {(err || (edit.name.trim() && issue)) && <span className="sop-folder-err" role="alert">{err || issue}</span>}
        </div>
      )}
      <ConfirmDialog open={!!ask} danger title={`删除文件夹「${ask?.name ?? ''}」？`} confirmLabel="删除文件夹" busy={del.isPending}
        impacts={[`里面的 ${askN} 个流程移到「${UNCATEGORIZED}」，流程本身不删、不改`]}
        onConfirm={() => ask && remove(ask)} onCancel={() => setAsk(null)}>
        文件夹删了就没有了，流程的执行记录不受影响。
      </ConfirmDialog>
    </>
  )
}
