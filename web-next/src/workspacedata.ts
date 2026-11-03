// 工作台：一套菜单配置——开哪些功能模块、怎么分组、什么顺序、默认打开哪个。数据所有工作台共用，切工作台只换菜单
// 设置不算模块，总在左下角
// groups 是唯一的来源；modules 是按分组顺序摊平的启用列表，跟着 groups 算出来，方便各处直接用

export type ModuleKey = 'today' | 'projects' | 'contacts' | 'messages' | 'tasks' | 'library' | 'sop' | 'sessions' | 'terminal' | 'browser'
  | 'videos' | 'markets' | 'monitor' | 'strategy' | 'trading'

export const MODULES: { key: ModuleKey; label: string; desc: string }[] = [
  { key: 'today', label: '今日', desc: '今天要处理的事集中在一页' },
  { key: 'projects', label: '项目', desc: '项目目录、材料、文档、原型启停' },
  { key: 'contacts', label: '联系人', desc: '客户、伙伴、同事和他们的 IM 账号' },
  { key: 'messages', label: 'IM 消息', desc: '各渠道收进来的消息，处理和回复' },
  { key: 'tasks', label: '任务', desc: '人工、IM、Webhook、定时、异常转来的任务' },
  { key: 'library', label: '文档', desc: '工作台文档和本地目录' },
  { key: 'sop', label: 'SOP', desc: '标准流程的编排和执行' },
  { key: 'sessions', label: '会话', desc: '和 Agent 的对话、执行记录、产出' },
  { key: 'terminal', label: '终端', desc: '分屏终端，能启停项目原型' },
  { key: 'browser', label: '浏览器', desc: '内置浏览器：看原型、Google Drive 文件' },
  { key: 'videos', label: '视频', desc: '视频制作流程、产出物、系列和多平台发布' },
  { key: 'markets', label: '行情', desc: '数币、A 股、港股、美股的看盘和期权 T 型报价' },
  { key: 'monitor', label: '盯盘', desc: '盯盘墙、价格与异动提醒、市场时段' },
  { key: 'strategy', label: '策略', desc: '策略编辑、回测和参数扫描' },
  { key: 'trading', label: '交易', desc: '账户、持仓、委托、策略运行和风控' },
]
export const moduleOf = (k: ModuleKey) => MODULES.find((m) => m.key === k)!

/** 菜单分组；name 留空就只分隔、不显示标题 */
/** collapsed：一级菜单里这组折叠起来；没标题的组不折叠 */
export interface MenuGroup { id: string; name: string; modules: ModuleKey[]; collapsed?: boolean }
export interface Workbench { id: string; name: string; role: string; groups: MenuGroup[]; modules: ModuleKey[]; home: ModuleKey; mark?: { text: string; color: string; image?: string; icon?: string } }

let gseq = 0
export const groupId = () => `g${Date.now().toString(36)}${(gseq += 1)}`
const g = (name: string, modules: ModuleKey[]): MenuGroup => ({ id: groupId(), name, modules })

/** 改了分组后调用：重算启用列表，默认模块被关了就换成第一个 */
export function withGroups(w: Omit<Workbench, 'modules'> & { modules?: ModuleKey[] }, groups: MenuGroup[]): Workbench {
  const modules = groups.flatMap((x) => x.modules)
  return { ...w, groups, modules, home: modules.includes(w.home) ? w.home : modules[0] ?? 'today' }
}

/** 模板里的分组用「名称 + 模块」描述，新建时再生成 id */
export const TEMPLATES: { role: string; name: string; desc: string; groups: [string, ModuleKey[]][]; home: ModuleKey; id: string; mark?: Workbench['mark'] }[] = [
  { id: 'ws_pm', role: '产品经理', name: '产品经理工作台', desc: '需求、项目、原型、客户沟通都要管', home: 'today', mark: { text: '', icon: 'compass', color: '#3d4fd6' },
    groups: [['', ['today']], ['工作', ['projects', 'tasks', 'library']], ['沟通', ['messages', 'contacts', 'sessions']], ['自动化', ['sop', 'terminal', 'browser']]] },
  { id: 'ws_dev', role: '研发工程师', name: '研发工作台', desc: '任务、项目原型、终端和浏览器为主', home: 'tasks', mark: { text: '', icon: 'code', color: '#0f8a8a' },
    groups: [['', ['today']], ['研发', ['tasks', 'projects', 'terminal', 'browser']], ['资料', ['library', 'sessions']], ['自动化', ['sop']]] },
  { id: 'ws_ops', role: '运营 / 客户成功', name: '运营工作台', desc: '消息、联系人和流程为主', home: 'messages', mark: { text: '', icon: 'headset', color: '#b0570b' },
    groups: [['', ['today']], ['客户', ['messages', 'contacts']], ['跟进', ['tasks', 'sop']], ['资料', ['library', 'sessions', 'browser']]] },
  { id: 'ws_video', role: '视频博主', name: '视频创作工作台', desc: '视频制作、系列、多平台发布和粉丝合作', home: 'videos', mark: { text: '', icon: 'video', color: '#e8590c' },
    groups: [['', ['today']], ['创作', ['videos', 'library', 'sessions']], ['发布与互动', ['tasks', 'messages']], ['合作', ['contacts', 'projects']], ['工具', ['sop', 'terminal', 'browser']]] },
  { id: 'ws_trader', role: '交易员', name: '交易工作台', desc: '看盘盯盘、策略回测、账户执行和风控', home: 'markets', mark: { text: '', icon: 'candles', color: '#c0352b' },
    groups: [['', ['today']], ['行情', ['markets', 'monitor']], ['策略与执行', ['strategy', 'trading']], ['资讯', ['messages', 'library', 'browser']], ['工具', ['tasks', 'sessions', 'terminal']]] },
  { id: 'ws_all', role: '全部模块', name: '0xBroleez', desc: '所有功能模块都开着', home: 'today', mark: { text: '0x', color: '#161823' },
    groups: [['', ['today']], ['工作', ['projects', 'tasks', 'library']], ['视频', ['videos']], ['交易', ['markets', 'monitor', 'strategy', 'trading']],
      ['沟通', ['messages', 'contacts', 'sessions']], ['工具', ['sop', 'terminal', 'browser']]] },
  { id: '', role: '自定义', name: '我的工作台', desc: '从空白开始，自己挑模块', home: 'today', groups: [['', ['today']]] },
]
export const fromTemplate = (t: (typeof TEMPLATES)[number], id: string, name: string): Workbench =>
  withGroups({ id, name, role: t.role, groups: [], home: t.home, mark: t.mark }, t.groups.map(([n, m]) => g(n, [...m])))

