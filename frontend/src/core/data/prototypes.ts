// 项目原型（PJ-04b）：/api/projects/{id}/prototypes，契约见 docs/api-contract.md「项目原型」（PJ-04a）。
// 定义落库，状态和日志在服务进程内存里；后端这几个写操作不发事件，所以状态和日志都靠轮询：
// 列表在有原型启动中时每秒、运行中时每 3 秒取一次（看得到启动完成和崩溃），日志按 after=last_seq 只取新增的行。
// 增删改、启停报 { kind: 'project-prototype' }，刷这个项目的原型列表和打开着的日志。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestEnvelope, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

/** 契约里的四种；停止是同步等进程退出的，「停止中」只是界面上等接口返回的那一会儿 */
export type PrototypeStatus = 'stopped' | 'starting' | 'running' | 'crashed'

/** 显示名和颜色，顺序同原型 PROTO_STATUS；stopping 只在界面上用 */
export const PROTOTYPE_STATUS: Record<PrototypeStatus | 'stopping', { label: string; color: string }> = {
  stopped: { label: '已停止', color: 'var(--faint)' },
  starting: { label: '启动中', color: 'var(--accent)' },
  running: { label: '运行中', color: 'var(--ok)' },
  stopping: { label: '停止中', color: 'var(--warn)' },
  crashed: { label: '崩溃', color: 'var(--danger)' },
}

export type PrototypeCrash = {
  id: number
  prototype_id: string
  project_id: string
  exit_code: number
  signal: string
  reason: string
  /** 这次运行最后 50 行 */
  log: string[]
  started_at: string
  exited_at: string
}

export type ProjectPrototype = {
  id: string
  project_id: string
  name: string
  /** 绝对路径 */
  dir: string
  command: string
  argv: string[]
  port: number
  url: string
  status: PrototypeStatus
  error: string
  pid: number
  started_at: string | null
  last_crash: PrototypeCrash | null
  created_at: string
  updated_at: string
}

export type PrototypeLogLine = { seq: number; at: string; text: string }

/** 前端攒下的日志：lastSeq 是已拿到的最后一行，下次只要比它新的 */
export type PrototypeLogs = { lines: PrototypeLogLine[]; lastSeq: number; status: PrototypeStatus | '' }

export type PrototypeInput = { name?: string; dir: string; command: string; port: number }
export type PrototypePatch = { name?: string; dir?: string; command?: string; port?: number }

