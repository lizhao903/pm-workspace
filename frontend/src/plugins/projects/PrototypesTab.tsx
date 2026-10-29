// 原型标签（SPEC-projects-12，PJ-04b）：原型卡片的启停、状态、日志、端口编辑和冲突提示。
// 数据走项目插件的 /api/projects/{id}/prototypes（PJ-04a）。状态和日志靠轮询（后端不发事件）：列表在有原型启动中、运行中时自己刷，
// 日志框开着且原型在跑时每秒取新增的行。后端只收绝对路径，目录按项目目录换算；保留端口、别的项目和本机占用由后端判断，原因原样显示。
// 「打开」在新窗口开原型地址；项目内的浏览器（SPEC-projects-14）另做。内网域名还没有后端，卡片上不显示。
import { useEffect, useRef, useState } from 'react'
import {
  PROTOTYPE_STATUS, errorText, useAddPrototype, usePatchPrototype, usePrototypeLogs, useProjectPrototypes, useRemovePrototype,
  useStartPrototype, useStopPrototype, type ProjectPrototype, type PrototypePatch,
} from '../../core/data'
import { Button, EmptyState, ErrorState, Field, Input, LoadingState, Pill, cls } from '../../core/ui'
import { ago } from './model'
import {
  DEFAULT_COMMAND, PROTO_PEEK, STOPPED_FOLD, absDir, defaultPort, portConflict, relDir, runningFor, sortProtos, startLabel, type ProtoView,
} from './protoModel'

const NEED_ABS = '没设项目目录，目录要填绝对路径（以 / 开头），或先在设置里填本地项目目录'

type Draft = { name: string; port: string; dir: string; command: string }

/** 表单里的端口：空或不是整数时给 NaN，冲突检查报范围 */
const portOf = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)

export function PrototypesTab({ projectId, projectName, root, adding, onAdding }: {
  projectId: string
  projectName: string
  /** 项目目录，相对目录按它补全 */
  root: string
  /** 加原型的内联表单开着没有；右上「加原型」打开 */
  adding: boolean
  onAdding: (on: boolean) => void
}) {
  const list = useProjectPrototypes(projectId)
  const [showStopped, setShowStopped] = useState(false)
  const rows = list.data ?? []

  let body
  if (list.isError) body = <ErrorState title="原型没加载出来" error={errorText(list.error)} onRetry={() => void list.refetch()} />
  else if (list.isPending) body = <LoadingState />
  else if (!rows.length) {
    body = !adding && <EmptyState title="还没有原型" desc="配好目录、启动命令和端口，就能在这里一键启停" action={<Button variant="primary" onClick={() => onAdding(true)}>加原型</Button>} />
  } else {
    const sorted = sortProtos(rows)
    const stopped = sorted.filter((p) => p.status === 'stopped')
    const fold = stopped.length > STOPPED_FOLD
    const card = (p: ProjectPrototype) => <ProtoCard key={p.id} p={p} rows={rows} projectId={projectId} projectName={projectName} root={root} />
    body = (
      <div className="pj-proto-list" aria-label="原型">
        {sorted.filter((p) => !fold || p.status !== 'stopped').map(card)}
        {fold && (
          <button type="button" className="pj-proto-fold" aria-expanded={showStopped} onClick={() => setShowStopped(!showStopped)}>
            <span className="pj-proto-light" />已停止 {stopped.length} 个<span className="spacer" /><span className="pj-muted">{showStopped ? '收起' : '展开'}</span>
          </button>
        )}
        {fold && showStopped && stopped.map(card)}
      </div>
    )
  }

  return (
    <div className="pj-tab">
      {!root.trim() && <div className="pj-mount-empty">先在「设置」里填项目目录，原型的目录相对它来算</div>}
      {adding && list.isSuccess && <AddForm projectId={projectId} projectName={projectName} root={root} rows={rows} onClose={() => onAdding(false)} />}
      {body}
    </div>
  )
}

