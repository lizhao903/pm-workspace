// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 原型标签的纯函数（SPEC-projects-12）：排序、已停止折叠、默认端口、本项目内的端口冲突、目录的相对和绝对换算。
// 保留端口、别的项目占着、本机别的程序占着由后端在新增、修改、启动时判断，原因原样显示。
import type { ProjectPrototype } from '../../core/data'
import { resolvePath } from './materialModel'

/** 概览里露几个原型（SPEC-projects-3.7） */
export const PROTO_PEEK = 5
/** 原型标签：已停止的多于这么多个就折叠（SPEC-projects-12.7） */
export const STOPPED_FOLD = 6
/** 新原型的默认命令 */
export const DEFAULT_COMMAND = 'npm run dev'
/** 默认端口从这里找起；7780 是正式前端的开发服务（后端保留），从下一个开始 */
export const PORT_FROM = 7781
export const PORT_TO = 7899

/** 界面上的状态：多一个「停止中」，是点了停止、接口还没返回的那一会儿 */
export type ProtoView = ProjectPrototype['status'] | 'stopping'

const RANK: Record<ProtoView, number> = { running: 0, external: 0, crashed: 1, starting: 2, stopping: 2, stopped: 3 }

/** 运行中（含外部启动）、崩溃、启停中、已停止；同状态按加入顺序（接口按添加先后返回，sort 稳定） */
export const sortProtos = <T extends { status: ProtoView }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => RANK[a.status] - RANK[b.status])

/** 默认端口：PORT_FROM 到 PORT_TO 里第一个本项目原型没用着的，都占满时给 PORT_TO */
export function defaultPort(rows: readonly Pick<ProjectPrototype, 'port'>[]): number {
  const used = new Set(rows.map((p) => p.port))
  for (let p = PORT_FROM; p <= PORT_TO; p++) if (!used.has(p)) return p
  return PORT_TO
}

/**
 * 前端能先说的端口问题：不在范围里，或本项目另一个启动中、运行中的原型占着。
 * 返回 null 表示前端看不出问题（后端还会查保留端口、别的项目和本机占用）。
 */
export function portConflict(port: number, selfId: string, rows: readonly ProjectPrototype[], projectName: string): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return '端口要在 1024 到 65535 之间'
  const o = rows.find((p) => p.id !== selfId && p.port === port && (p.status === 'running' || p.status === 'starting'))
  return o ? `${port} 端口被「${projectName} / ${o.name}」占着` : null
}

/** 表单里显示的目录：在项目目录下的给相对路径（项目目录本身是空串），否则原样给绝对路径 */
export function relDir(dir: string, root: string): string {
  const r = root.trim().replace(/\/+$/, '')
  if (!r) return dir
  if (dir === r) return ''
  return dir.startsWith(`${r}/`) ? dir.slice(r.length + 1) : dir
}

/** 存进去的绝对路径：空串是项目目录本身；相对路径拼上项目目录；没设项目目录又填了相对路径时返回 null */
export function absDir(v: string, root: string): string | null {
  const t = v.trim()
  if (!t || t === '.') return root.trim().replace(/\/+$/, '') || null
  return resolvePath(t, root)
}

/** 已运行多久：不到一分钟「不到 1 分钟」，否则 N 分钟、N 小时 M 分钟、N 天 M 小时 */
export function runningFor(startedAt: string, now = Date.now()): string {
  const t = new Date(startedAt).getTime()
  if (Number.isNaN(t)) return '-'
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return '不到 1 分钟'
  if (m < 60) return `${m} 分钟`
  if (m < 1440) return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`
  const h = Math.floor((m % 1440) / 60)
  return `${Math.floor(m / 1440)} 天${h ? ` ${h} 小时` : ''}`
}

/** 按钮文字和原型卡片一致：已停止「启动」、崩溃「重新启动」、启停中显示状态 */
export function startLabel(s: ProtoView): string {
  return s === 'crashed' ? '重新启动' : s === 'starting' ? '启动中…' : s === 'stopping' ? '停止中…' : '启动'
}
