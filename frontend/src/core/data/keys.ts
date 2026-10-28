// 缓存键（CORE-03a）。所有查询键都在这里生成，按资源分前缀，失效规则（invalidate.ts）按前缀刷新。
// 对象列表一律挂在 ['objects', 'list'] 下：任务列表、今日、项目的任务标签页都是它，改了对象一起刷新。
import type { ArtifactListParams, ObjectListParams } from '../api'

type Filter = Record<string, unknown>

/**
 * 过滤条件归一：去掉空值（undefined、null、空串、false、空数组），键按字母排。
 * 同一个过滤条件不管字段顺序、写没写默认值，生成的缓存键都一样。
 */
export function normFilter<T extends object>(f: T | undefined): Filter {
  const out: Filter = {}
  if (!f) return out
  for (const k of Object.keys(f).sort()) {
    const v = (f as Filter)[k]
    if (v === undefined || v === null || v === '' || v === false) continue
    if (Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return out
}

export const dataKeys = {
  health: ['health'] as const,
  objectTypes: ['object-types'] as const,
  dictionaries: {
    all: ['dictionaries'] as const,
    list: (withItems = false) => ['dictionaries', 'list', { withItems }] as const,
    items: (dictId: string) => ['dictionaries', dictId, 'items'] as const,
  },
  stakeholders: {
    all: ['stakeholders'] as const,
    list: (archived = false) => ['stakeholders', 'list', { archived }] as const,
  },
  objects: {
    all: ['objects'] as const,
    lists: ['objects', 'list'] as const,
    /** 一页；分页参数也进键 */
    list: (f?: ObjectListParams) => ['objects', 'list', normFilter(f)] as const,
    /** 按页拉完的整份，和单页分开缓存 */
    listAll: (f?: Omit<ObjectListParams, 'limit' | 'offset'>) => ['objects', 'list', { ...normFilter(f), all: true }] as const,
    detail: (id: string) => ['objects', 'get', id] as const,
    progress: (id: string) => ['objects', 'progress', id] as const,
    revisions: (id: string) => ['objects', 'revisions', id] as const,
  },
  /** type 只收窄聚焦类计数器；不传是全局 */
  counts: {
    all: ['counts'] as const,
    of: (type?: string) => ['counts', type ?? ''] as const,
  },
  artifacts: {
    all: ['artifacts'] as const,
    list: (f?: ArtifactListParams) => ['artifacts', 'list', normFilter(f)] as const,
    stats: (f?: ArtifactListParams) => ['artifacts', 'stats', normFilter(f)] as const,
  },
  runs: {
    all: ['runs'] as const,
    list: (objectId: string) => ['runs', 'list', objectId] as const,
    detail: (id: string) => ['runs', 'get', id] as const,
  },
  workdir: (path: string) => ['agent', 'workdir', path] as const,
  fs: {
    browse: (path: string) => ['fs', 'browse', path] as const,
    shortcuts: ['fs', 'shortcuts'] as const,
  },
  plugins: {
    all: ['plugins'] as const,
    list: ['plugins', 'list'] as const,
  },
  /** 工作台（CORE-10b）：列表和只读的模板 */
  workspaces: {
    all: ['workspaces'] as const,
    list: ['workspaces', 'list'] as const,
    templates: ['workspaces', 'templates'] as const,
  },
  /** 文档页（DOC-01b）：分类树带数量，对象一变就跟着刷 */
  categories: {
    all: ['categories'] as const,
    tree: (type: string) => ['categories', 'tree', type] as const,
  },
  tags: {
    all: ['tags'] as const,
    list: ['tags', 'list'] as const,
  },
  /** 挂载的本地目录、目录里的文件清单、读过的文件，挂载变了一起刷 */
  localDirs: {
    all: ['local-dirs'] as const,
    list: ['local-dirs', 'list'] as const,
    files: (id: string) => ['local-dirs', 'files', id] as const,
    read: (path: string) => ['local-dirs', 'read', path] as const,
  },
  /** 定时任务的列表在 todayKeys.schedules（今日页共用）；这里是执行记录和规则预览 */
  schedules: {
    all: ['schedules'] as const,
    /** 一个定时任务的全部执行记录（各种条数）都在这个前缀下 */
    runsOf: (id: string) => ['schedules', 'runs', id] as const,
    runs: (id: string, limit: number) => ['schedules', 'runs', id, { limit }] as const,
    preview: (rule: unknown, count: number) => ['schedules', 'preview', { rule, count }] as const,
  },
  /** Webhook（TASK-04b）：列表、投递记录（各种条数都在 deliveriesOf 前缀下）、删除影响 */
  webhooks: {
    all: ['webhooks'] as const,
    list: ['webhooks', 'list'] as const,
    deliveriesOf: (id: string) => ['webhooks', 'deliveries', id] as const,
    deliveries: (id: string, limit: number) => ['webhooks', 'deliveries', id, { limit }] as const,
    usage: (id: string) => ['webhooks', 'usage', id] as const,
  },
}
