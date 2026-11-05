// 页面报错自动记成运行异常（INC-01b，SPEC-settings-18「页面本身出的问题」）。
// 四个入口：路由出错（「出错了」页，换版本自动刷新的检查之后仍是错误的才报）、全局 error、unhandledrejection、
// 分包加载失败但不是换版本。都调 POST /api/incidents/report，级别 error，模块取当前路由所属模块。
// 同一个错误（指纹）一次会话只报一次；上报失败静默，不再抛（免得上报自己的失败又触发 unhandledrejection）。
import { incidentsApi, type IncidentReport } from '../data'
import { moduleStore } from '../plugin'
import { currentEntry } from './staleBuild'

export type FrontErrorKind = 'route' | 'error' | 'rejection' | 'chunk'

const KIND_TEXT: Record<FrontErrorKind, string> = { route: '页面出错', error: '未捕获的异常', rejection: '未处理的 Promise', chunk: '分包加载失败' }
const SENT_KEY = 'pmw.reportedErrors'
/** sessionStorage 里最多记多少个指纹 */
const SENT_MAX = 100
const TITLE_MAX = 120
const FP_MAX = 160
/** 单条 32KB 上限，堆栈截到 8KB 足够定位 */
const STACK_MAX = 8_000
/** 不是缺陷、报了只会刷屏的浏览器噪音 */
const NOISE = [/^ResizeObserver loop/, /^Script error\.?$/]

/** 上报结果：ok 为 true 时这条已经在运行异常里了（这次报的，或这次会话之前报过）；id 拿得到时给链接带上 */
export type ReportResult = { ok: boolean; id?: string }

/** 当前地址所属的模块：按路径第一段找模块注册表；找不到（首页、不存在的地址）记「前端」 */
export function moduleOfPath(pathname: string): { path: string; label: string } {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  const m = seg ? moduleStore.list().find((x) => x.path === seg) : undefined
  return m ? { path: m.path, label: m.label } : { path: seg || 'app', label: '前端' }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message
  try { return JSON.stringify(err) ?? String(err) } catch { return String(err) }
}

function errStack(err: unknown): string | undefined {
  const s = err instanceof Error ? err.stack : undefined
  return s ? s.slice(0, STACK_MAX) : undefined
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)

/** 报错转成上报体（纯函数，测试直接用）。指纹 front:<模块路径>:<类别>:<报错第一行>，同一页同一个报错合并 */
export function frontReport(kind: FrontErrorKind, err: unknown, at: { pathname: string; search?: string; href?: string; entry?: string | null; where?: string; detail?: string }): IncidentReport {
  const msg = oneLine(errMessage(err), 2_000) || KIND_TEXT[kind]
  const mod = moduleOfPath(at.pathname)
  const head = oneLine(msg, FP_MAX)
  const title = kind === 'rejection' ? `未处理的 Promise 异常：${oneLine(msg, TITLE_MAX - 12)}`
    : kind === 'chunk' ? `分包加载失败：${oneLine(msg, TITLE_MAX - 8)}`
      : oneLine(msg, TITLE_MAX)
  const message = at.detail ? at.detail : kind === 'route' ? `打开「${mod.label}」页面时出错，页面停在「出错了」；已排除服务换了新版本`
    : kind === 'error' ? `${at.where ? `${at.where} ` : '页面脚本'}抛出未捕获的异常`
      : kind === 'rejection' ? '有异步操作失败了但没人处理'
        : '页面的代码分包没加载出来，服务器上的版本和页面一致，不是换版本'
  return {
    level: 'error',
    module: mod.label,
    title,
    message,
    stack: errStack(err) ?? (msg !== title ? msg : undefined),
    context: { 页面: `${at.pathname}${at.search ?? ''}`, 构建: at.entry ? at.entry.split('/').pop() : '开发服务器', 来源: KIND_TEXT[kind] },
    url: at.href,
    fingerprint: `front:${mod.path}:${kind === 'error' ? 'route' : kind}:${head}`,
  }
}

// ---- 一次会话只报一次 ----

const sent = new Map<string, Promise<ReportResult>>()

function sentBefore(fp: string): boolean {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(SENT_KEY) ?? '[]')
    return Array.isArray(v) && v.includes(fp)
  } catch { return false }
}

function markSent(fp: string) {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(SENT_KEY) ?? '[]')
    const xs = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== fp) : []
    sessionStorage.setItem(SENT_KEY, JSON.stringify([...xs, fp].slice(-SENT_MAX)))
  } catch { /* 存不了就只在这次页面里防重复 */ }
}

/** 测试用：清掉会话里记过的 */
export function resetReported() {
  sent.clear()
  try { sessionStorage.removeItem(SENT_KEY) } catch { /* 同上 */ }
}

/** 分包（JS、CSS）没加载出来：vite 预加载失败、动态 import 失败 */
export function isChunkError(err: unknown): boolean {
  return /dynamically imported module|Importing a module script failed|Unable to preload|Loading (CSS )?chunk/i.test(errMessage(err))
}

export function isNoise(err: unknown): boolean {
  const m = errMessage(err)
  return NOISE.some((r) => r.test(m))
}

/** 报一次；同一个指纹这次会话里只发一次请求，之后直接回第一次的结果 */
export function reportFrontError(kind: FrontErrorKind, err: unknown, where?: string, detail?: string): Promise<ReportResult> {
  if (isNoise(err)) return Promise.resolve({ ok: false })
  const body = frontReport(kind, err, {
    pathname: location.pathname, search: location.search, href: location.href, entry: currentEntry(), where, detail,
  })
  const fp = body.fingerprint!
  const had = sent.get(fp)
  if (had) return had
  if (sentBefore(fp)) {
    const r = Promise.resolve<ReportResult>({ ok: true })
    sent.set(fp, r)
    return r
  }
  const p = incidentsApi.report(body)
    .then((x): ReportResult => {
      markSent(fp)
      return { ok: true, id: x && typeof x === 'object' && typeof x.id === 'string' ? x.id : undefined }
    })
    // 上报失败（后端没起、限流 429、接口还没有）静默；同一个错误这次页面里不再试
    .catch((): ReportResult => ({ ok: false }))
  sent.set(fp, p)
  return p
}

let watching = false

/** 全局 error、unhandledrejection；启动时调一次 */
export function watchErrors() {
  if (watching) return
  watching = true
  window.addEventListener('error', (e) => {
    // 资源加载失败（img、script 标签）没有 error 对象，也不是脚本缺陷
    if (!e.error && !e.message) return
    const where = e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : undefined
    void reportFrontError('error', e.error ?? e.message, where)
  })
  window.addEventListener('unhandledrejection', (e) => {
    // 取消的请求不算
    if (e.reason instanceof DOMException && e.reason.name === 'AbortError') return
    void reportFrontError('rejection', e.reason)
  })
}