/** 预设工作台：每个角色一个，外加包含全部模块的 0xBroleez */
const PRESETS = TEMPLATES.filter((t) => t.id)
export const seedWorkspaces: Workbench[] = PRESETS.map((t) => fromTemplate(t, t.id, t.name))

const KEY = 'pmw-next-workspaces'
const CUR = 'pmw-next-workspace'
/** 每个预设工作台已经给过哪些模块：新加的预设和新模块只补一次，用户删掉的不再塞回去 */
const OFFERED = 'pmw-next-presets-offered'

function upgrade(list: Workbench[]): Workbench[] {
  let offered: Record<string, ModuleKey[]> = {}
  try { offered = JSON.parse(localStorage.getItem(OFFERED) ?? '{}') ?? {} } catch { /* 当作没给过 */ }
  // 之前只有产品经理工作台；那时已经给过的模块算老模块，避免把用户关掉的又加回来
  const legacy: ModuleKey[] = ['today', 'projects', 'contacts', 'messages', 'tasks', 'library', 'sop', 'sessions', 'terminal']
  const out = [...list]
  for (const t of PRESETS) {
    const want = t.groups.flatMap(([, m]) => m)
    const given = offered[t.id] ?? (t.id === 'ws_pm' ? legacy : null)
    const i = out.findIndex((w) => w.id === t.id)
    if (i < 0) {
      // 没给过就加上；给过又不在了，说明用户删了
      if (!given) out.push(fromTemplate(t, t.id, t.name))
    } else {
      const fresh = want.filter((m) => !(given ?? []).includes(m) && !out[i].modules.includes(m))
      if (fresh.length) {
        const groups = out[i].groups.map((x) => ({ ...x, modules: [...x.modules] }))
        for (const m of fresh) {
          const gname = t.groups.find(([, ms]) => ms.includes(m))![0]
          const tgt = groups.find((x) => x.name === gname) ?? (groups.push(g(gname, [])), groups[groups.length - 1])
          tgt.modules.push(m)
        }
        out[i] = withGroups(out[i], groups)
      }
    }
    // 预设工作台以前用单字标志（产、研、运、视、交）；用户没改过的换成内置图标
    const j = out.findIndex((w) => w.id === t.id)
    const OLD: Record<string, string> = { ws_pm: '产', ws_dev: '研', ws_ops: '运', ws_video: '视', ws_trader: '交' }
    if (j >= 0 && t.mark?.icon && out[j].mark?.text === OLD[t.id] && !out[j].mark?.image && !out[j].mark?.icon) out[j] = { ...out[j], mark: { ...t.mark } }
    offered[t.id] = want
  }
  // 列表和「给过」一起存：初始化可能被调两次（StrictMode），第二次要读到升级后的列表
  try { if (list.length) localStorage.setItem(KEY, JSON.stringify(out)); localStorage.setItem(OFFERED, JSON.stringify(offered)) } catch { /* 只在本次会话生效 */ }
  return out
}

/** 工作台配置只存在这台电脑的浏览器里；拿不到存储就用默认的 */
export function loadWorkspaces(): { list: Workbench[]; current: string } {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Workbench[] | null
    const known = (m: ModuleKey) => MODULES.some((x) => x.key === m)
    // 早先存的工作台没有分组：整体转成一个不带标题的分组
    const valid = (list ?? []).filter((w) => w && (Array.isArray(w.groups) || Array.isArray(w.modules))).map((w) => withGroups(w,
      (Array.isArray(w.groups) ? w.groups : [{ id: groupId(), name: '', modules: w.modules }]).map((x) => ({ ...x, modules: x.modules.filter(known) }))))
    if (valid.length) { const up = upgrade(valid); return { list: up, current: localStorage.getItem(CUR) ?? up[0].id } }
  } catch { /* 存储不可用或内容坏了 */ }
  upgrade([])
  return { list: seedWorkspaces, current: 'ws_all' }
}
export function saveWorkspaces(list: Workbench[], current: string) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); localStorage.setItem(CUR, current) } catch { /* 只在本次会话生效 */ }
}