function AddForm({ projectId, projectName, root, rows, onClose }: {
  projectId: string; projectName: string; root: string; rows: ProjectPrototype[]; onClose: () => void
}) {
  const add = useAddPrototype(projectId)
  const [d, setD] = useState<Draft>(() => ({ name: '', port: String(defaultPort(rows)), dir: '', command: DEFAULT_COMMAND }))
  const [err, setErr] = useState('')
  const conflict = portConflict(portOf(d.port), '', rows, projectName)
  const put = (patch: Partial<Draft>) => setD({ ...d, ...patch })

  const submit = () => {
    const dir = absDir(d.dir, root)
    if (dir === null) { setErr(NEED_ABS); return }
    setErr('')
    add.mutate({ name: d.name.trim(), dir, command: d.command.trim(), port: portOf(d.port) }, {
      onSuccess: onClose,
      onError: (e) => setErr(`没加上：${errorText(e)}`),
    })
  }

  return (
    <div className="pj-inline-form" role="group" aria-label="加原型">
      <div className="pj-proto-row">
        <Input aria-label="名称" className="pj-grow" value={d.name} placeholder="原型名称，比如：权限配置原型" onChange={(e) => put({ name: e.target.value })} />
        <Input aria-label="端口" className="pj-proto-port" inputMode="numeric" value={d.port} invalid={!!conflict} onChange={(e) => put({ port: e.target.value })} />
      </div>
      <Input aria-label="目录" className="mono" value={d.dir} spellCheck={false} placeholder="目录（相对项目目录），比如 prototype" onChange={(e) => put({ dir: e.target.value })} />
      <Input aria-label="启动命令" className="mono" value={d.command} spellCheck={false} placeholder="启动命令" onChange={(e) => put({ command: e.target.value })} />
      {conflict && <span className="field-err">{conflict}</span>}
      {err && <div className="pj-err" role="alert">{err}</div>}
      <div className="pj-act-row">
        <Button variant="primary" disabled={!d.name.trim() || !d.command.trim() || add.isPending} onClick={submit}>加上</Button>
        <Button onClick={onClose}>取消</Button>
        <span className="pj-muted pj-wrap">端口默认给一个没被占用的；目录留空就是项目目录</span>
      </div>
    </div>
  )
}

function ProtoCard({ p, rows, projectId, projectName, root }: {
  p: ProjectPrototype; rows: ProjectPrototype[]; projectId: string; projectName: string; root: string
}) {
  const start = useStartPrototype(projectId)
  const stop = useStopPrototype(projectId)
  const remove = useRemovePrototype(projectId)
  const [edit, setEdit] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  // 有没有日志：和日志框同一份缓存，状态一变（启动完成、停下、崩溃）补取一次，收尾的那行不会漏
  const logs = usePrototypeLogs(projectId, p.id, { enabled: true, live: false })
  const { refetch: refetchLogs } = logs
  const seenStatus = useRef(p.status)
  useEffect(() => {
    if (seenStatus.current === p.status) return
    seenStatus.current = p.status
    void refetchLogs()
  }, [p.status, refetchLogs])
  // 启动、停止、移除被后端拒绝的原因（409 冲突、400 命令找不到），原样显示，下次操作前清掉
  const [actErr, setActErr] = useState('')
  const status: ProtoView = stop.isPending ? 'stopping' : start.isPending ? 'starting' : p.status
  const busy = status === 'starting' || status === 'stopping'
  const live = status === 'running'
  const conflict = !live && !busy ? portConflict(p.port, p.id, rows, projectName) : null
  const now = useNow(live ? 30000 : 0)
  const crash = p.status === 'crashed' ? p.last_crash : null
  // 没有日志时「看日志」置灰（SPEC-projects-12.14）；在跑的随时会有输出，取不到时也不拦着
  const noLogs = !live && !busy && !!logs.data && !logs.data.lastSeq && !logs.data.lines.length

  const act = (m: { mutate: (id: string, o: { onError: (e: Error) => void }) => void }) => { setActErr(''); m.mutate(p.id, { onError: (e) => setActErr(errorText(e)) }) }

  return (
    <div className={cls('pj-proto', `pj-proto-${status}`)} role="group" aria-label={p.name}>
      <div className="pj-proto-head">
        <span className={cls('pj-proto-light', `pj-pl-${status}`)} />
        <span className="pj-proto-name">{p.name}</span>
        <Pill label={PROTOTYPE_STATUS[status].label} color={PROTOTYPE_STATUS[status].color} />
        <span className="spacer" />
        {live && <a className="btn btn-outline btn-sm" href={p.url} target="_blank" rel="noreferrer" title="在新窗口打开">打开 :{p.port}</a>}
        {live || status === 'stopping'
          ? <Button size="sm" disabled={busy} onClick={() => act(stop)}>{status === 'stopping' ? '停止中…' : '停止'}</Button>
          : <Button size="sm" variant="primary" disabled={busy || !!conflict} title={conflict ?? undefined} onClick={() => act(start)}>{startLabel(status)}</Button>}
      </div>
      <div className="pj-proto-meta">
        <span><span className="pj-proto-k">目录</span><code title={p.dir}>{p.dir}</code></span>
        <span><span className="pj-proto-k">命令</span><code>{p.command}</code></span>
        <span><span className="pj-proto-k">端口</span><code>{p.port}</code></span>
        {live && p.started_at && <span><span className="pj-proto-k">已运行</span>{runningFor(p.started_at, now)}</span>}
      </div>
      {conflict && <div className="pj-proto-warn">{conflict}，换一个端口再启动</div>}
      {actErr && <div className="pj-proto-warn" role="alert">{actErr}</div>}
      {p.status === 'crashed' && p.error && <div className="pj-proto-warn">{p.error}</div>}
      {p.status === 'stopped' && p.error && <div className="pj-muted pj-wrap">{p.error}</div>}
      {crash && (
        <div className="pj-proto-crash" aria-label="崩溃时的输出">
          <div className="pj-muted pj-wrap">
            {crash.signal ? `被信号 ${crash.signal} 结束` : `退出码 ${crash.exit_code}`} · {ago(crash.exited_at)} · 最后 {crash.log.length} 行输出
          </div>
          {crash.log.length > 0 && <pre className="pj-proto-logs">{crash.log.join('\n')}</pre>}
        </div>
      )}
      <div className="pj-act-row pj-proto-acts">
        <Button size="sm" disabled={noLogs && !logsOpen} title={noLogs ? '还没有日志' : undefined} onClick={() => setLogsOpen(!logsOpen)} aria-expanded={logsOpen}>{logsOpen ? '收起日志' : '看日志'}</Button>
        <Button size="sm" disabled={live || busy} title={live ? '先停下来再改' : undefined} onClick={() => setEdit(!edit)}>{edit ? '收起设置' : '修改'}</Button>
        <span className="spacer" />
        <Button size="sm" variant="danger-ghost" disabled={live || busy || remove.isPending} onClick={() => act(remove)}>移除</Button>
      </div>
      {logsOpen && <ProtoLogs projectId={projectId} p={p} />}
      {edit && !live && !busy && <EditForm p={p} rows={rows} projectId={projectId} projectName={projectName} root={root} onClose={() => setEdit(false)} />}
    </div>
  )
}

