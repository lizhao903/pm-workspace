// 文档模块（SPEC-library，DOC-01b）：二级菜单位置是内容树和工作目录切换，顶栏是目录名和筛选，右边阅读区。
// 工作台文档是 type=doc 的对象，一次拉全，按分类树分组；本地目录是挂载在后端的目录（/api/local-dirs），刷新页面还在。
// 当前工作目录和正在读的文档放在地址里（?dir=<挂载 id>&doc=<文档 id>），别的模块可以直接链过来；筛选、搜索是页面状态。
// 工作台文档能按所属项目筛，阅读区显示所属项目、点了去项目的文档标签（C-04）。
// 工作台文档可以新建、编辑（C-03）：?edit=new 新建，?doc=<id>&edit=1 编辑这篇；有没保存的改动时离开先确认（SPEC-library-1.46）。
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  errorText, isApiError, isStarred, useAllObjects, useCategoryTree, useLocalDirFiles, useLocalDirs, useNotifyChange, useObjectTypes,
  useProjects, useSetStarred, useTags, useUnmountLocalDir, type LocalDir, type ObjectFilter,
} from '../../core/data'
import { Button, ConfirmDialog, InSubnavHost, LoadingState } from '../../core/ui'
import { LibraryBar } from './Bar'
import { DocEditor } from './Editor'
import {
  builtinModel, BUILTIN, defaultCategory, dirWs, folderModel, indexCategories, listNote, projectOptions, readDefaultWs, timeAgo, UNCATEGORIZED_LABEL, writeDefaultWs,
  type Doc, type Filter, type Workspace,
} from './model'
import { MountDrawer } from './MountDrawer'
import { LibraryReader } from './Reader'
import { LibraryTree } from './Tree'
import './docs.css'

const DOC_FILTER: ObjectFilter = { type: ['doc'], sort: '-updated_at' }
const WIDE = '(min-width: 761px)'
/** 项目插件的路径；项目详情的文档标签是 /projects/<id>/docs */
const PROJECTS = '/projects'
const wide = () => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE).matches

