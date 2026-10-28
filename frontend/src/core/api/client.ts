// 接口层：所有请求都从这里发，组件里不直接 fetch。
// 后端统一返回 { data, meta? }，出错返回 { error: { code, message } }（见 docs/api-contract.md）。

export type Meta = { total?: number; limit?: number; offset?: number }

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type Envelope<T> = { data?: T; meta?: Meta; error?: { code?: string; message?: string } }

export async function requestEnvelope<T>(path: string, init?: RequestInit): Promise<{ data: T; meta?: Meta }> {
  const headers = new Headers(init?.headers)
  if (init?.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch (e) {
    throw new ApiError(0, 'network', e instanceof Error ? e.message : '网络错误')
  }

  let body: Envelope<T> | null = null
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    // 非 JSON 响应（比如代理报错页），按状态码处理
  }

  if (!res.ok || body?.error) {
    throw new ApiError(res.status, body?.error?.code ?? 'http_' + res.status, body?.error?.message ?? res.statusText)
  }
  if (!body || !('data' in body)) throw new ApiError(res.status, 'bad_response', '响应格式不对')
  return { data: body.data as T, meta: body.meta }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestEnvelope<T>(path, init)).data
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