/** 每隔 ms 刷一次「现在」，给已运行时长用；0 不刷 */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ms) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** 日志框：在跑时每秒取新增的行；停下、崩溃时再取一次收尾的那行。滚到底时跟着新行走，往上翻了就不动 */
function ProtoLogs({ projectId, p }: { projectId: string; p: ProjectPrototype }) {
  const live = p.status === 'starting' || p.status === 'running'
  const logs = usePrototypeLogs(projectId, p.id, { enabled: true, live })
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const n = logs.data?.lines.length ?? 0
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [n])

  if (logs.isError) return <ErrorState compact error={errorText(logs.error)} onRetry={() => void logs.refetch()} />
  if (logs.isPending) return <div className="pj-muted">日志加载中</div>
  if (!n) return <div className="pj-mount-empty">还没有日志，启动后这里实时显示输出</div>
  return (
    <pre ref={box} className="pj-proto-logs" aria-label="日志" aria-live="polite"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
      {logs.data!.lines.map((l) => l.text).join('\n')}
    </pre>
  )
}

function EditForm({ p, rows, projectId, projectName, root, onClose }: {
  p: ProjectPrototype; rows: ProjectPrototype[]; projectId: string; projectName: string; root: string; onClose: () => void
}) {
  const save = usePatchPrototype(projectId)
  const [d, setD] = useState<Draft>(() => ({ name: p.name, port: String(p.port), dir: relDir(p.dir, root), command: p.command }))
  const [err, setErr] = useState('')
  const conflict = portConflict(portOf(d.port), p.id, rows, projectName)
  const put = (patch: Partial<Draft>) => setD({ ...d, ...patch })

  const submit = () => {
    const dir = absDir(d.dir, root)
    if (dir === null) { setErr(NEED_ABS); return }
    const patch: PrototypePatch = {}
    if (d.name.trim() !== p.name) patch.name = d.name.trim()
    if (dir !== p.dir) patch.dir = dir
    if (d.command.trim() !== p.command) patch.command = d.command.trim()
    if (portOf(d.port) !== p.port) patch.port = portOf(d.port)
    if (!Object.keys(patch).length) { onClose(); return }
    setErr('')
    save.mutate({ protoId: p.id, patch }, { onSuccess: onClose, onError: (e) => setErr(`没保存：${errorText(e)}`) })
  }

  return (
    <div className="pj-proto-edit" role="group" aria-label="修改原型">
      <div className="pj-proto-row">
        <Field label="名称" className="pj-grow"><Input value={d.name} onChange={(e) => put({ name: e.target.value })} /></Field>
        <Field label="端口" className="pj-proto-port"><Input inputMode="numeric" value={d.port} invalid={!!conflict} onChange={(e) => put({ port: e.target.value })} /></Field>
      </div>
      <Field label="目录" hint={root.trim() ? `相对项目目录 ${root.trim()}，留空就是项目目录` : '没设项目目录，要填绝对路径'}>
        <Input className="mono" value={d.dir} spellCheck={false} onChange={(e) => put({ dir: e.target.value })} />
      </Field>
      <Field label="启动命令"><Input className="mono" value={d.command} spellCheck={false} onChange={(e) => put({ command: e.target.value })} /></Field>
      {conflict && <span className="field-err">{conflict}</span>}
      {err && <div className="pj-err" role="alert">{err}</div>}
      <div className="pj-act-row">
        <Button variant="primary" size="sm" disabled={!d.name.trim() || !d.command.trim() || save.isPending} onClick={submit}>保存</Button>
        <Button size="sm" onClick={onClose}>取消</Button>
      </div>
    </div>
  )
}