export default function Page() {
  const [params, setParams] = useSearchParams()
  const dirParam = params.get('dir')
  const dirs = useLocalDirs()
  // 地址里的挂载已经不在了（别处移除了）就按工作台文档显示
  const gone = !!dirParam && !!dirs.data && !dirs.data.some((d) => d.id === dirParam)
  const dirId = gone ? null : dirParam
  const ws: Workspace = dirId ? dirWs(dirId) : BUILTIN
  const reading = params.get('doc')
  const [kind, setKind] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [project, setProject] = useState('')
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q)
  const [mounting, setMounting] = useState(false)
  const [dirError, setDirError] = useState('')
  // 编辑区有没保存的改动；要离开时先把去处记下，确认后再走
  const [dirty, setDirty] = useState(false)
  const [leaving, setLeaving] = useState<{ run: () => void } | null>(null)
  const filter: Filter = useMemo(() => ({ kind, tags, q: dq, project }), [kind, tags, dq, project])

  const dir: LocalDir | null = dirId ? dirs.data?.find((d) => d.id === dirId) ?? null : null
  const docs = useAllObjects(DOC_FILTER, { enabled: !dirId })
  const cats = useCategoryTree('doc')
  const tagList = useTags()
  const files = useLocalDirFiles(dir?.id ?? null)
  const types = useObjectTypes()
  const projects = useProjects()
  const navigate = useNavigate()
  const notify = useNotifyChange()
  const star = useSetStarred()
  const unmount = useUnmountLocalDir()

  const model = useMemo(
    () => (dir ? folderModel(dir, files.data, filter) : builtinModel(docs.data?.data ?? [], cats.data ?? [], filter, isStarred)),
    [dir, files.data, docs.data, cats.data, filter],
  )

  const update = useCallback((next: { dir?: string | null; doc?: string | null; edit?: string | null }) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      for (const [k, v] of Object.entries(next)) {
        if (v) n.set(k, v)
        else if (v === null) n.delete(k)
      }
      return n
    }, { replace: true })
  }, [setParams])

  // 有没保存的改动时先确认，确认了再走（SPEC-library-1.46）
  const guard = (run: () => void) => {
    if (dirty) setLeaving({ run })
    else run()
  }

  // 换工作目录：筛选、搜索、当前阅读一起清空（SPEC-library-1.8）
  const switchWs = useCallback((w: Workspace) => {
    setKind(''); setTags([]); setProject(''); setQ(''); setDirError('')
    update({ dir: w === BUILTIN ? null : w.slice(4), doc: null, edit: null })
  }, [update])

  useEffect(() => {
    if (gone) update({ dir: null, doc: null })
  }, [gone, update])

  // 默认工作目录（SPEC-library-1.53）：进来时地址里没指定目录、文档、编辑，就切到设为默认的那个挂载；只在进来时做一次，
  // 之后在页面里切回工作台文档不会被拉回去。默认的挂载已经移除了就当没设。
  const [defaultWs, setDefaultWs] = useState<Workspace>(readDefaultWs)
  const [entered] = useState(() => !params.get('dir') && !params.get('doc') && !params.get('edit'))
  const appliedDefault = useRef(false)
  useEffect(() => {
    // 目录列表一到就定下来，只看进来那一刻的默认；之后在菜单里改默认不跳
    if (appliedDefault.current || !dirs.data) return
    appliedDefault.current = true
    if (!entered || defaultWs === BUILTIN) return
    const id = defaultWs.slice(4)
    if (dirs.data.some((d) => d.id === id)) update({ dir: id })
  }, [entered, defaultWs, dirs.data, update])
  const setDefault = (w: Workspace) => { writeDefaultWs(w); setDefaultWs(w) }

  // 当前阅读的不在筛选结果里就落到第一条；宽屏下右侧不留空，手机上留在内容树（SPEC-library-1.15）
  const current: Doc | null = model.rows.find((r) => r.id === reading) ?? null
  // 本地目录要等全部页拉完：地址里指定的文件可能在后面的页里，没拉完就落到第一条会把它顶掉
  const ready = dir ? !!files.data && !files.data.loading : !!docs.data
  // 编辑状态只对工作台文档：新建，或当前阅读的这篇能在对象列表里找到
  const editParam = dir ? null : params.get('edit')
  const creating = editParam === 'new'
  const editObj = editParam === '1' && reading ? docs.data?.data.find((o) => o.id === reading) ?? null : null
  const editing = creating || !!editObj
  useEffect(() => {
    if (ready && !current && !creating && model.rows.length && wide()) update({ doc: model.rows[0].id })
  }, [ready, current, creating, model.rows, update])

  const catIndex = useMemo(() => indexCategories(cats.data ?? []), [cats.data])
  const catName = useCallback((id: string) => catIndex.get(id)?.names.join(' / ') ?? (id || UNCATEGORIZED_LABEL), [catIndex])
  // 保存后先把列表读回来再切回阅读，免得新建的这篇还没进列表就被「落到第一条」顶掉
  const saved = (id: string) => {
    setDirty(false)
    if (creating) { setKind(''); setTags([]); setProject(''); setQ('') }
    void docs.refetch().finally(() => update({ doc: id, edit: null }))
  }

  const statusLabel = useCallback((key: string) => types.data?.find((t) => t.id === 'doc')?.statuses.find((s) => s.key === key)?.label ?? key, [types.data])

  const tagOptions = useMemo(() => {
    if (dir) return []
    // 只列文档上出现过的标签，数量是文档里的篇数；颜色、顺序按标签表
    const n = new Map<string, number>()
    for (const d of model.docs) for (const t of d.tags) n.set(t, (n.get(t) ?? 0) + 1)
    const order = new Map((tagList.data ?? []).map((t, i) => [t.name, i]))
    return [...n.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9) || a[0].localeCompare(b[0]))
      .map(([t, c]) => ({ value: t, label: t, hint: `${c} 篇` }))
  }, [dir, model.docs, tagList.data])

  const projectList = useMemo(() => (projects.data?.data ?? []).map((p) => ({ id: p.id, title: p.title })), [projects.data])
  // 没有项目、也没有文档挂在项目上（比如没开项目模块）时不显示下拉
  const projectOpts = useMemo(
    () => (dir || (!projectList.length && !model.docs.some((d) => d.project)) ? [] : projectOptions(model.docs, projectList)),
    [dir, projectList, model.docs],
  )
  // 阅读区的所属项目：项目列表还没读到时先当作在；读到了不在就是进了回收站，不给跳
  const projectOf = useCallback((id: string) => {
    const p = projects.data?.data.find((x) => x.id === id)
    return p ? { name: p.title, live: true } : { name: '', live: !projects.data }
  }, [projects.data])

  const source = dir ? files : docs
  let status = null
  if (dirId && !dirs.data) status = dirs.isError ? <TreeError error={dirs.error} onRetry={() => void dirs.refetch()} /> : <LoadingState />
  else if (!source.data) {
    status = source.isError
      ? <TreeError error={source.error} onRetry={() => void source.refetch()} gone={!!dir && isApiError(source.error, 'not_found')} />
      : <LoadingState />
  }

  // 大目录一页页列：第一页还没有文件（走得慢先交回来）时照样显示加载中
  else if (dir && files.data?.loading && !model.rows.length && !filter.q.trim()) status = <LoadingState />
  const kicker = dir ? listNote(files.data) : undefined
  // 后面的页拉失败了：前面列到的照常显示，树底下给重试
  const pageError = dir && files.pageError ? `后面的文件没列完：${errorText(files.pageError)}` : ''

  const removeDir = (id: string) => {
    setDirError('')
    unmount.mutate(id, {
      onSuccess: () => { if (id === dirId) switchWs(BUILTIN) },
      onError: (e) => setDirError(`移除失败：${errorText(e)}`),
    })
  }

  const mode = reading || creating ? 'reader' : 'tree'

  return (
    <div className="docs-mod" data-lib={mode}>
      <LibraryBar model={model} kind={kind} onKind={setKind} tags={tags} onTags={setTags} tagOptions={tagOptions}
        project={project} onProject={setProject} projectOptions={projectOpts}
        onRefresh={() => void notify({ kind: 'local-dir' })} refreshing={files.isFetching}
        readAt={files.dataUpdatedAt ? timeAgo(files.dataUpdatedAt) : ''}
        onNew={() => guard(() => update({ edit: 'new' }))} creating={creating} />
      <InSubnavHost>
        <LibraryTree ws={ws} model={model} filter={filter} dirs={dirs.data ?? []} selected={creating ? null : reading}
          onSelect={(id) => guard(() => update({ doc: id, edit: null }))} onSwitch={(w) => guard(() => switchWs(w))}
          onAddFolder={() => { setDirError(''); setMounting(true) }} onRemoveFolder={removeDir}
          q={q} onQ={setQ} status={status} kicker={kicker} error={dirError} mode={mode} defaultWs={defaultWs} onSetDefault={setDefault}
          pageError={pageError} onRetryPage={files.retryPage} />
      </InSubnavHost>
      {editing ? (
        <DocEditor key={editObj?.id ?? 'new'} doc={editObj} cats={cats.data ?? []} defaultCat={defaultCategory(cats.data ?? [], kind)}
          onSaved={saved} onDirty={setDirty} onCancel={() => guard(() => update({ edit: null }))} />
      ) : (
        <LibraryReader model={model} current={current} statusLabel={statusLabel} catName={catName}
          onBack={() => update({ doc: null })} onStar={(d) => star.mutate({ id: d.id, on: !d.starred })} starring={star.isPending}
          onEdit={(d) => update({ doc: d.id, edit: '1' })} projectOf={projectOf}
          onProject={(id) => void navigate(`${PROJECTS}/${encodeURIComponent(id)}/docs`)} />
      )}
      <ConfirmDialog open={!!leaving} title="有没保存的改动" confirmLabel="丢掉改动" cancelLabel="接着写" danger
        onCancel={() => setLeaving(null)}
        onConfirm={() => { const run = leaving?.run; setLeaving(null); setDirty(false); run?.() }}>
        离开后这次的改动不会保存。
      </ConfirmDialog>
      <MountDrawer open={mounting} onClose={() => setMounting(false)} existing={dirs.data ?? []}
        onMounted={(d) => { setMounting(false); switchWs(dirWs(d.id)) }} />
    </div>
  )
}

/** 内容树位置的出错提示（SPEC-library-1.38） */
function TreeError({ error, onRetry, gone }: { error: unknown; onRetry: () => void; gone?: boolean }) {
  return (
    <div className="tree-empty tree-error" role="alert">
      <div>{gone ? '这个目录已经不在了，可以从工作目录菜单里移除' : `加载失败：${errorText(error)}`}</div>
      <Button size="sm" onClick={onRetry}>重试</Button>
    </div>
  )
}
