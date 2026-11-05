// 交易所实盘账户（TRD-07a 后端，TRD-07b 前端）、对账（TRD-08b）、交易审计（TRD-08a）、实盘评审闸门和实盘开关（TRD-08c）。
// 契约见 docs/api-contract.md「交易套件插件 trade」的「交易所账户只读接入」「交易审计和停用前全停」「对账和自动熔断」「实盘评审闸门」。
//
// 实盘账户只读：没有任何向交易所下单、撤单、划转、提币的接口。实盘开关打开后，实盘下单（TRD-08d）上线之前，
// 实盘账户的交易动作后端照样 403，前端也不给可用的入口。
//
// 接入实盘账户三步：内核建连接器（凭证进保险箱）→ 测试连接 → POST /api/trade/accounts {connector_id}；放弃时删掉连接器。
// 评审确认、申请 trade:live、打开实盘开关只接受用户本人在界面上的操作：前端的写请求都带 X-Actor-Source: ui（core/api/client）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestEnvelope } from '../api'
import { useNotifyChange } from './invalidate'
import { pluginsApi } from './plugins'
import { tradePaperKeys, type TradeAccount } from './tradePaper'

export type TradeLiveBalance = { asset: string; free: number; locked: number; total: number; value: number; wallet: 'spot' | 'futures' | 'unified' }
export type TradeLivePosition = {
  symbol: string
  name: string
  kind: 'spot' | 'perp'
  side: 'long' | 'short'
  qty: number
  avg_price: number
  leverage?: number
  liq_price?: number
  last: number
  pnl: number
  margin: number
  contracts?: number
  /** 对账用的持仓键，同一账户内唯一，当行 id 用 */
  key: string
  account_id?: string
}
export type TradeLiveOrder = {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  type: string
  qty: number
  price?: number
  stop_price?: number
  filled: number
  status: 'open' | 'partial'
  created_at: string
  account_id?: string
}
export type TradeLiveFill = {
  id: string
  account_id: string
  order_id: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  fee: number
  fee_asset: string
  at: string
  synced_at: string
}
export type TradeLiveSnapshot = {
  account_id: string
  synced_at: string
  baseline_at: string
  status: string
  error?: string
  equity: number
  available: number
  margin_used: number
  marks_status: 'live' | 'stale'
  key_permissions: string[]
  fail_count: number
  balances: TradeLiveBalance[]
  positions: TradeLivePosition[]
  orders: TradeLiveOrder[]
}

export type TradeReconItem = {
  id: string
  kind: 'position' | 'order'
  label: string
  local: string
  remote: string
  note?: string
  remote_qty?: number
  resolved_at?: string
  resolution?: string
  key: string
  symbol?: string
  local_qty: number
  pct: number
  seen: number
  confirmed: boolean
  method?: 'adopt' | 'verify' | 'auto'
  created_at: string
  updated_at: string
}
export type TradeRecon = {
  account_id: string
  at: string
  status: 'ok' | 'diff' | 'failed' | 'none'
  error?: string
  checked: number
  items: TradeReconItem[]
  id?: string
  open: number
  max_pct: number
  threshold: number
}
export type TradeReconRecord = { id: string; account_id: string; at: string; status: 'ok' | 'diff' | 'failed'; error?: string; checked: number; open: number; max_pct: number }

export type TradeAudit = {
  id: number
  at: string
  action: string
  target_type: string
  target_id: string
  summary: string
  origin: string
  actor: string
  account_id?: string
  run_id?: string
  order_id?: string
  detail: Record<string, unknown>
}

/** 评审清单一项的证据：href 是能直接 GET 的接口路径，view 是交易页里去看的视图 */
export type TradeLiveEvidence = { label: string; href: string; view?: string }
export type TradeLiveCheckState = { ok: boolean; text: string; go?: string; evidence: TradeLiveEvidence[] }
export type TradeLiveCheckKey = 'audit' | 'recon' | 'incident' | 'drill' | 'paper'
export type TradeLiveCheck = TradeLiveCheckState & {
  key: TradeLiveCheckKey
  label: string
  desc: string
  confirmed_at?: string
  reviewer?: string
  note?: string
  /** 确认那一刻的情况和证据快照 */
  confirmed?: TradeLiveCheckState
}
export type TradeLiveRecord = {
  id: number
  at: string
  /** confirm / revoke / pass / reopen / denied */
  action: string
  item?: string
  reviewer: string
  source: string
  detail: Record<string, unknown>
}
export type TradeLiveGate = {
  checks: TradeLiveCheck[]
  review: { status: 'passed' | 'pending'; at?: string; reviewer?: string; missing: string[] }
  granted: boolean
  enabled: boolean
  changed_at?: string
  changed_by?: string
  off_reason?: string
  can_enable: boolean
  blockers: string[]
  /** 恒为 false：实盘下单（TRD-08d）没上线 */
  live_orders: boolean
  note: string
  /** 二次确认要输入的插件名 */
  plugin_name: string
  records: TradeLiveRecord[]
}

