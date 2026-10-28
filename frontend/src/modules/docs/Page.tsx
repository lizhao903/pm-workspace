// 文档模块（SPEC-library，DOC-01b）：二级菜单位置是内容树和工作目录切换，顶栏是目录名和筛选，右边阅读区。
// 工作台文档是 type=doc 的对象，一次拉全，按分类树分组；本地目录是挂载在后端的目录（/api/local-dirs），刷新页面还在。
// 当前工作目录和正在读的文档放在地址里（?dir=<挂载 id>&doc=<文档 id>），别的模块可以直接链过来；筛选、搜索是页面状态。
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  errorText, isApiError, isStarred, useAllObjects, useCategoryTree, useLocalDirFiles, useLocalDirs, useNotifyChange, useObjectTypes,
  useSetStarred, useTags, useUnmountLocalDir, type LocalDir, type ObjectFilter,
} from '../../core/data'
import { Button, InSubnavHost, LoadingState } from '../../core/ui'
import { LibraryBar } from './Bar'
import { builtinModel, BUILTIN, dirWs, folderModel, timeAgo, type Doc, type Filter, type Workspace } from './model'
import { MountDrawer } from './MountDrawer'
import { LibraryReader } from './Reader'
import { LibraryTree } from './Tree'
import './docs.css'

const DOC_FILTER: ObjectFilter = { type: ['doc'], sort: '-updated_at' }
const WIDE = '(min-width: 761px)'
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
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q)
  const [mounting, setMounting] = useState(false)
  const [dirError, setDirError] = useState('')
  const filter: Filter = useMemo(() => ({ kind, tags, q: dq }), [kind, tags, dq])

  const dir: LocalDir | null = dirId ? dirs.data?.find((d) => d.id === dirId) ?? null : null
  const docs = useAllObjects(DOC_FILTER, { enabled: !dirId })
  const cats = useCategoryTree('doc')
  const tagList = useTags()
  const files = useLocalDirFiles(dir?.id ?? null)
  const types = useObjectTypes()
  const notify = useNotifyChange()
  const star = useSetStarred()
  const unmount = useUnmountLocalDir()

  const model = useMemo(
    () => (dir ? folderModel(dir, files.data, filter) : builtinModel(docs.data?.data ?? [], cats.data ?? [], filter, isStarred)),
    [dir, files.data, docs.data, cats.data, filter],
  )

  const update = useCallback((next: { dir?: string | null; doc?: string | null }) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      for (const [k, v] of Object.entries(next)) {
        if (v) n.set(k, v)
        else if (v === null) n.delete(k)
      }
      return n
    }, { replace: true })
  }, [setParams])

  // 换工作目录：筛选、搜索、当前阅读一起清空（SPEC-library-1.8）
  const switchWs = useCallback((w: Workspace) => {
    setKind(''); setTags([]); setQ(''); setDirError('')
    update({ dir: w === BUILTIN ? null : w.slice(4), doc: null })
  }, [update])

  useEffect(() => {
    if (gone) update({ dir: null, doc: null })
  }, [gone, update])

  // 当前阅读的不在筛选结果里就落到第一条；宽屏下右侧不留空，手机上留在内容树（SPEC-library-1.15）
  const current: Doc | null = model.rows.find((r) => r.id === reading) ?? null
  const ready = dir ? !!files.data : !!docs.data
  useEffect(() => {
    if (ready && !current && model.rows.length && wide()) update({ doc: model.rows[0].id })
  }, [ready, current, model.rows, update])

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

  const source = dir ? files : docs
  let status = null
  if (dirId && !dirs.data) status = dirs.isError ? <TreeError error={dirs.error} onRetry={() => void dirs.refetch()} /> : <LoadingState />
  else if (!source.data) {
    status = source.isError
      ? <TreeError error={source.error} onRetry={() => void source.refetch()} gone={!!dir && isApiError(source.error, 'not_found')} />
      : <LoadingState />
  }

  const kicker = dir && files.data && (files.data.skipped > 0 || files.data.truncated)
    ? {
      text: files.data.truncated ? '只列了前 1000 个' : `跳过 ${files.data.skipped} 个`,
      title: [
        files.data.skipped ? `跳过了 ${files.data.skipped} 个非文本文件` : '',
        files.data.truncated ? '文件太多，超出的没有列出' : '',
      ].filter(Boolean).join('；'),
    }
    : undefined

  const removeDir = (id: string) => {
    setDirError('')
    unmount.mutate(id, {
      onSuccess: () => { if (id === dirId) switchWs(BUILTIN) },
      onError: (e) => setDirError(`移除失败：${errorText(e)}`),
    })
  }

  const mode = reading ? 'reader' : 'tree'

  return (
    <div className="docs-mod" data-lib={mode}>
      <LibraryBar model={model} kind={kind} onKind={setKind} tags={tags} onTags={setTags} tagOptions={tagOptions}
        onRefresh={() => void notify({ kind: 'local-dir' })} refreshing={files.isFetching}
        readAt={files.dataUpdatedAt ? timeAgo(files.dataUpdatedAt) : ''} />
      <InSubnavHost>
        <LibraryTree ws={ws} model={model} filter={filter} dirs={dirs.data ?? []} selected={reading}
          onSelect={(id) => update({ doc: id })} onSwitch={switchWs}
          onAddFolder={() => { setDirError(''); setMounting(true) }} onRemoveFolder={removeDir}
          q={q} onQ={setQ} status={status} kicker={kicker} error={dirError} mode={mode} />
      </InSubnavHost>
      <LibraryReader model={model} current={current} statusLabel={statusLabel} onBack={() => update({ doc: null })}
        onStar={(d) => star.mutate({ id: d.id, on: !d.starred })} starring={star.isPending} />
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