/** 标签条「原型」上的绿灯：有运行中的原型时亮（SPEC-projects-2.3） */
export function ProtoTabLight({ projectId }: { projectId: string }) {
  const list = useProjectPrototypes(projectId)
  const n = (list.data ?? []).filter((p) => p.status === 'running').length
  return n ? <span className="pj-tab-light" title={`${n} 个原型在运行`} /> : null
}

/** 概览的数字卡片「原型运行中 运行数 / 总数」（SPEC-projects-3.1） */
export function ProtoStat({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const list = useProjectPrototypes(projectId)
  const rows = list.data
  return (
    <button type="button" className="pj-stat" onClick={onOpen}>
      <span className="pj-stat-label">原型运行中</span>
      <span className="pj-stat-value ok">{rows ? `${rows.filter((p) => p.status === 'running').length} / ${rows.length}` : '-'}</span>
    </button>
  )
}

/** 概览的「原型」块（SPEC-projects-3.7）：排好序的前 PROTO_PEEK 个，按钮文字和卡片一致 */
export function ProtoBlock({ projectId, projectName, onAll }: { projectId: string; projectName: string; onAll: () => void }) {
  const list = useProjectPrototypes(projectId)
  const rows = list.data ?? []
  return (
    <section className="pj-block" aria-label="原型">
      <div className="pj-block-head">
        <h2 className="pj-sec-title">原型{rows.length > PROTO_PEEK && <span className="pj-hint">共 {rows.length} 个</span>}</h2>
        {rows.length > 0 && <button type="button" className="pj-link" onClick={onAll}>全部</button>}
      </div>
      {list.isError ? <ErrorState compact error={errorText(list.error)} onRetry={() => void list.refetch()} />
        : list.isPending ? <div className="pj-block-empty">加载中</div>
          : rows.length ? (
            <ul className="pj-lines">
              {sortProtos(rows).slice(0, PROTO_PEEK).map((p) => <li key={p.id}><ProtoLine p={p} rows={rows} projectId={projectId} projectName={projectName} /></li>)}
            </ul>
          ) : <div className="pj-block-empty">还没有原型</div>}
    </section>
  )
}

function ProtoLine({ p, rows, projectId, projectName }: { p: ProjectPrototype; rows: ProjectPrototype[]; projectId: string; projectName: string }) {
  const start = useStartPrototype(projectId)
  const stop = useStopPrototype(projectId)
  const [err, setErr] = useState('')
  const status: ProtoView = stop.isPending ? 'stopping' : start.isPending ? 'starting' : p.status
  const busy = status === 'starting' || status === 'stopping'
  const conflict = status !== 'running' && !busy ? portConflict(p.port, p.id, rows, projectName) : null
  const onErr = { onError: (e: Error) => setErr(errorText(e)) }
  return (
    <div className="pj-proto-line" title={err || undefined}>
      <span className={cls('pj-proto-light', `pj-pl-${status}`)} />
      <span className="ellipsis">{p.name}</span><code>:{p.port}</code>
      {err && <span className="pj-err ellipsis" role="alert">{err}</span>}
      <span className="spacer" />
      {status === 'running' ? (
        <>
          <a className="btn btn-ghost btn-sm" href={p.url} target="_blank" rel="noreferrer" title="在新窗口打开">打开</a>
          <Button size="sm" variant="outline" onClick={() => { setErr(''); stop.mutate(p.id, onErr) }}>停止</Button>
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={busy || !!conflict} title={conflict ?? undefined} onClick={() => { setErr(''); start.mutate(p.id, onErr) }}>
          {startLabel(status)}
        </Button>
      )}
    </div>
  )
}