export type TradeLiveAccountInput = { connector_id: string; name?: string; trade?: boolean }

export const tradeLiveKeys = {
  all: ['trade', 'live'] as const,
  snapshot: (id: string) => ['trade', 'live', 'snapshot', id] as const,
  fills: (id: string) => ['trade', 'live', 'fills', id] as const,
  recon: (id: string) => ['trade', 'live', 'recon', id] as const,
  recons: (q: string) => ['trade', 'live', 'recons', q] as const,
  audit: (q: string) => ['trade', 'live', 'audit', q] as const,
  gate: ['trade', 'live', 'gate'] as const,
}

const seg = encodeURIComponent
const acct = (id: string, rest = '') => `/api/trade/accounts/${seg(id)}${rest}`

/** 交易插件的 id：trade:live 的单独申请走内核的插件权限接口 */
export const TRADE_PLUGIN_ID = 'trade'
export const TRADE_LIVE_PERM = 'trade:live'

export const tradeLiveApi = {
  /** 接入交易所账户（连接器测试通过后）：409 reason key_withdraw / connect_failed / in_use */
  createAccount: (body: TradeLiveAccountInput) => request<TradeAccount>('POST', '/api/trade/accounts', { body }),
  patchAccount: (id: string, body: { name?: string; trade?: boolean }) => request<TradeAccount>('PATCH', acct(id), { body }),
  /** 删账户：模拟盘有持仓、挂单、没停的部署时 409；实盘只删插件里的记录，交易所和连接器都不动 */
  removeAccount: (id: string) => request<null>('DELETE', acct(id)),
  connect: (id: string) => request<TradeAccount>('POST', acct(id, '/connect'), { body: {} }),
  disconnect: (id: string) => request<TradeAccount>('POST', acct(id, '/disconnect'), { body: {} }),
  snapshot: (id: string) => request<TradeLiveSnapshot>('GET', acct(id, '/snapshot')),
  fills: async (id: string, limit = 50) => {
    const r = await requestEnvelope<TradeLiveFill[] | null>('GET', acct(id, '/fills'), { query: new URLSearchParams({ limit: String(limit) }) })
    const meta = (r.meta ?? {}) as { total?: number }
    const data = r.data ?? []
    return { data, total: meta.total ?? data.length }
  },
  recon: (id: string) => request<TradeRecon>('GET', acct(id, '/recon')),
  recheck: (id: string) => request<TradeRecon>('POST', acct(id, '/recon'), { body: {} }),
  /** adopt：按交易所修正；verify：标为已核实（note 必填，最多 200 字） */
  resolve: (id: string, item: string, action: 'adopt' | 'verify', note?: string) =>
    request<TradeRecon>('POST', acct(id, `/recon/items/${seg(item)}/resolve`), { body: note ? { action, note } : { action } }),
  /** 对账记录；query 是证据链接里的查询串（account_id=…） */
  recons: async (query: string) => {
    const r = await requestEnvelope<TradeReconRecord[] | null>('GET', '/api/trade/recons', { query: new URLSearchParams(query) })
    const meta = (r.meta ?? {}) as { total?: number }
    return { data: r.data ?? [], total: meta.total ?? 0 }
  },
  /** 交易审计；query 是证据链接里的查询串（order_id=… / action=…） */
  audit: async (query: string) => {
    const r = await requestEnvelope<TradeAudit[] | null>('GET', '/api/trade/audit', { query: new URLSearchParams(query) })
    const meta = (r.meta ?? {}) as { total?: number }
    return { data: r.data ?? [], total: meta.total ?? 0 }
  },
  gate: () => request<TradeLiveGate>('GET', '/api/trade/live'),
  confirm: (key: TradeLiveCheckKey, note?: string) => request<TradeLiveGate>('POST', `/api/trade/live/checks/${seg(key)}/confirm`, { body: note ? { note } : {} }),
  revoke: (key: TradeLiveCheckKey) => request<TradeLiveGate>('POST', `/api/trade/live/checks/${seg(key)}/revoke`, { body: {} }),
  setSwitch: (enabled: boolean) => request<TradeLiveGate>('POST', '/api/trade/live/switch', { body: { enabled } }),
  /** 申请 trade:live：内核单独申请，confirm 是插件名；评审没通过时插件不同意（403） */
  grant: (pluginName: string) => pluginsApi.grantPermission(TRADE_PLUGIN_ID, TRADE_LIVE_PERM, pluginName),
  revokeGrant: () => pluginsApi.revokePermission(TRADE_PLUGIN_ID, TRADE_LIVE_PERM),
}