/** 后端每个原型最多留这么多行，前端也只攒这么多 */
export const PROTOTYPE_LOG_MAX = 1000
/** 轮询间隔：启动中、运行中 */
export const PROTOTYPE_POLL_STARTING_MS = 1000
export const PROTOTYPE_POLL_RUNNING_MS = 3000
/** 日志框开着、原型在跑时多久取一次新行 */
export const PROTOTYPE_LOG_POLL_MS = 1000

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/prototypes`
const one = (id: string, pid: string) => `${base(id)}/${encodeURIComponent(pid)}`

type LogMeta = { last_seq?: number; status?: PrototypeStatus | '' }

export const prototypesApi = {
  list: async (id: string, signal?: AbortSignal) => (await requestList<ProjectPrototype>(base(id), { signal })).data,
  add: (id: string, body: PrototypeInput) => request<ProjectPrototype>('POST', base(id), { body }),
  patch: (id: string, pid: string, body: PrototypePatch) => request<ProjectPrototype>('PATCH', one(id, pid), { body }),
  remove: (id: string, pid: string) => request<null>('DELETE', one(id, pid)),
  start: (id: string, pid: string) => request<ProjectPrototype>('POST', `${one(id, pid)}/start`),
  stop: (id: string, pid: string) => request<ProjectPrototype>('POST', `${one(id, pid)}/stop`),
  /** after=0 时取最新的 limit 行 */
  logs: async (id: string, pid: string, after: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ after: String(after), limit: String(PROTOTYPE_LOG_MAX) })
    const r = await requestEnvelope<PrototypeLogLine[] | null>('GET', `${one(id, pid)}/logs`, { query, signal })
    const meta = (r.meta ?? {}) as LogMeta
    return { lines: r.data ?? [], lastSeq: meta.last_seq ?? 0, status: meta.status ?? '' }
  },
}

/** 原型列表该多久再取：有启动中的每秒，有运行中的每 3 秒，都停着不轮询 */
export function prototypesPollMs(rows: readonly ProjectPrototype[] | undefined): number | false {
  if (!rows?.length) return false
  if (rows.some((p) => p.status === 'starting')) return PROTOTYPE_POLL_STARTING_MS
  if (rows.some((p) => p.status === 'running')) return PROTOTYPE_POLL_RUNNING_MS
  return false
}

/** 新取到的行接到攒下的后面，按 seq 去重，只留最后 PROTOTYPE_LOG_MAX 行 */
export function mergeLogs(prev: PrototypeLogLine[], next: PrototypeLogLine[]): PrototypeLogLine[] {
  const last = prev.length ? prev[prev.length - 1].seq : 0
  const out = [...prev, ...next.filter((l) => l.seq > last)]
  return out.length > PROTOTYPE_LOG_MAX ? out.slice(out.length - PROTOTYPE_LOG_MAX) : out
}

/** 一个项目的原型，按添加先后；有原型在启动、在跑时自己轮询 */
export function useProjectPrototypes(projectId: string) {
  return useQuery({
    queryKey: dataKeys.projectPrototypes.list(projectId),
    queryFn: ({ signal }) => prototypesApi.list(projectId, signal),
    refetchInterval: (q) => prototypesPollMs(q.state.data),
  })
}

/**
 * 一个原型的日志。enabled 时取，live 时每秒取一次新行（只取 seq 比已有的大的）。
 * 后端停用插件会清空日志、seq 从头算，这时 last_seq 比已有的小，整份重取。
 */
export function usePrototypeLogs(projectId: string, protoId: string, { enabled, live }: { enabled: boolean; live: boolean }) {
  const qc = useQueryClient()
  const key = dataKeys.projectPrototypes.logs(projectId, protoId)
  return useQuery({
    queryKey: key,
    enabled,
    refetchInterval: enabled && live ? PROTOTYPE_LOG_POLL_MS : false,
    queryFn: async ({ signal }): Promise<PrototypeLogs> => {
      const prev = qc.getQueryData<PrototypeLogs>(key)
      const r = await prototypesApi.logs(projectId, protoId, prev?.lastSeq ?? 0, signal)
      if (!prev) return r
      if (r.lastSeq < prev.lastSeq) return prototypesApi.logs(projectId, protoId, 0, signal)
      return { lines: mergeLogs(prev.lines, r.lines), lastSeq: Math.max(prev.lastSeq, r.lastSeq), status: r.status }
    },
  })
}

export function useAddPrototype(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (body: PrototypeInput) => prototypesApi.add(projectId, body),
    onSuccess: () => notify({ kind: 'project-prototype', projectId }),
  })
}

export function usePatchPrototype(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ protoId, patch }: { protoId: string; patch: PrototypePatch }) => prototypesApi.patch(projectId, protoId, patch),
    onSuccess: () => notify({ kind: 'project-prototype', projectId }),
  })
}

export function useRemovePrototype(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (protoId: string) => prototypesApi.remove(projectId, protoId),
    onSuccess: () => notify({ kind: 'project-prototype', projectId }),
  })
}

/** 启动、停止：失败（409 冲突、400 命令找不到）时也刷一次，状态以后端为准 */
export function useStartPrototype(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (protoId: string) => prototypesApi.start(projectId, protoId),
    onSettled: () => notify({ kind: 'project-prototype', projectId }),
  })
}

export function useStopPrototype(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (protoId: string) => prototypesApi.stop(projectId, protoId),
    onSettled: () => notify({ kind: 'project-prototype', projectId }),
  })
}
