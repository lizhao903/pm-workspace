// 任务抽屉的改动痕迹和退回（DEV-08d）。修订按会话分组；验收通过复用 taskEdit 的 useApprove，这里只补退回。
// 查询键挂在 objects 前缀下，写操作按 objects 前缀失效时一起刷新。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { objects } from './resources'
import type { Revision } from './types'

// 后端上限就是 200
export const REVISION_LIMIT = 200

export const revisionKeys = {
  list: (id: string) => ['objects', 'revisions', id] as const,
}

export function useObjectRevisions(id: string | null) {
  return useQuery({
    queryKey: revisionKeys.list(id ?? ''),
    queryFn: () => objects.revisions(id ?? '', { limit: REVISION_LIMIT }),
    enabled: !!id,
  })
}

export type RevisionGroup = {
  /** 分组键：有会话按会话，没有会话按操作者名 */
  key: string
  session_id: string
  actor_name: string
  /** 组内修订，早的在前 */
  rows: Revision[]
  first: string
  last: string
}

/**
 * 按 session_id 分组，组内按时间顺序；组按最近一次改动排，最近的在前。
 * 没有会话的（界面操作、老数据）按 actor_name 归一组。接口返回最近的在前，组内直接倒过来（时间只到秒）。
 */
export function groupRevisions(rows: readonly Revision[]): RevisionGroup[] {
  const map = new Map<string, RevisionGroup>()
  for (const r of rows) {
    const key = r.session_id ? `s:${r.session_id}` : `a:${r.actor_name || r.actor}`
    let g = map.get(key)
    if (!g) {
      g = { key, session_id: r.session_id, actor_name: r.actor_name || r.actor, rows: [], first: r.created_at, last: r.created_at }
      map.set(key, g)
    }
    g.rows.push(r)
    g.first = r.created_at
  }
  const out = [...map.values()]
  for (const g of out) g.rows.reverse()
  return out
}

/** 退回的进展正文；意见必填，调用方先校验 */
export const rejectText = (comment: string) => `退回：${comment.trim()}`

// 退回：记一条进展并同一事务把状态改回初始状态（不是 doing，否则领取规则会当成仍被占用）
export function useReject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: string; status: string; comment: string }) => {
      if (!comment.trim()) return Promise.reject(new Error('退回要写意见'))
      return objects.appendProgress(id, { kind: 'note', text: rejectText(comment), status })
    },
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['objects'] }),
      qc.invalidateQueries({ queryKey: ['counts'] }),
    ]),
  })
}