/** 证据链接能在页面里直接看的：审计、对账记录 */
export function evidenceKind(href: string): { kind: 'audit' | 'recons'; query: string } | null {
  const [path, query = ''] = href.split('?')
  if (path === '/api/trade/audit') return { kind: 'audit', query }
  if (path === '/api/trade/recons') return { kind: 'recons', query }
  return null
}

/** 实盘账户的交易所数据（最近一次只读同步拉到的），同步一分钟一次，这里半分钟重取 */
export const useTradeLiveSnapshot = (id: string, enabled = true) =>
  useQuery({ queryKey: tradeLiveKeys.snapshot(id), queryFn: () => tradeLiveApi.snapshot(id), enabled: enabled && !!id, refetchInterval: 30_000 })
export const useTradeLiveFills = (id: string, enabled = true) =>
  useQuery({ queryKey: tradeLiveKeys.fills(id), queryFn: () => tradeLiveApi.fills(id), enabled: enabled && !!id })
export const useTradeRecon = (id: string, enabled = true) =>
  useQuery({ queryKey: tradeLiveKeys.recon(id), queryFn: () => tradeLiveApi.recon(id), enabled: enabled && !!id })
export const useTradeRecons = (query: string, enabled = true) =>
  useQuery({ queryKey: tradeLiveKeys.recons(query), queryFn: () => tradeLiveApi.recons(query), enabled })
export const useTradeAudit = (query: string, enabled = true) =>
  useQuery({ queryKey: tradeLiveKeys.audit(query), queryFn: () => tradeLiveApi.audit(query), enabled })
/** 评审清单、评审结论、trade:live、实盘开关；条件跟着交易数据变，半分钟重取 */
export const useTradeLiveGate = () => useQuery({ queryKey: tradeLiveKeys.gate, queryFn: tradeLiveApi.gate, refetchInterval: 30_000 })

/** 账户、对账、评审相关的写：刷新交易的全部数据（账户、评审条件都可能变） */
function useLiveMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: tradePaperKeys.all }), qc.invalidateQueries({ queryKey: tradeLiveKeys.all })]),
  })
}

export const useCreateLiveAccount = () => useLiveMutation(tradeLiveApi.createAccount)
export const useRemoveTradeAccount = () => useLiveMutation(tradeLiveApi.removeAccount)
export const useConnectTradeAccount = () => useLiveMutation(tradeLiveApi.connect)
export const useDisconnectTradeAccount = () => useLiveMutation(tradeLiveApi.disconnect)
export const useRecheckRecon = () => useLiveMutation(tradeLiveApi.recheck)
export const useResolveRecon = () =>
  useLiveMutation(({ id, item, action, note }: { id: string; item: string; action: 'adopt' | 'verify'; note?: string }) => tradeLiveApi.resolve(id, item, action, note))

function useGateMutation<A>(fn: (a: A) => Promise<TradeLiveGate>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (v) => qc.setQueryData(tradeLiveKeys.gate, v),
    onSettled: () => qc.invalidateQueries({ queryKey: tradeLiveKeys.gate }),
  })
}
export const useConfirmLiveCheck = () => useGateMutation(({ key, note }: { key: TradeLiveCheckKey; note?: string }) => tradeLiveApi.confirm(key, note))
export const useRevokeLiveCheck = () => useGateMutation(tradeLiveApi.revoke)
export const useSetLiveSwitch = () => useGateMutation(tradeLiveApi.setSwitch)

/** 申请、收回 trade:live：写的是内核的插件状态，插件列表和评审一起刷新 */
export function useGrantTradeLive() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (pluginName: string) => tradeLiveApi.grant(pluginName),
    onSettled: () => Promise.all([notify({ kind: 'plugin' }), qc.invalidateQueries({ queryKey: tradeLiveKeys.gate })]),
  })
}
export function useRevokeTradeLive() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: () => tradeLiveApi.revokeGrant(),
    onSettled: () => Promise.all([notify({ kind: 'plugin' }), qc.invalidateQueries({ queryKey: tradeLiveKeys.gate })]),
  })
}
