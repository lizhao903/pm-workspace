// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 接口层：所有请求都从这里发，组件里不直接 fetch（lint 规则 no-restricted-globals 盯着）。
// 后端统一返回 { data, meta? }，出错返回 { error: { code, message } }（见 docs/api-contract.md）。

export type Meta = { total?: number; limit?: number; offset?: number }

// 前五个是契约里的错误码；network 是前端自己的：请求根本没到后端（服务没起、断网）。
export type ApiErrorCode = 'validation' | 'not_found' | 'conflict' | 'readonly' | 'internal' | 'network'

const serverCodes = new Set<string>(['validation', 'not_found', 'conflict', 'readonly', 'internal'])

// 后端没给错误码（代理报错页、非 JSON）或给了不认识的码时，按状态码归类。
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'validation'
    case 403:
      return 'readonly'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    default:
      return 'internal'
  }
}

// 后端给的码认得就用，否则按状态码归类
export function errorCode(raw: string | undefined, status: number): ApiErrorCode {
  return raw && serverCodes.has(raw) ? (raw as ApiErrorCode) : codeForStatus(status)
}

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  /** 错误信封里 code、message 以外的字段（如 SOP 保存校验的 issues），没有时为空对象 */
  readonly extra: Record<string, unknown>

  constructor(status: number, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code)
}

// 默认走同源 /api（dev server 代理到测试实例）；在 Node 里联调时设成完整地址。
let base = ''
export function setApiBase(url: string) {
  base = url.replace(/\/+$/, '')
}
export function apiBase() {
  return base
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type RequestOptions = {
  query?: URLSearchParams
  body?: unknown
  signal?: AbortSignal
  /** 额外的请求头（Webhook 测试推送的签名头） */
  headers?: Record<string, string>
  /** 页面关掉、刷新时也要发完（浏览器标签页离开前补存） */
  keepalive?: boolean
}

type Envelope<T> = { data?: T; meta?: Meta; error?: { code?: string; message?: string } }

export async function requestEnvelope<T>(
  method: Method,
  path: string,
  opts: RequestOptions = {},
): Promise<{ data: T; meta?: Meta }> {
  const headers = new Headers()
  // 写操作统一标成界面来源，落进 revisions.source；产物登记也按它判定 source。
  if (method !== 'GET') headers.set('X-Actor-Source', 'ui')
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v)

  const qs = opts.query?.toString()
  const url = base + path + (qs ? '?' + qs : '')

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      keepalive: opts.keepalive,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'network', e instanceof Error ? e.message : '网络错误')
  }

  let body: Envelope<T> | null = null
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    // 非 JSON 响应（比如代理报错页），按状态码处理
  }

  if (!res.ok || body?.error) {
    const code = errorCode(body?.error?.code, res.status)
    const message = body?.error?.message || res.statusText || 'HTTP ' + res.status
    const extra: Record<string, unknown> = { ...body?.error }
    delete extra.code
    delete extra.message
    throw new ApiError(res.status, code, message, extra)
  }
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiError(res.status, 'internal', '响应格式不对：缺少 data')
  }
  return { data: body.data as T, meta: body.meta }
}

export async function request<T>(method: Method, path: string, opts?: RequestOptions): Promise<T> {
  return (await requestEnvelope<T>(method, path, opts)).data
}

export type UploadOptions = {
  /** 文件字段名，默认 file；录音上传是 audio */
  fileField?: string
  /** 文件名，默认取 File.name，没有就按 audio 传 */
  filename?: string
  signal?: AbortSignal
}

/**
 * multipart 上传（录音音频用）：不设 Content-Type，交给浏览器带 boundary。
 * 响应仍是统一信封 { data, meta? }，错误映射同 requestEnvelope。
 */
export async function uploadFile<T>(path: string, file?: Blob, fields: Record<string, string> = {}, opts: UploadOptions = {}): Promise<T> {
  const headers = new Headers()
  headers.set('X-Actor-Source', 'ui')
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (file) {
    const filename = opts.filename ?? (file instanceof File ? file.name : 'audio')
    form.append(opts.fileField ?? 'file', file, filename)
  }

  let res: Response
  try {
    res = await fetch(base + path, { method: 'POST', headers, body: form, signal: opts.signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'network', e instanceof Error ? e.message : '网络错误')
  }

  let body: Envelope<T> | null = null
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    // 非 JSON 响应（代理报错页），按状态码处理
  }
  if (!res.ok || body?.error) {
    const code = errorCode(body?.error?.code, res.status)
    const message = body?.error?.message || res.statusText || 'HTTP ' + res.status
    const extra: Record<string, unknown> = { ...body?.error }
    delete extra.code
    delete extra.message
    throw new ApiError(res.status, code, message, extra)
  }
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiError(res.status, 'internal', '响应格式不对：缺少 data')
  }
  return body.data as T
}

// 列表接口：data 加上 meta.total。没有 meta 时 total 取本页条数。
export type ListResult<T> = { data: T[]; total: number; limit?: number; offset?: number }

export async function requestList<T>(path: string, opts?: RequestOptions): Promise<ListResult<T>> {
  const { data, meta } = await requestEnvelope<T[] | null>('GET', path, opts)
  const items = data ?? []
  return { data: items, total: meta?.total ?? items.length, limit: meta?.limit, offset: meta?.offset }
}

export const api = {
  get: <T>(path: string, query?: URLSearchParams, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  del: <T>(path: string, query?: URLSearchParams) => request<T>('DELETE', path, { query }),
}

// 路径段里的 id 一律转义，防止带斜杠的值拼出别的路由。
export const seg = encodeURIComponent

/**
 * 读一个文件地址的原始内容当文本（附件预览用）：最多 max 字节，超了截断、cut 为真。
 * 不是 JSON 接口，不走 request；失败抛 ApiError 之外的 Error（带 HTTP 状态）
 */
export async function readRawText(url: string, max: number, signal?: AbortSignal): Promise<{ text: string; cut: boolean }> {
  const res = await fetch(url, { signal, credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  const cut = buf.byteLength > max
  return { text: new TextDecoder().decode(cut ? buf.slice(0, max) : buf), cut }
}

/** 取一次页面入口 index.html 的文本（看服务是不是换了新构建用），取不到回 null */
export async function fetchAppIndex(): Promise<string | null> {
  try {
    const res = await fetch('/', { cache: 'no-store' })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}
