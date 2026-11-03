// 视频插件的商单（VID-08d）。契约见 docs/api-contract.md「商单（VID-08d）」。
// 商单不分页，一次取完由前端按项目、状态分组。缓存键在 video 前缀下，写操作报 { kind: 'video' }；账期在今日卡片里，写完顺带刷今日。
// 出结案报告会建一篇文档，另报 { kind: 'object' }，文档列表、项目文档标签跟着刷
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { projectConversationsApi } from './projectConversations'
import { todayKeys } from './today'
import type { VideoPlatform } from './videoTopics'

export type VideoDealStatus = 'inquiry' | 'quoted' | 'signed' | 'producing' | 'client_review' | 'delivered' | 'paid' | 'lost'
export type VideoDealCurrency = 'CNY' | 'USD'

export type VideoDeal = {
  /** deal_ 前缀 */
  id: string
  project_id: string
  /** 询价人（联系人 id） */
  contact_id?: string
  brand: string
  title: string
  platforms: VideoPlatform[]
  deliverables: string
  quote: number
  currency: VideoDealCurrency
  status: VideoDealStatus
  /** 交付截止 YYYY-MM-DD */
  deadline?: string
  /** 账期：最晚收款日 YYYY-MM-DD */
  pay_due?: string
  video_ids: string[]
  /** 从哪条 IM 消息转来的 */
  source_message_id?: string
  /** 结案报告：落在文档里的那篇 */
  report_content_id?: string
  lost_reason?: string
  /** 状态变化记录，新的在前，后端记 */
  history: { status: VideoDealStatus; at: string }[]
  /** 结案报告能不能出：挂上的视频还没有已发布的记录时没有 */
  report_state?: { ready: boolean; left: number; first_published_at: string }
  created_at: string
  updated_at: string
}

export type VideoDealInput = {
  project_id?: string
  contact_id?: string | null
  brand?: string
  title?: string
  platforms?: VideoPlatform[]
  deliverables?: string
  quote?: number
  currency?: VideoDealCurrency
  status?: VideoDealStatus
  deadline?: string | null
  pay_due?: string | null
  video_ids?: string[]
  source_message_id?: string | null
  lost_reason?: string | null
}

/** 报价参考：近 30 天这些平台已发布记录的平均播放，value 是按每千次播放 cpm 元折的投放价值 */
export type VideoQuoteRef = { platforms: VideoPlatform[]; avg: number; n: number; cpm: number; value: number }

export type VideoDealReport = { deal: VideoDeal; doc: { id: string; ref: string; title: string } }

export const videoDealKeys = {
  all: ['video', 'deals'] as const,
  list: ['video', 'deals', 'list'] as const,
  quoteRef: (platforms: readonly string[]) => ['video', 'deals', 'quote-ref', [...platforms].sort().join(',')] as const,
}

const base = '/api/video/deals'
const dealPath = (id: string) => `${base}/${encodeURIComponent(id)}`

export const videoDealApi = {
  list: async (signal?: AbortSignal) => (await requestList<VideoDeal>(base, { signal })).data,
  create: (body: VideoDealInput) => request<VideoDeal>('POST', base, { body }),
  patch: (id: string, body: VideoDealInput) => request<VideoDeal>('PATCH', dealPath(id), { body }),
  remove: (id: string) => request<null>('DELETE', dealPath(id)),
  report: (id: string) => request<VideoDealReport>('POST', `${dealPath(id)}/report`, { body: {} }),
  quoteRef: (platforms: readonly string[], signal?: AbortSignal) => {
    const query = new URLSearchParams()
    if (platforms.length) query.set('platforms', platforms.join(','))
    return request<VideoQuoteRef>('GET', `${base}/quote-ref`, { query, signal })
  },
}

/** 全部商单，按新建先后；按项目筛在前端做 */
export function useVideoDeals(opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoDealKeys.list, queryFn: ({ signal }) => videoDealApi.list(signal), enabled: opts.enabled ?? true })
}

/**
 * IM 消息转商单时挑项目（SPEC-videos-16.11）：绑了这条消息所在会话的项目，按传进来的先后取第一个；都没绑或没有会话时取第一个项目。
 * 点「转为商单」时才查各项目绑的会话，查不到的项目跳过
 */
export function useDealProjectResolver() {
  const qc = useQueryClient()
  return async (conversationId: string | null, projectIds: readonly string[]): Promise<string> => {
    if (conversationId) {
      const hits = await Promise.all(projectIds.map((pid) => qc.fetchQuery({
        queryKey: dataKeys.projectConversations(pid),
        queryFn: ({ signal }) => projectConversationsApi.list(pid, signal),
        staleTime: 30_000,
      }).then((xs) => xs.some((c) => c.conversation_id === conversationId), () => false)))
      const i = hits.indexOf(true)
      if (i >= 0) return projectIds[i]
    }
    return projectIds[0] ?? ''
  }
}

/** 报价参考，平台一变重新取 */
export function useVideoQuoteRef(platforms: readonly string[], opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: videoDealKeys.quoteRef(platforms),
    queryFn: ({ signal }) => videoDealApi.quoteRef(platforms, signal),
    enabled: opts.enabled ?? true,
  })
}

// 写成功后先把回来的商单换进列表，抽屉不闪，再刷 video 前缀和今日
function useDealWrite<A, R>(fn: (a: A) => Promise<R>, deal: (r: R) => VideoDeal | null, opts: { doc?: boolean; removed?: (a: A) => string } = {}) {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, a) => {
      const d = deal(r)
      if (d) {
        qc.setQueryData<VideoDeal[]>(videoDealKeys.list, (xs) => (!xs ? xs : xs.some((y) => y.id === d.id) ? xs.map((y) => (y.id === d.id ? d : y)) : [...xs, d]))
      }
      const gone = opts.removed?.(a)
      if (gone) qc.setQueryData<VideoDeal[]>(videoDealKeys.list, (xs) => xs?.filter((y) => y.id !== gone))
      return Promise.all([
        notify({ kind: 'video' }),
        qc.invalidateQueries({ queryKey: todayKeys.all }),
        ...(opts.doc ? [notify({ kind: 'object' })] : []),
      ]).then(() => undefined)
    },
  })
}

export function useCreateDeal() {
  return useDealWrite((body: VideoDealInput) => videoDealApi.create(body), (d) => d)
}

/** 只传改的字段；video_ids 整体替换，可选字段传 null 清掉 */
export function usePatchDeal() {
  return useDealWrite(({ id, patch }: { id: string; patch: VideoDealInput }) => videoDealApi.patch(id, patch), (d) => d)
}

/** 删商单：视频和结案报告文档留着 */
export function useDeleteDeal() {
  return useDealWrite((id: string) => videoDealApi.remove(id), () => null, { removed: (id) => id })
}

/** 出结案报告：建一篇文档，回填 report_content_id；再出一次是再建一篇新的 */
export function useDealReport() {
  return useDealWrite((id: string) => videoDealApi.report(id), (r) => r.deal, { doc: true })
}
