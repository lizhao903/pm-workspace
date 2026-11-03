// 统一的 id 生成：<前缀>_<时间戳 base36><序号><随机段>
// 前缀一类实体一个，登记在 ID_PREFIX 里，不许两类共用；种子数据的老 id（ct_001、af1 这种）保持原样
// 序号在同一毫秒内递增，加上随机段，同一毫秒连建多条也不会撞

export const ID_PREFIX = {
  // 沟通
  contact: 'ct',
  connector: 'cn',
  message: 'msg',
  attachment: 'att',
  reply: 'rp',
  // 文档（「文档」模块的 ContentItem）
  doc: 'dc',
  // 项目
  project: 'pj',
  material: 'mt',
  projectDoc: 'pd',
  prototype: 'pt',
  projectChat: 'ch',
  // 任务与自动化
  task: 'tk',
  webhook: 'wh',
  delivery: 'dl',
  schedule: 'sc',
  sop: 'sop',
  sopRun: 'run',
  incident: 'inc',
  // Agent 与模型
  agent: 'ag',
  agentRun: 'ar',
  session: 'ss',
  output: 'op',
  kb: 'kb',
  kbDoc: 'kd',
  skill: 'sk',
  provider: 'pv',
  // 工作台、域名、本地目录
  workspace: 'ws',
  domainRoute: 'dm',
  localDir: 'dir',
  // 视频
  video: 'vd',
  artifact: 'af',
  series: 'sr',
  publish: 'pb',
  topic: 'tp',
  clip: 'cl',
  deal: 'deal',
  // 交易
  watchlist: 'wl',
  alert: 'al',
  alertEvent: 'ae',
  strategy: 'st',
  strategyRule: 'rl',
  backtest: 'bk',
  account: 'ac',
  position: 'ps',
  order: 'od',
  strategyRun: 'rn',
  // 浏览器与终端
  browserTab: 'bt',
  termTab: 'tb',
  termPane: 'pn',
} as const

export type IdEntity = keyof typeof ID_PREFIX
export type IdPrefix = (typeof ID_PREFIX)[IdEntity]

let lastMs = 0
let seq = 0

/** 生成新 id；prefix 用 ID_PREFIX 里的值，如 newId(ID_PREFIX.doc) 或 newId('dc') */
export function newId(prefix: IdPrefix): string {
  const ms = Date.now()
  seq = ms === lastMs ? seq + 1 : 0
  lastMs = ms
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `${prefix}_${ms.toString(36)}${seq.toString(36).padStart(2, '0')}${rand}`
}

/** 前缀表自检：开发期调用，发现两类实体共用前缀就抛错 */
export function assertUniquePrefixes(): void {
  const seen = new Map<string, string>()
  for (const [k, v] of Object.entries(ID_PREFIX)) {
    const o = seen.get(v)
    if (o) throw new Error(`id 前缀 ${v} 同时给了 ${o} 和 ${k}`)
    seen.set(v, k)
  }
}
