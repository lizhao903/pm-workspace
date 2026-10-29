// 终端（TERM-01b）：终端插件 terminal 的会话接口，契约见 docs/api-contract.md「终端插件 terminal」（TERM-01a）。
// 会话只在服务进程内存里：新建、结束报 { kind: 'terminal-session' }；收发走 WebSocket，地址由 terminalSocketUrl 拼。
// 终端页要按目录认出项目原型，原型列表跨全部项目取一份，启停经这里调项目插件的接口（终端不 import 项目插件）。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { apiBase } from '../api/client'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { PROJECT_TYPE } from './projects'
import { listAllObjects } from './objects'
import { prototypesApi, prototypesPollMs, type ProjectPrototype } from './prototypes'

export type TerminalSession = {
  /** pn_ 加 32 位十六进制，不可猜 */
  id: string
  cwd: string
  shell: string
  cols: number
  rows: number
  pid: number
  status: 'running' | 'exited'
  /** 退出后才有；被信号结束是 -1 */
  exit_code: number | null
  /** 累计输出字节数，也是 WebSocket 的字节位置 */
  output_bytes: number
  created_at: string
  exited_at: string | null
}

export type TerminalSessionInput = { cwd?: string; cols?: number; rows?: number }

/** 后端同时最多这么多个 running 的会话，再建 409 */
export const TERMINAL_MAX_SESSIONS = 16

const base = '/api/terminal/sessions'

export const terminalApi = {
  list: async (signal?: AbortSignal) => (await requestList<TerminalSession>(base, { signal })).data,
  create: (body: TerminalSessionInput) => request<TerminalSession>('POST', base, { body }),
  remove: (id: string) => request<null>('DELETE', `${base}/${encodeURIComponent(id)}`),
}

/** WebSocket 地址：跟着接口地址走（默认同源）；after 是已收到的字节位置，只补发这之后的输出 */
export function terminalSocketUrl(id: string, after?: number, origin = globalThis.location?.origin ?? 'http://127.0.0.1') {
  const u = new URL(`${apiBase() || origin}${base}/${encodeURIComponent(id)}/ws`)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  if (after !== undefined && after > 0) u.searchParams.set('after', String(after))
  return u.toString()
}

/** 全部终端会话，按创建先后，含已退出的 */
export function useTerminalSessions() {
  return useQuery({ queryKey: dataKeys.terminal.sessions, queryFn: ({ signal }) => terminalApi.list(signal) })
}

/** 一个原型加上它属于的项目 */
export type TerminalPrototype = ProjectPrototype & { project_title: string }

async function allPrototypes(signal: AbortSignal): Promise<TerminalPrototype[]> {
  const projects = (await listAllObjects({ type: [PROJECT_TYPE] }, signal)).data
  // 单个项目取不到（项目插件停用、项目刚删）不拖累别的
  const lists = await Promise.all(projects.map((p) => prototypesApi.list(p.id, signal).catch(() => [] as ProjectPrototype[])))
  return projects.flatMap((p, i) => lists[i].map((x) => ({ ...x, project_title: p.title })))
}

/** 原型在别处启停时终端也要跟着变：有在跑的按原型的节奏轮询，都停着每 10 秒看一次 */
export const TERMINAL_PROTO_IDLE_MS = 10_000

export function useTerminalPrototypes() {
  return useQuery({
    queryKey: dataKeys.terminal.prototypes,
    queryFn: ({ signal }) => allPrototypes(signal),
    refetchInterval: (q) => prototypesPollMs(q.state.data) || TERMINAL_PROTO_IDLE_MS,
  })
}

/** 从终端启停项目原型：失败也刷一次，状态以后端为准 */
export function useTerminalProtoAction() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ projectId, protoId, action }: { projectId: string; protoId: string; action: 'start' | 'stop' }) =>
      action === 'start' ? prototypesApi.start(projectId, protoId) : prototypesApi.stop(projectId, protoId),
    onSettled: (_d, _e, v) => notify({ kind: 'project-prototype', projectId: v.projectId }),
  })
}
