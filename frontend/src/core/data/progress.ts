// 进展的读写（DEV-08a 起，CORE-03a 迁进数据访问层）：进展列表、追加进展、验收通过。
// 只记进展报 { kind: 'progress' }；带 status 的（同一事务改了状态）按对象改动处理，列表和计数一起刷新。
import { useMutation, useQuery } from '@tanstack/react-query'
import { objects, type Progress, type ProgressInput, type ProgressKind, type Revision } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

// 后端默认就是 100
export const PROGRESS_LIMIT = 100
// 进行中的任务抽屉打开期间的刷新间隔；M2 有事件推送后改成推送（CORE-07c）
export const PROGRESS_POLL_MS = 10_000

/** kind 是契约里的固定取值（claim / note / review），不是字典，标识在这里定 */
export const PROGRESS_KIND_LABEL: Record<ProgressKind, string> = {
  claim: '领取',
  note: '进展',
  review: '提交验收',
}

export const progressKindLabel = (k: string) => PROGRESS_KIND_LABEL[k as ProgressKind] ?? k

/**
 * 接口返回最近的在前，时间线按时间顺序（早的在前）。直接倒过来，不按 created_at 重排：
 * 时间只到秒，同一秒的几条靠后端的插入顺序（rowid）区分，前端排不出来。
 */
export function chronological(rows: readonly Progress[]): Progress[] {
  return [...rows].reverse()
}

/** 会话 id 短码，取前 8 位 */
export const shortSession = (s: string) => s.slice(0, 8)

/**
 * 是否算「进行中」：状态是最近一次领取切到的状态（契约里「仍在进行中」的口径），
 * 没有领取记录时看是不是 doing（领取不传 status 时后端切到的就是它）。
 */
export function isInProgress(status: string, rows: readonly Progress[]): boolean {
  if (!status) return false
  const claim = rows.find((p) => p.kind === 'claim')
  return claim?.status ? claim.status === status : status === 'doing'
}

/** field=progress 的修订是进展，old_value 是元数据 JSON，不能按「从 old 改成 new」显示 */
export const isProgressRevision = (r: Pick<Revision, 'field'>) => r.field === 'progress'

/**
 * 一条修订显示成一句话。进展只给正文（带类型标识），绝不把 old_value 当旧值显示。
 */
export function revisionSummary(r: Pick<Revision, 'field' | 'old_value' | 'new_value'>): string {
  if (isProgressRevision(r)) {
    let kind = 'note'
    try {
      const meta = JSON.parse(r.old_value || '{}') as { kind?: unknown }
      if (typeof meta.kind === 'string') kind = meta.kind
    } catch {
      // 元数据坏了按普通进展显示
    }
    return `${progressKindLabel(kind)}：${r.new_value}`
  }
  if (!r.old_value) return `${r.field} 设为 ${r.new_value}`
  if (!r.new_value) return `${r.field} 清空（原为 ${r.old_value}）`
  return `${r.field} 从 ${r.old_value} 改成 ${r.new_value}`
}

// 进展列表；传了对象当前状态且任务进行中时每 10 秒刷新一次（判定要用拿到的领取记录）
export function useProgress(id: string | null, status?: string) {
  return useQuery({
    queryKey: dataKeys.objects.progress(id ?? ''),
    queryFn: () => objects.progress(id ?? '', { limit: PROGRESS_LIMIT }),
    enabled: !!id,
    refetchInterval: (q) => (status !== undefined && isInProgress(status, q.state.data ?? []) ? PROGRESS_POLL_MS : false),
    // 抽屉在后台标签页里不用刷
    refetchIntervalInBackground: false,
  })
}

// 人工追加一条进展（kind=note）；带 status 时状态会变，按对象改动刷新
export function useAppendProgress(id: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: ProgressInput) => objects.appendProgress(id, { kind: 'note', ...input }),
    onSuccess: (_, input) => notify(input.status ? { kind: 'object', id } : { kind: 'progress', id }),
  })
}

// 验收通过：记一条进展并同一事务把状态改为 done（SPEC-tasks-5.22、5.27）
export function useApprove() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: string; status: string; comment?: string }) =>
      objects.appendProgress(id, { kind: 'note', text: comment?.trim() ? `验收通过：${comment.trim()}` : '验收通过', status }),
    onSuccess: (_, v) => notify({ kind: 'object', id: v.id }),
  })
}
