import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ConnectorDrawer, ConnectorsSettings } from './connectors'
import { ApiConnectorDrawer } from './apiconn'
import { backfillSlackEmails } from './slackemail'
import { ContactDrawer, ContactsPage, type Draft as ContactDraft } from './contacts'
import { LibraryBar, LibraryReader, LibraryTree, libraryModel, type Workspace } from './library'
import { pickFolder, readHandle, type LocalFolder } from './localdir'
import { IM_CHANNELS, IM_EXPIRE_DAYS_DEFAULT, seedConnectors, seedContacts, seedContent, seedMessages, TOOLS, type Connector, type Contact, type Message } from './data'
import { mentionMembers } from './mention'
import { MessageDrawer, MessagesPage, contactFor, fetchBlocker, gear, withGroupProjects, type MsgAction } from './messages'
import { GroupTriageAdvice, QueueDrawer, TriageAdvice, triageRunsOf, triageSops } from './triage'
import { SECTIONS, SettingsNav, type Section } from './settings'
import { CommandPalette, type PaletteItem } from './palette'
import { GOVERNANCE_DEFAULT, MODEL_CONCURRENCY_DEFAULT, SOPS, act as actOnRun, gateRuns, governRuns, isHeld, type Governance, rerunRuns, seedRuns, sopById, tick, runShow, runStatus, startRun, upsertSop, type Json, type RunAction } from './sopflow'
import { SopEditor, newSopDraft } from './sopedit'
import { ingest, newTask, seedDeliveries, seedHooks, seedTasks, type TaskStatus, isOpenTask, localDay } from './taskdata'
import { waitOf } from './taskpipeline'
import { stageLabel } from './taskstage'
import { TaskDrawer, TasksNav, TasksPage, WebhookPage, newHook, type TaskDraft, type TaskTab, type TaskView } from './tasks'
import { taskPrefill } from './tasksop'
import { ScheduleDrawer, SchedulesPage } from './schedule'
import { useRunPresets } from './runpresets'
import { claudeOutPath, dueReminders, nextRun, seedSchedules, sweepSchedule, syncPublishSchedules, taskReminder, whenText, type Schedule } from './scheduledata'
import { ReminderPopups, remindersOf, type Reminder } from './taskreminders'
import { TodayPage, type TodayItem, type TodayLine } from './today'
import { useDevLoop } from './devloop'
import { ALL_PROJECTS, EMPTY_DOCK, ProjectDock, ProjectPage, ProjectsListPage, type DockView, type ProjectDockState, type ProjectTab } from './projects'
import { PROJECT_COLORS, portConflict, seedProjects, startLogs, type Project } from './projectdata'
import { TerminalPage, launchTab, newTab, type TermTab } from './terminal'
import { TerminalSettingsPage } from './terminalsettings'
import { CLAUDE_COMMAND_DEFAULT, handoffFiles, renderClaudeCommand } from './handoff'
import { IncidentDrawer, IncidentsPage } from './incidents'
import { WorkspaceSwitcher, WorkspacesPage } from './workspaces'
import { loadWorkspaces, saveWorkspaces, type Workbench } from './workspacedata'
import { KbDrawer, KnowledgePage, SkillDrawer, SkillsPage } from './kbskills'
import { SWEEP_TAG, levelPriority, mergeIncident, seedIncidents, sweepHeldCount, sweepPick, sweepTaskDesc, type IncidentReport } from './incidentdata'
import { SopDetailPage, SopNav, SopRunView, SopRunsPage, SopSettingsPage, SopStartDrawer, type SopView } from './sop'
import { WorktreeSettingsPage } from './worktree'
import { EnumContext, seedEnums } from './enumdata'
import { SKILLS, newAgent, seedAgentRuns, seedAgents, seedKBs, seedOutputs, seedScenarios, seedSessions, type AgentOutput, type ChatMsg, type OutputKind, type Session, type ToolCall } from './agentdata'
import { AgentEditor, AgentsPage, CHAT_EXAMPLES, ChatPane, type ConnToolChoice, type ModelChoice, type MountableConn } from './agents'
import { ChatsView, OutputsView, RunsView, goneAgent, type SessionTools, type SessionView } from './sessions'
import { kindOf, seedModels, seedProviders, usable, type ProviderKind } from './modeldata'
import { ProviderDrawer, ProvidersPage } from './models'
import { EnumsPage, type UsageFn } from './enums'
import { TopbarContext } from './topbar'
import { AppearancePage, type ThemePref } from './appearance'
import { UpdatePage } from './update'
import { RunPresetsPage } from './runpresetspage'
import { cls } from './ui'
import { PLATFORMS, PLATFORM_TOOL, STAGES, checkPublish, coverRatioOf, dealReport, seedArtifacts, seedDeals, seedPublishes, seedSeries, seedTexts, seedVideos, videoState, type Deal, type PlatformKey, type Publish, type Video } from './videodata'
import { CalendarPage } from './videocalendar'
import { DealDrawer, DealsTab, dueDeals, payText } from './videodeals'
import { VideoDetail, VideosListPage, VideosTabs, type VideoView } from './videos'
import { PublishPage, SeriesPage, type ChannelState } from './videopublish'
import { ClipsPage, TopicsPage } from './topics'
import { seedClips, seedTopics, type Topic } from './topicdata'
import { BrowserPage, FrameAllowContext } from './browser'
import { HOME_URL, type GoogleAccount } from './browserdata'
import { OpenUrlContext, ProtoDomainContext } from './openurl'
import { DomainsPage } from './domains'
import { protoDomain, seedDomainRoutes, seedDomainSettings } from './domaindata'
import { projectMessages } from './projecttabs'
import { seedAccounts, seedAlertEvents, seedAlerts, seedOrders, seedPositions, seedRisk, seedRuns as seedTradeRuns, seedStrategies, seedWatchlists, type AlertEvent } from './tradedata'
import { MarketsPage } from './markets'
import { MonitorPage, checkAlerts } from './monitor'
import { EtfPage } from './etf'
import { TradingNav, TradingPage, killAll, type TradingView } from './trading'
import { BacktestReport, BacktestsPage, StrategyEditor, StrategyListPage, StrategyNav, type StrategyView } from './strategy'
import { runBacktest } from './backtest'
import { QuickSession } from './quicksession'
import { GroupDrawer, StartSessionDialog } from './msgagent'
import { IM_MATERIAL_TAG, ToMaterialDialog, notesOf } from './msgmaterial'
import { clusterMessages, threadForMany, threadForTask, threadOf, type SessionIntent } from './msggroup'
import { StrategyRunsPage } from './strategyruns'
import type { Backtest, BacktestConfig, Strategy } from './tradedata'
import { ATTACH_DIR, SYNC_POOL, type MsgAttachment } from './data'
import { newId } from './ids'
import { PageTitle } from './topbar'
import { OverviewPage, type OverviewKey } from './overview'

// 菜单从这里加：Page 加一个 key，MENU 加一行，main 里接上页面。设置不在 MENU 里，单独吸底
type Page = 'today' | 'projects' | 'contacts' | 'messages' | 'tasks' | 'library' | 'sop' | 'sessions' | 'terminal' | 'browser'
  | 'videos' | 'markets' | 'monitor' | 'strategy' | 'trading' | 'etf' | 'settings' | 'overview'

// 抽屉是全局的一个：从消息页「存为联系人」时，不用离开消息页就能打开联系人表单
type DrawerState =
  | { kind: 'contact'; id: string }
  | { kind: 'new-contact'; initial?: Partial<ContactDraft> }
  | { kind: 'message'; id: string; focus?: 'triage' }
  /** IM 消息页的处理队列（SPEC-messages-1.52） */
  | { kind: 'im-queue' }
  /** 合并显示的一组消息（SPEC-messages-4）；key 见 msggroup.clusterMessages */
  | { kind: 'im-group'; key: string }
  | { kind: 'connector'; id: string }
  | { kind: 'new-connector'; tool: string }
  | { kind: 'sop-start'; sopId: string; initial?: Json; /** 在任务上发起（SOP-06）：执行关联到这条任务，发起后回到任务详情 */ objectId?: string }
  | { kind: 'task'; id: string; tab?: TaskTab; run?: string; sopRun?: string }
  | { kind: 'schedule'; id: string }
  | { kind: 'incident'; id: string }
  | { kind: 'kb'; id: string }
  | { kind: 'new-kb' }
  | { kind: 'skill'; id: string }
  | { kind: 'new-skill'; from?: string }
  | { kind: 'new-schedule' }
  | { kind: 'provider'; id: string }
  | { kind: 'new-provider'; provider: ProviderKind }
  | { kind: 'new-task'; fromMessage?: string; initial?: Partial<TaskDraft> }
  | { kind: 'deal'; id: string }
  | { kind: 'new-deal'; initial?: Partial<Deal> }
  | null

/** 删除前算出的影响：block 有值时拦截不删，impact 列在二次确认里 */
type DelPlan = { block?: string; impact: string[] }
const nameList = (xs: string[], max = 3) => xs.slice(0, max).map((x) => `「${x}」`).join('、') + (xs.length > max ? ` 等 ${xs.length} 个` : '')
const lines = (...xs: (string | false | 0 | undefined)[]) => xs.filter((x): x is string => !!x)
/** 还没成交完的委托 */
const ACTIVE_ORDER = ['pending', 'open', 'partial']

/** 引用不变、调用时总走最新版本的回调：传给 memo 过的组件，免得每次渲染换一个新函数把 memo 打穿 */
function useStable<A extends unknown[], R>(f: (...a: A) => R): (...a: A) => R {
  const ref = useRef(f)
  ref.current = f
  return useCallback((...a: A) => ref.current(...a), [])
}

const icons: Record<Page, React.ReactNode> = {
  contacts: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><circle cx="6" cy="5.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M1.5 13.5c.6-2.4 2.3-3.6 4.5-3.6s3.9 1.2 4.5 3.6M11 3.2a2.4 2.4 0 0 1 0 4.6M12.6 10.2c1 .5 1.6 1.6 1.9 3.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  messages: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M5 6.5h6M5 8.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  library: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M9.3 2v3.2h3M6 8h4.5M6 10.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  today: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  projects: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M2 4.5c0-.6.4-1 1-1h3.2l1.4 1.5H13c.6 0 1 .4 1 1v6.5c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M5 9h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  terminal: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  sessions: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M2 3.5h8.5v5.5H6l-2.5 2V9H2Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M10.5 6H14v5.5h-1.5v2l-2.5-2H7.5V9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>,
  tasks: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m5.2 8.2 2 2 3.8-4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  sop: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><rect x="1.8" y="2" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9.8" y="6.2" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="1.8" y="10.4" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.2 3.8h2.2a1.4 1.4 0 0 1 1.4 1.4V8M9.8 8v2.8a1.4 1.4 0 0 1-1.4 1.4H6.2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>,
  browser: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  videos: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><rect x="1.8" y="3.2" width="9.2" height="9.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="m11 6.6 3.2-1.8v6.4L11 9.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  markets: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M4 3v10M4 5h-.01M12 4v8M8 6v7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><rect x="2.8" y="5.5" width="2.4" height="4.5" rx=".5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><rect x="6.8" y="7.5" width="2.4" height="3.5" rx=".5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><rect x="10.8" y="5" width="2.4" height="4" rx=".5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  monitor: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M1.8 8h2.6l1.6-4 3 8 1.6-4h3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  etf: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M2 13.5h12M4 11V8M7 11V5.5M10 11V7M13 11V3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
  strategy: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M2 13.5h12M3.5 11l3-3.5 2.5 2 4-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M10.5 4.5h2.5V7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  trading: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M3 5h9.5l-2.5-2.5M13 11H3.5L6 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  settings: <span className="side-icon">{gear}</span>,
  overview: <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="2" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9" y="2" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="2" y="9" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M9.5 10h4M9.5 12.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
}

export default function App() {
  // 工作台：决定菜单里有哪些模块、什么顺序、默认打开哪个
  const [benchState] = useState(loadWorkspaces)
  const [benches, setBenches] = useState<Workbench[]>(benchState.list)
  const [benchId, setBenchId] = useState(benchState.current)
  const bench = benches.find((w) => w.id === benchId) ?? benches[0]
  useEffect(() => { saveWorkspaces(benches, bench.id) }, [benches, bench.id])
  const [page, setPage] = useState<Page>(() => (bench.home as Page) ?? 'projects')
  const [section, setSection] = useState<Section>('connectors')
  // Agent 配置页有未保存的改动时，切二级菜单先让它确认
  const agentGuard = useRef<((leave: () => void) => boolean) | null>(null)
  const leaveAgent = (go: () => void) => { if (!agentGuard.current || agentGuard.current(go)) go() }
  const [content, setContent] = useState(seedContent)
  const [ws, setWs] = useState<Workspace>('builtin')
  /** 默认工作目录（SPEC-library-1.53）：从别处进文档就停在它；原型只记在本次打开里 */
  const [defaultWs, setDefaultWs] = useState<Workspace>('builtin')
  const [libKind, setLibKind] = useState('')
  const [libQ, setLibQ] = useState('')
  const [reading, setReading] = useState<string | null>(null)
  const [folders, setFolders] = useState<LocalFolder[]>([])
  const [runs, setRuns] = useState(seedRuns)
  const [sops, setSops] = useState(() => [...SOPS])
  const [tasks, setTasks] = useState(seedTasks)
  const [hooks, setHooks] = useState(seedHooks)
  const [deliveries, setDeliveries] = useState(seedDeliveries)
  const [taskView, setTaskView] = useState<TaskView>('all')
  const [schedules, setSchedules] = useState(seedSchedules)
  // 提醒（定时任务动作 remind）到点在右下角弹出，点「知道了」或「打开任务」才收
  const [reminderPops, setReminderPops] = useState<Reminder[]>([])
  const [incidents, setIncidents] = useState(seedIncidents)
  /** 记一条运行异常；同一个问题按指纹合并 */
  const report = (r: IncidentReport) => setIncidents((xs) => mergeIncident(xs, r))
  const [projects, setProjects] = useState(seedProjects)
  // 视频：制作流程、产出物、系列、发布记录
  const [videos, setVideos] = useState(seedVideos)
  const [artifacts, setArtifacts] = useState(seedArtifacts)
  const [series, setSeries] = useState(seedSeries)
  const [publishes, setPublishes] = useState(seedPublishes)
  // 内容编写里写的文稿正文、草稿和执行器初稿
  const [videoTexts, setVideoTexts] = useState(seedTexts)
  const [videoView, setVideoView] = useState<VideoView>('all')
  // 打开某一集时记下从哪进来的：从系列进的标签高亮「系列」，否则高亮「全部视频」
  const [videoFrom, setVideoFrom] = useState<VideoView | undefined>()
  const openVideo = (id: string) => { setVideoFrom(videoView); setVideoView(`video:${id}`) }
  const [publishFilter, setPublishFilter] = useState<string | undefined>()
  // 商单（VID-08p）：挂在项目下，视频挂到商单上
  const [deals, setDeals] = useState(seedDeals)
  // 定时发布跟着发布记录走：发布记录定了时间、改了时间、删了，定时任务跟着补、改、删（updater 是纯函数）
  useEffect(() => { setSchedules((xs) => syncPublishSchedules(xs, publishes)) }, [publishes])
  // 发布失败进运行异常：发布记录从别的状态变成失败时记一条，指纹按发布记录
  const prevPubs = useRef(publishes)
  useEffect(() => {
    const prev = prevPubs.current
    prevPubs.current = publishes
    for (const p of publishes) {
      if (p.status !== 'failed' || prev.find((x) => x.id === p.id)?.status === 'failed') continue
      const v = videos.find((x) => x.id === p.video_id)
      const pl = PLATFORMS.find((x) => x.key === p.platform)?.label ?? p.platform
      setIncidents((xs) => mergeIncident(xs, { fingerprint: `publish:${p.id}`, level: 'error', module: '发布', title: `${pl}发布失败：${p.title || v?.title || '未填标题'}`, message: p.error ?? '发布失败', context: { 视频: v?.title ?? '已删除的视频', 平台: pl } }))
    }
  }, [publishes, videos])
  // 选题和素材收件箱
  const [topics, setTopics] = useState(seedTopics)
  const [clips, setClips] = useState(seedClips)
  const [topicFocus, setTopicFocus] = useState<{ id: string; n: number } | null>(null)
  /** 停在检查点上等我验收的集数 */
  const videoWaiting = videos.filter((v) => videoState(v).tone === 'warn').length
  // 内置浏览器：别处要打开地址就发一个请求；Google 账号登录后连带接上 Drive 和日历连接器
  const [browserReq, setBrowserReq] = useState<{ url: string; title?: string; n: number } | null>(null)
  const [google, setGoogle] = useState<GoogleAccount | null>(null)
  // 内网域名
  const [domainSettings, setDomainSettings] = useState(seedDomainSettings)
  const [domainRoutes, setDomainRoutes] = useState(seedDomainRoutes)
  /** 浏览器里用户加进白名单的主机，只存内存 */
  const [frameHosts, setFrameHosts] = useState<string[]>([])
  // 交易：自选、提醒、账户、持仓、委托、策略运行、风控；行情本身是确定性模拟，不进 state
  const [watchlists, setWatchlists] = useState(seedWatchlists)
  const [alerts, setAlerts] = useState(seedAlerts)
  const [alertEvents, setAlertEvents] = useState(seedAlertEvents)
  const [strategies, setStrategies] = useState(seedStrategies)
  const [accounts, setAccounts] = useState(seedAccounts)
  const [positions, setPositions] = useState(seedPositions)
  const [orders, setOrders] = useState(seedOrders)
  const [tradeRuns, setTradeRuns] = useState(seedTradeRuns)
  const [risk, setRisk] = useState(seedRisk)
  const [tradingView, setTradingView] = useState<TradingView>('overview')
  const [strategyView, setStrategyView] = useState<StrategyView>('list')
  const [backtests, setBacktests] = useState<Backtest[]>([])
  // 跨页请求：n 递增即触发一次
  const [chartFocus, setChartFocus] = useState<{ symbol: string; n: number } | null>(null)
  const [alertReq, setAlertReq] = useState<{ symbol: string; n: number } | null>(null)
  const [orderReq, setOrderReq] = useState<{ symbol: string; side: 'buy' | 'sell'; n: number } | null>(null)
  const [deployReq, setDeployReq] = useState<{ strategyId: string; n: number } | null>(null)
  // 盯盘提醒每 5 秒查一次，不管现在在哪个页面
  const alertsRef = useRef(alerts)
  alertsRef.current = alerts
  useEffect(() => {
    const t = window.setInterval(() => {
      const at = Date.now()
      const fired = checkAlerts(alertsRef.current, at)
      if (!fired.length) return
      const iso = new Date(at).toISOString()
      const ids = new Set(fired.map((f) => f.alert.id))
      setAlerts((xs) => xs.map((x) => (ids.has(x.id) ? { ...x, last_fired_at: iso } : x)))
      setAlertEvents((xs) => [...fired.map((f, i): AlertEvent => ({ id: `ae_${at.toString(36)}${i}`, alert_id: f.alert.id, symbol: f.alert.symbol, text: f.text, price: f.price, at: iso, read: false })), ...xs])
    }, 5000)
    return () => window.clearInterval(t)
  }, [])
  // 项目没有二级菜单：进「项目」是全部项目列表，点列表里的项目进详情，详情顶栏「项目」点回列表
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS)
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview')
  // 最近打开的项目，新的在前：项目菜单只露这几个，完整列表在「全部项目」
  const [recentProjects, setRecentProjects] = useState<string[]>(() => (seedProjects[0] ? [seedProjects[0].id] : []))
  useEffect(() => {
    if (projectId && projectId !== ALL_PROJECTS) setRecentProjects((xs) => [projectId, ...xs.filter((x) => x !== projectId)].slice(0, 20))
  }, [projectId])
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  // 终端的标签页放在 App 里：切到别的菜单再回来，窗格里的内容还在
  const [termTabs, setTermTabs] = useState<TermTab[]>(() => [newTab(seedProjects[0]?.root ?? '/Users/me', '工作台')])
  const [termActive, setTermActive] = useState('')
  // 设置 > 终端 > Claude Code 启动命令（SPEC-settings-22）
  const [claudeCommand, setClaudeCommand] = useState(CLAUDE_COMMAND_DEFAULT)
  // 项目里的终端和浏览器（标题行按钮展开的那块）：按项目各一份，和一级菜单的终端、浏览器互不相干
  const [docks, setDocks] = useState<Record<string, ProjectDockState>>({})
  const browserKey = useRef(0)
  const [enums, setEnums] = useState(seedEnums)
  const [agents, setAgents] = useState(seedAgents)
  const [agentScenarios, setAgentScenarios] = useState(seedScenarios)
  const [agentRuns, setAgentRuns] = useState(seedAgentRuns)
  const [agentView, setAgentView] = useState<string>('list')
  const [kbs, setKbs] = useState(seedKBs)
  const [skills, setSkills] = useState(SKILLS)
  const [sessions, setSessions] = useState(seedSessions)
  const [outputs, setOutputs] = useState(seedOutputs)
  /** 产出结果点来源跳到执行记录时，要定位的那一条 */
  const [runFocus, setRunFocus] = useState<string | null>(null)
  const [sessionView, setSessionView] = useState<SessionView>('chats')
  const [currentSession, setCurrentSession] = useState<string | null>(seedSessions[0]?.id ?? null)
  // 项目 Agent 标签里就地打开的会话（SPEC-projects-10.13），不跳会话页；切项目时清掉
  const [projectChat, setProjectChat] = useState<string | null>(null)
  const [pickAgent, setPickAgent] = useState(0)
  const [providers, setProviders] = useState(seedProviders)
  const [models, setModels] = useState(seedModels)
  const [sopView, setSopView] = useState<SopView>('runs')
  /** 执行记录页预先按这个 SOP 筛（从流程详情「在执行记录里看全部」跳过来） */
  const [sopFilter, setSopFilter] = useState<string | undefined>()
  /** 会话页预先按这个项目筛（从项目 Agent 页签「查看全部」跳过来） */
  const [sessionProject, setSessionProject] = useState<string | undefined>()
  const [openRun, setOpenRun] = useState<string | null>(null)
  /** 运行页是从哪条任务的「SOP 执行」点进来的（SOP-06）：「返回」回到任务页并重新打开这条任务 */
  const [runFromTask, setRunFromTask] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  // 连接器分类筛选的初值：从 IM 消息页进来时是 im，从侧栏进来时不限
  const [connCat, setConnCat] = useState('')
  const [contacts, setContacts] = useState(seedContacts)
  const [rawMessages, setMessages] = useState(seedMessages)
  /** 群组默认归属的项目：群的会话键 g:<渠道>|<群名> -> 项目 id，在 IM 消息页选中群标签时设 */
  const [groupProjects, setGroupProjects] = useState<Record<string, string>>({})
  // 别处读到的消息都已按群组默认项目兜底（同正式产品后端读时兜底）；写消息仍改 rawMessages
  const messages = useMemo(() => withGroupProjects(rawMessages, groupProjects, projects), [rawMessages, groupProjects, projects])
  /** 超过几天没处理的消息标为已过期（IM-07），0 为不过期；在设置的连接器页即时通讯分类里改 */
  const [imExpireDays, setImExpireDays] = useState(IM_EXPIRE_DAYS_DEFAULT)
  const [connectors, setConnectors] = useState(seedConnectors)
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const [palette, setPalette] = useState(false)
  // 快速新建会话：⌘J 或侧栏按钮唤出；第一句话交给会话页自动发出
  const [quickSession, setQuickSession] = useState(false)
  /** IM 消息「发起会话 / 拆分任务」弹窗（SPEC-messages-5） */
  const [imStart, setImStart] = useState<{ ids: string[]; intent: SessionIntent } | null>(null)
  /** IM 消息「转项目资料」弹窗（SPEC-messages-6）；从消息上「已转资料」跳到项目资料页时高亮的那一条 */
  const [imToMat, setImToMat] = useState<string[] | null>(null)
  const [matFocus, setMatFocus] = useState<string | null>(null)
  const [firstMessage, setFirstMessage] = useState<{ sessionId: string; text: string } | null>(null)
  const [topSlot, setTopSlot] = useState<HTMLDivElement | null>(null)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('pmw-next-side') === 'collapsed' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('pmw-next-side', collapsed ? 'collapsed' : 'open') } catch { /* 拿不到存储就只在本次会话生效 */ }
  }, [collapsed])
  const [theme, setTheme] = useState<ThemePref>(() => {
    try { return (localStorage.getItem('pmw-next-theme') as ThemePref) || 'light' } catch { return 'light' }
  })
  // 跟随系统时听系统明暗变化
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
    try { localStorage.setItem('pmw-next-theme', theme) } catch { /* 无痕模式下拿不到存储，主题只在本次会话生效 */ }
  }, [theme, systemDark])

  // SOP 步骤失败记进运行异常；每次执行的每一步只记一次
  const reportedSteps = useRef(new Set<string>())
  useEffect(() => {
    for (const r of runs) r.steps.forEach((st, i) => {
      const k = `${r.id}:${st.key}:${st.attempts}`
      if (st.status !== 'failed' || reportedSteps.current.has(k)) return
      reportedSteps.current.add(k)
      // 演示数据里那次失败已经在异常记录里了，不重复记
      if (r.id.startsWith('run_seed')) return
      const def = r.sop.steps[i]
      report({ fingerprint: `sop:${r.sop_id}:${st.key}`, level: 'error', module: 'SOP', title: `「${r.sop.name}」${def.name}失败`, message: st.error ?? '步骤执行失败', context: { SOP: r.sop.name, 步骤: def.name, 执行: r.title, 输入: st.input ?? {} } })
    })
  }, [runs])
  // 页面自己的报错：真的捕获，不是演示数据
  useEffect(() => {
    const onErr = (e: ErrorEvent) => report({ fingerprint: `front:${e.message}`, level: 'error', module: '前端', title: e.message.slice(0, 80) || '页面报错', message: `${e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : '页面脚本'} 抛出未捕获的异常`, stack: e.error?.stack ?? String(e.message), context: { 页面: document.title, 地址: location.href } })
    const onRej = (e: PromiseRejectionEvent) => report({ fingerprint: `front:rejection:${String(e.reason)}`, level: 'error', module: '前端', title: `未处理的 Promise 异常：${String(e.reason).slice(0, 60)}`, message: '有异步操作失败了但没人处理', stack: (e.reason as Error)?.stack ?? String(e.reason), context: { 地址: location.href } })
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => { window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onRej) }
  }, [])

  // SOP 的步骤靠这个定时器往前推；没有执行中的步骤就不动 state。
  // 推完再按「同时调模型的步骤数」（SOP-07）跨执行放行，多出来的排队；定时器里读 ref，改了下一拍就生效
  const [sopConcurrency, setSopConcurrency] = useState(MODEL_CONCURRENCY_DEFAULT)
  const sopConcurrencyRef = useRef(sopConcurrency)
  useEffect(() => { sopConcurrencyRef.current = sopConcurrency }, [sopConcurrency])
  // 流水线治理（AUTO-12，SPEC-sop-15）：Claude Code 并发排队、每需求次数和时长上限，超了这一步暂停等人放行
  const [sopGov, setSopGov] = useState<Governance>(GOVERNANCE_DEFAULT)
  const sopGovRef = useRef(sopGov)
  useEffect(() => { sopGovRef.current = sopGov }, [sopGov])
  useEffect(() => {
    const t = window.setInterval(() => setRuns((xs) => (xs.some((r) => runStatus(r) === 'running')
      ? governRuns(gateRuns(xs.map((r) => tick(r)), sopConcurrencyRef.current), sopGovRef.current) : xs)), 250)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    const onK = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v) }
      if (e.key.toLowerCase() === 'j') { e.preventDefault(); setPalette(false); setQuickSession((v) => !v) }
    }
    window.addEventListener('keydown', onK)
    return () => window.removeEventListener('keydown', onK)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const patchContact = (id: string, p: Partial<Contact>) => setContacts((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const patchMsg = (id: string, p: Partial<Message>) => setMessages((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)))
  // 立即同步（模拟）：选了渠道只同步那个渠道，否则同步全部 IM 连接器；1 秒后出结果
  // 连接正常的取下一批待到达的消息并更新同步时间；连接异常的同步失败并记运行异常；暂停、断开的跳过
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ at: string; text: string; bad: boolean } | null>(null)
  const syncCursor = useRef<Record<string, number>>({})
  const syncMessages = (channel?: string) => {
    if (syncing) return
    const im = connectors.filter((c) => TOOLS.find((t) => t.key === c.tool)?.category === 'im' && (!channel || c.tool === channel))
    const targets = im.filter((c) => c.status === 'connected' || c.status === 'error')
    if (!targets.length) {
      setSyncResult({ at: new Date().toISOString(), text: im.length ? '这些渠道都暂停或断开了，没有可同步的' : '还没接入 IM 渠道', bad: true })
      return
    }
    setSyncing(true)
    window.setTimeout(() => {
      const now = new Date().toISOString()
      const ok = targets.filter((c) => c.status === 'connected')
      const bad = targets.filter((c) => c.status === 'error')
      const fresh: Message[] = ok.flatMap((c) => {
        const batches = SYNC_POOL[c.tool] ?? []
        const i = syncCursor.current[c.id] ?? 0
        if (i >= batches.length) return []
        syncCursor.current[c.id] = i + 1
        return batches[i].map((m): Message => ({
          ...m, id: newId('msg'), channel: c.tool, connector_id: c.id, at: now, read: false, status: 'pending', snooze_until: null, expired_at: null, replies: [],
          attachments: m.attachments?.map((a) => ({ ...a, id: newId('att') })),
        }))
      })
      if (fresh.length) setMessages((xs) => [...fresh, ...xs])
      if (ok.length) setConnectors((xs) => xs.map((c) => (ok.some((o) => o.id === c.id) ? { ...c, last_sync_at: now } : c)))
      for (const c of bad) report({ fingerprint: `conn:${c.id}:sync`, level: 'warn', module: '连接器', title: `${c.name}同步失败`, message: c.error ?? '连接异常', context: { 连接器: c.name } })
      const parts = [fresh.length ? `收到 ${fresh.length} 条新消息` : ok.length ? '没有新消息' : '', bad.length ? `${bad.map((c) => c.name).join('、')}同步失败` : ''].filter(Boolean)
      setSyncResult({ at: now, text: parts.join('；'), bad: bad.length > 0 })
      setSyncing(false)
    }, 1000)
  }
  // 消息附件：获取 = 从 IM 平台下载到本地（模拟 0.8 秒）；渠道连接异常时取不到
  const patchAtt = (msgId: string, attId: string, f: (a: MsgAttachment) => MsgAttachment) =>
    setMessages((xs) => xs.map((m) => (m.id !== msgId ? m : { ...m, attachments: m.attachments?.map((a) => (a.id === attId ? f(a) : a)) })))
  const fetchAttachment = (msgId: string, attId: string, then?: (local: string) => void) => {
    const m = messages.find((x) => x.id === msgId)
    const a = m?.attachments?.find((x) => x.id === attId)
    if (!m || !a) return
    const conn = connectors.find((c) => c.id === m.connector_id)
    // 失败原因按连接器实际状态说，分类同回复受阻；只有连接器异常记运行异常，删了、暂停、断开、连接中不记
    const blocked = fetchBlocker(conn)
    patchAtt(msgId, attId, (x) => ({ ...x, fetch: 'fetching', error: undefined }))
    window.setTimeout(() => {
      if (blocked) {
        patchAtt(msgId, attId, (x) => ({ ...x, fetch: 'error', error: blocked.text }))
        if (blocked.incident) report({ fingerprint: `att:${m.connector_id}`, level: 'warn', module: 'IM 消息', title: '附件获取失败', message: `「${a.name}」没取到：连接器「${conn?.name}」异常`, context: { 消息: m.id, 附件: a.name, 渠道: conn?.name ?? m.channel } })
        return
      }
      const local = `${ATTACH_DIR}/${a.name}`
      patchAtt(msgId, attId, (x) => ({ ...x, fetch: 'done', local }))
      then?.(local)
    }, 800)
  }
  // 加进项目支持材料：链接直接加；文件和图片没获取的先获取，取到了再加
  const addAttachmentToProject = (projectId: string, msgId: string, attId: string) => {
    const m = messages.find((x) => x.id === msgId)
    const a = m?.attachments?.find((x) => x.id === attId)
    if (!m || !a) return
    const push = (value: string) => setProjects((ps) => ps.map((pj) => pj.id !== projectId || pj.materials.some((x) => x.from?.attachment_id === attId) ? pj : {
      ...pj,
      skipped_attachments: pj.skipped_attachments?.filter((x) => x !== attId),
      materials: [{ id: `mt_${Date.now().toString(36)}`, name: a.name, kind: a.kind === 'link' ? 'link' : 'file', value, tags: ['消息附件'], added_at: new Date().toISOString(),
        from: { message_id: m.id, attachment_id: a.id, sender: m.sender_name, conversation: m.conversation || '私聊' } }, ...pj.materials],
    }))
    if (a.kind === 'link') push(a.url ?? '')
    else if (a.fetch === 'done' && a.local) push(a.local)
    else fetchAttachment(msgId, attId, push)
  }

  // 打开原消息时，它消息列里没读的回复一起标为已读（消息列回复在原消息抽屉里看，SPEC-messages-1.62）
  const openMessage = (id: string) => {
    setMessages((xs) => xs.map((x) => (x.id === id || (x.thread?.parent_id === id && !x.read) ? { ...x, read: true } : x)))
    setDrawer({ kind: 'message', id })
  }
  // 一组消息发起过的会话（新的在前）、拆出来的任务数（SPEC-messages-1.58）：会话来源里有这组的消息就算；任务按来源消息算，不含转任务那条
  const imLinksOf = (ids: string[]) => {
    const ss = sessions.filter((x) => x.source?.message_ids.some((id) => ids.includes(id))).sort((a, b) => b.created_at.localeCompare(a.created_at))
    const tasksN = tasks.filter((t) => t.source.kind === 'im' && t.source.session_id && ids.includes(t.source.message_id)).length
    return { sessions: ss.map((x) => x.id), tasks: tasksN }
  }
  // 转项目资料（SPEC-messages-6）：去项目的支持材料，高亮那一条
  const openMaterial = (projectId: string, materialId: string) => {
    setPage('projects'); setProjectId(projectId); setProjectTab('materials'); setMatFocus(materialId); setDrawer(null); setImToMat(null)
  }
  // 存成一条笔记，出处记这组消息；选了附件的按附件「加入资料」同一条路径加（没获取的先获取，已加过的跳过）
  // extraIds：勾了「带上消息列」时消息列里另外带上的消息，出处、附件算上，不跟着标已处理（SPEC-messages-6）
  const saveImMaterial = (ids: string[], projectId: string, title: string, body: string, withAtts: boolean, markDone: boolean, extraIds: string[] = []) => {
    const ms = messages.filter((m) => ids.includes(m.id) || extraIds.includes(m.id)).sort((a, b) => a.at.localeCompare(b.at))
    const last = ms[ms.length - 1]
    if (!last) return
    const who = (m: Message) => contactFor(m, contacts)?.name ?? m.sender_name
    const id = `mt_${Date.now().toString(36)}`
    setProjects((ps) => ps.map((pj) => pj.id !== projectId ? pj : {
      ...pj,
      materials: [{ id, name: title, kind: 'note', value: body, tags: [IM_MATERIAL_TAG], added_at: new Date().toISOString(),
        from: { message_id: last.id, attachment_id: '', sender: who(last), conversation: last.conversation || '私聊', message_ids: ms.map((m) => m.id) } }, ...pj.materials],
    }))
    if (withAtts) for (const m of ms) for (const a of m.attachments ?? []) addAttachmentToProject(projectId, m.id, a.id)
    if (markDone) for (const m of ms) if (ids.includes(m.id) && (m.status === 'pending' || m.status === 'expired')) actOnMessage(m.id, { kind: 'done' })
    setImToMat(null)
  }
  const openSessionById = (id: string) => { setCurrentSession(id); setPage('sessions'); setSessionView('chats'); setDrawer(null) }
  const actOnMessage = (id: string, a: MsgAction) => {
    const m = messages.find((x) => x.id === id)
    if (!m) return
    switch (a.kind) {
      case 'done': patchMsg(id, { status: 'done', snooze_until: null, expired_at: null, read: true }); break
      case 'ignore': patchMsg(id, { status: 'ignored', snooze_until: null, expired_at: null, read: true }); break
      // 重新打开：过期从现在重新算（IM-07）
      case 'reopen': patchMsg(id, { status: 'pending', snooze_until: null, expired_at: null, expire_from: new Date().toISOString() }); break
      case 'read': patchMsg(id, { read: true }); break
      case 'snooze': patchMsg(id, { snooze_until: a.until, read: true }); break
      case 'reply': {
        const now = new Date().toISOString()
        patchMsg(id, {
          read: true,
          replies: [...m.replies, { id: `r_${Date.now().toString(36)}`, text: a.text, at: now }],
          ...(a.done ? { status: 'done', snooze_until: null, expired_at: null } : {}),
        })
        // 回了消息就算联系过一次，联系人的「最近联系」跟着走
        const who = contactFor(m, contacts)
        if (who) patchContact(who.id, { last_contact_at: now })
      }
    }
  }

  // 稍后到点：在最早的提醒时间清掉 snooze_until，消息回到待处理，各处计数跟着变（正式产品由后端到点改回）
  const nextWake = messages.reduce((n, m) => {
    const t = m.status === 'pending' && m.snooze_until ? new Date(m.snooze_until).getTime() : Infinity
    return t < n ? t : n
  }, Infinity)
  useEffect(() => {
    if (nextWake === Infinity) return
    const t = window.setTimeout(() => {
      const now = Date.now()
      setMessages((xs) => xs.map((m) => (m.snooze_until && new Date(m.snooze_until).getTime() <= now ? { ...m, snooze_until: null } : m)))
    }, Math.min(Math.max(nextWake - Date.now(), 0) + 200, 2 ** 31 - 1))
    return () => window.clearTimeout(t)
  }, [nextWake])

  // 过期（IM-07）：待处理、没在稍后里的，从收到（或重新打开）起超过 imExpireDays 天就标为已过期；在最早的到期时间触发。
  // 天数改短时到期时间已过，马上标；改长不会把已过期的改回来。正式产品由后端定时标
  const expireAt = (m: Message) => new Date(m.expire_from ?? m.at).getTime() + imExpireDays * 86400_000
  const nextExpire = imExpireDays <= 0 ? Infinity : messages.reduce((n, m) => {
    const t = m.status === 'pending' && !(m.snooze_until && new Date(m.snooze_until).getTime() > Date.now()) ? expireAt(m) : Infinity
    return t < n ? t : n
  }, Infinity)
  useEffect(() => {
    if (nextExpire === Infinity) return
    const t = window.setTimeout(() => {
      const now = Date.now()
      const iso = new Date(now).toISOString()
      setMessages((xs) => xs.map((m) => (m.status === 'pending' && !(m.snooze_until && new Date(m.snooze_until).getTime() > now) && expireAt(m) <= now
        ? { ...m, status: 'expired', expired_at: iso } : m)))
    }, Math.min(Math.max(nextExpire - Date.now(), 0) + 200, 2 ** 31 - 1))
    return () => window.clearTimeout(t)
    // expireAt 只依赖 imExpireDays
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextExpire, imExpireDays])

  const pending = messages.filter((m) => m.status === 'pending' && !(m.snooze_until && new Date(m.snooze_until).getTime() > Date.now())).length
  const brokenConnectors = connectors.filter((c) => c.status === 'error').length
  const messageCount = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const m of messages) acc[m.connector_id] = (acc[m.connector_id] ?? 0) + 1
    return acc
  }, [messages])

  // 已重跑过的失败执行不算（SPEC-sop-4.21）
  const sopWaiting = runs.filter((r) => ['waiting', 'failed'].includes(runShow(r))).length

  const openTasks = tasks.filter((t) => isOpenTask(t.status)).length
  const patchTask = (id: string, p: Partial<(typeof tasks)[number]>) => setTasks((xs) => xs.map((x) => (x.id === id ? { ...x, ...p, updated_at: new Date().toISOString() } : x)))
  // 开发任务闭环：进展、产出物、交给 Claude Code 的执行记录
  const dev = useDevLoop(patchTask)
  const openTaskFromMessage = (id: string) => {
    const m = messages.find((x) => x.id === id)
    if (!m) return
    const existing = tasks.find((t) => t.source.kind === 'im' && t.source.message_id === id)
    setDrawer(existing ? { kind: 'task', id: existing.id } : { kind: 'new-task', fromMessage: id, initial: { title: m.text.replace(/\s+/g, ' ').slice(0, 40), desc: '' } })
  }
  const assignees = ['我', ...contacts.filter((c) => c.group === '同事').map((c) => c.name)]
  /** 内容平台的接入情况：没接、异常、只能手动登记、能自动发 */
  const channelOf = (k: PlatformKey): ChannelState => {
    const c = connectors.find((x) => x.tool === PLATFORM_TOOL[k])
    const canPublish = TOOLS.find((t) => t.key === PLATFORM_TOOL[k])?.catalog?.some((d) => d.write && /upload|create_video/.test(d.name))
    return !c ? { state: 'none' } : c.status === 'error' ? { state: 'error', name: c.name, error: c.error } : c.status !== 'connected' ? { state: 'none' } : { state: canPublish ? 'ok' : 'manual', name: c.name }
  }
  // 发一条提醒：弹到右下角，结果文字带上关联任务的编号；任务删了不带跳转
  const fireReminder = (a: { title: string; body: string; task_id: string; popup?: 'toast' | 'modal' }, at: Date) => {
    const t = a.task_id ? tasks.find((x) => x.id === a.task_id) : undefined
    setReminderPops((xs) => [{ id: `rm_${at.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, at: at.toISOString(), title: a.title, body: a.body || t?.title || '', taskId: t?.id, taskRef: t?.ref, popup: a.popup }, ...xs])
    return { text: `提醒了「${a.title}」${t ? `，关联 ${t.ref}` : a.task_id ? '（关联的任务已删除，通知不带跳转）' : ''}`, ref: t?.ref }
  }
  // 原型的到点只模拟「只提醒一次」的提醒：每 15 秒看一眼，到点了弹出、记一条执行记录、自动停用（正式产品由后端调度器做，重复的也会到点提醒）
  const fireDueRef = useRef<() => void>(() => {})
  fireDueRef.current = () => {
    const due = dueReminders(schedules)
    if (!due.length) return
    const now = new Date()
    const done = new Map(due.map((sc) => {
      const a = sc.action as { title: string; body: string; task_id: string; popup?: 'toast' | 'modal' }
      const at = new Date(`${sc.rule.date}T${sc.rule.time}`)
      // 晚于 2 分钟的算错过，不补发（和正式产品的 missed 口径一致）
      if (now.getTime() - at.getTime() > 2 * 60000) return [sc.id, { at: at.toISOString(), ok: false, text: '没执行：到点时服务没在运行，没有补跑' }]
      const r = fireReminder(a, now)
      return [sc.id, { at: at.toISOString(), ok: true, text: r.text, ref: r.ref }]
    }))
    setSchedules((xs) => xs.map((y) => { const h = done.get(y.id); return h ? { ...y, enabled: false, history: [h, ...y.history] } : y }))
  }
  useEffect(() => {
    const id = window.setInterval(() => fireDueRef.current(), 15000)
    return () => window.clearInterval(id)
  }, [])

  const runPresets = useRunPresets()
  // 立即执行一次定时任务：真的建任务 / 发起 SOP / 记一条 Agent 执行 / 发布视频，再把结果写进它的执行记录
  const runScheduleNow = (sc: Schedule) => {
    const now = new Date()
    const a = sc.action
    let text = ''
    let ref: string | undefined
    let files: string[] | undefined
    if (a.kind === 'task') {
      const dueAt = new Date(now); dueAt.setDate(dueAt.getDate() + a.due_days)
      const due = localDay(dueAt)
      const t = newTask(tasks, { title: a.title.replace(/\{\{\s*date\s*\}\}/g, now.toLocaleDateString('zh-CN')), desc: a.desc, priority: a.priority, assignee: a.assignee, due, source: { kind: 'schedule', schedule_id: sc.id, name: sc.name } })
      setTasks((xs) => [t, ...xs])
      text = `建了任务 ${t.ref}`
      ref = t.ref
    } else if (a.kind === 'remind') {
      const r = fireReminder(a, now)
      text = r.text
      ref = r.ref
    } else if (a.kind === 'sop') {
      const sop = sops.find((x) => x.id === a.sop_id)
      if (!sop) text = '没执行：SOP 已删除'
      else {
        const run = startRun(sop, Object.fromEntries(sop.fields.map((f) => [f.key, f.default ?? ''])), false, Date.now(), { source: 'schedule', sourceRef: sc.id, sourceName: sc.name })
        setRuns((xs) => [run, ...xs])
        text = `发起了「${sop.name}」`
      }
    } else if (a.kind === 'incident_sweep') {
      // 运行异常巡检（INC-01）：满足条件、未处理、还没有任务的各建一条任务交给 Claude Code 修，带 claude-code 标签；同一条不重复建
      const pick = sweepPick(incidents, a)
      const held = sweepHeldCount(incidents, a)
      // 跳过的：未处理、没任务，但级别或次数不够（和正式产品的执行记录口径一致）
      const skipped = incidents.filter((x) => x.status === 'open' && !x.task_id).length - pick.length - held
      let list = tasks
      const made = pick.map((x) => {
        const t = newTask(list, {
          title: `[异常] ${x.module}：${x.title}`, desc: sweepTaskDesc(x), priority: levelPriority(x), assignee: '',
          source: { kind: 'incident', incident_id: x.id, title: x.title }, tags: [SWEEP_TAG],
        })
        list = [t, ...list]
        return { x, t }
      })
      if (made.length) {
        setTasks(list)
        setIncidents((xs) => xs.map((x) => { const m = made.find((y) => y.x.id === x.id); return m ? { ...x, status: 'tasked', task_id: m.t.id, note: undefined } : x }))
      }
      text = [made.length ? `建了 ${made.length} 条修复任务 ${made.map((m) => m.t.ref).join('、')}` : '没有要处理的运行异常', held > 0 && `${held} 条留给你处理（修复任务被删过，或是 Claude Code 执行失败）`, skipped > 0 && `跳过 ${skipped} 条（级别或次数不够）`].filter(Boolean).join('，')
      ref = made[0]?.t.ref
    } else if (a.kind === 'claude') {
      // 交给 Claude Code（TSK-0429）：原型不真的跑，按配置记一条；正式产品无人值守跑一次流式执行，结论和写出的文件回填这条记录
      const day = localDay(now)
      const role = runPresets.find((x) => x.id === a.preset_id)
      const write = a.allow_writes && role?.permission !== 'read_only'
      if (a.preset_id && !role) text = '没执行：角色已删除'
      else if (!write) text = '只读跑完：结论记在这里，没写文件'
      else {
        const out = claudeOutPath(a)
        files = [`${out}/${day}.md`, `${out}/${day}.json`]
        text = 'Claude Code 跑完，写了 2 个文件'
      }
    } else if (a.kind === 'publish') {
      // 按发布记录发：平台没接好或校验不过就失败，失败的由上面的 effect 记进运行异常
      const p = publishes.find((x) => x.id === a.publish_id)
      const pl = p ? PLATFORMS.find((x) => x.key === p.platform)?.label ?? p.platform : ''
      if (!p) text = '没执行：发布记录已删除'
      else if (p.status === 'published') text = '没执行：已经发布过了'
      else {
        const ch = channelOf(p.platform)
        const cover = artifacts.find((x) => x.id === p.cover_id)
        const bad = ch.state === 'error' ? `${pl}连接器异常：${ch.error ?? '连不上'}`
          : ch.state !== 'ok' ? `${pl}没接能自动发布的连接器，只能手动登记`
            : checkPublish(p.platform, { title: p.title, desc: p.desc, tags: p.tags ?? [], cover: cover ? coverRatioOf(cover) : undefined }).find((c) => !c.ok)?.text
        if (bad) {
          setPublishes((xs) => xs.map((x) => (x.id === p.id ? { ...x, status: 'failed', error: bad } : x)))
          text = `发布失败：${bad}，已记进运行异常`
        } else {
          setPublishes((xs) => xs.map((x) => (x.id === p.id ? { ...x, status: 'published', published_at: now.toISOString(), error: undefined, url: x.url ?? `https://example.com/${p.platform}/${p.id}`, metrics: { views: 0, likes: 0, comments: 0, shares: 0, updated_at: now.toISOString() } } : x)))
          text = `${pl}发布了「${p.title || '未填标题'}」`
        }
      }
    } else {
      const ag = agents.find((x) => x.id === a.agent_id)
      if (!ag || !ag.enabled) text = `没执行：${ag ? `${ag.name} 已停用` : 'Agent 已删除'}`
      else {
        setAgentRuns((xs) => [{ id: `ar_${Date.now().toString(36)}`, agent_id: ag.id, at: now.toISOString(), trigger: `定时 · ${sc.name}（手动执行）`, summary: a.prompt, calls: [], status: 'done' }, ...xs])
        text = `交给了${ag.name}，结果在「会话 / 执行记录」`
      }
    }
    const entry = { at: now.toISOString(), ok: !text.startsWith('没执行') && !text.startsWith('发布失败'), text, ref, manual: true, files }
    setSchedules((xs) => xs.map((y) => (y.id === sc.id ? { ...sc, history: [entry, ...y.history] } : y)))
  }

  // 枚举值在数据里的使用数；没接数据的枚举（SOP 触发方式、自定义枚举）返回 undefined，页面上不显示这一列
  const enumUsage: UsageFn = (g, k) => {
    switch (g) {
      case 'task_status': return tasks.filter((t) => t.status === k).length
      case 'task_priority': return tasks.filter((t) => t.priority === k).length
      case 'contact_group': return contacts.filter((c) => c.group === k).length
      case 'content_category': return content.filter((c) => c.category === k).length
      case 'msg_status': return messages.filter((m) => m.status === k).length
      default: return undefined
    }
  }
  const migrateEnum = (g: string, from: string, to: string) => {
    if (g === 'task_priority') setTasks((xs) => xs.map((t) => (t.priority === from ? { ...t, priority: to as typeof t.priority } : t)))
    if (g === 'contact_group') setContacts((xs) => xs.map((c) => (c.group === from ? { ...c, group: to as typeof c.group } : c)))
    if (g === 'content_category') setContent((xs) => xs.map((c) => (c.category === from ? { ...c, category: to as typeof c.category } : c)))
  }

  // 只算未处理的错误级异常；警告不在菜单上提醒
  const openIncidents = incidents.filter((x) => x.status === 'open' && x.level === 'error').length
  const brokenProviders = providers.filter((p) => p.enabled && p.status === 'error').length
  // 停用、不可用的模型也列进来（ok 为 false），这样 Agent 卡片上还能显示名字和原因
  const modelChoices: ModelChoice[] = useMemo(() => models.map((m) => {
    const u = usable(m, providers)
    return { key: m.id, label: m.name, note: u.ok ? `${providers.find((p) => p.id === m.provider_id)?.name} · ${m.context}K 上下文` : u.why!, ok: u.ok }
  }), [models, providers])
  // 连接器里没关掉的工具都能给 Agent 用；暂停的连接器不列
  const connToolChoices: ConnToolChoice[] = useMemo(() => connectors.filter((c) => c.tools && c.status !== 'paused' && c.status !== 'disconnected').flatMap((c) => c.tools!
    .filter((t) => t.mode !== 'off')
    .map((t) => ({ key: `conn:${c.id}:${t.name}`, connId: c.id, conn: c.name, connOk: c.status === 'connected', name: t.name, desc: t.desc, write: t.write, connMode: t.mode }))), [connectors])
  // 可挂载到 Agent 的 MCP / 连接器：获取过工具清单、没暂停的
  const mountableConns: MountableConn[] = useMemo(() => connectors.filter((c) => c.tools && c.status !== 'paused' && c.status !== 'disconnected').map((c) => ({
    id: c.id, name: c.name, kind: TOOLS.find((t) => t.key === c.tool)?.category === 'custom' ? 'MCP / 自定义' : TOOLS.find((t) => t.key === c.tool)?.label ?? c.tool,
    ok: c.status === 'connected', tools: connToolChoices.filter((t) => t.connId === c.id),
  })), [connectors, connToolChoices])
  const agentWaiting = agentRuns.filter((r) => r.status === 'waiting').length
  // Agent 的写操作真的落到数据上：建任务、写文档、回 IM；发起 SOP 原型里只回一个排队结果
  // 每一次落地都记一条产出，带上是哪个 Agent、从哪个会话或执行记录来的
  const executeAgentCall = (c: ToolCall, agentId: string, origin: AgentOutput['origin'] | null): unknown => {
    const now = new Date().toISOString()
    const record = (kind: OutputKind, title: string, target?: string) => {
      if (origin) setOutputs((xs) => [{ id: `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, agent_id: agentId, kind, title, target, at: now, origin }, ...xs])
    }
    if (c.tool === 'write_tasks') {
      const t = newTask(tasks, { title: String(c.input.title ?? '新任务'), priority: (c.input.priority as 'P2') ?? 'P2', assignee: String(c.input.assignee ?? '我') })
      setTasks((xs) => [xs.some((x) => x.ref === t.ref) ? { ...t, ref: newTask(xs, { title: t.title }).ref } : t, ...xs])
      record('task', t.title, t.id)
      return { task_id: t.id, ref: t.ref }
    }
    if (c.tool === 'write_content') {
      const id = `dc_${Date.now().toString(36)}`
      const title = String(c.input.title ?? 'Agent 写的笔记')
      setContent((xs) => [{ id, category: 'note', title, body: '# 草稿\n\n由 Agent 生成，待补充。', source: 'Agent', tags: ['Agent'], starred: false, updated_at: now }, ...xs])
      record('doc', title, id)
      return { content_id: id }
    }
    if (c.tool === 'reply_message') {
      const m = messages.find((x) => x.sender_name === c.input.to && x.status === 'pending')
      if (m) actOnMessage(m.id, { kind: 'reply', text: String(c.input.text ?? ''), done: false })
      record('reply', `回复 ${String(c.input.to ?? '')}：${String(c.input.text ?? '').slice(0, 24)}`, m?.id)
      return { sent: true, message_id: m?.id ?? null }
    }
    if (c.tool === 'run_sop') {
      // 记下是哪个 SOP，产出结果里点标题能打开它
      const sop = sops.find((x) => x.id === c.input.sop || x.name === c.input.sop)
      record('sop', `发起「${String(c.input.sop ?? '')}」`, sop?.id)
      return { queued: true, sop_id: sop?.id ?? null }
    }
    return { ok: true }
  }
  // 副作用（建任务等）放在 setState 外面做：更新函数在开发模式下会被调两次，放里面会建出两条
  const settleAgentRun = (runId: string, i: number, ok: boolean) => {
    const call = agentRuns.find((r) => r.id === runId)?.calls[i]
    if (!call || call.state !== 'pending') return
    const run = agentRuns.find((r) => r.id === runId)!
    const output = ok ? executeAgentCall(call, run.agent_id, { type: 'run', id: runId }) : undefined
    setAgentRuns((rs) => rs.map((r) => {
    if (r.id !== runId) return r
    const calls = r.calls.map((c, j) => (j !== i ? c : ok ? { ...c, state: 'confirmed' as const, output } : { ...c, state: 'rejected' as const }))
    const left = calls.some((c) => c.state === 'pending')
    // 都处理完了：确认过至少一项算完成，全拒绝算已拒绝
    return { ...r, calls, status: left ? 'waiting' : calls.some((c) => c.state === 'confirmed') ? 'done' : 'rejected' }
  }))
  }

  const ALL_MENU: { key: Page; label: string; badge?: number; alert?: boolean }[] = [
    { key: 'today', label: '今日', badge: 0, alert: false },
    { key: 'projects', label: '项目', badge: projects.length },
    { key: 'contacts', label: '联系人', badge: contacts.length },
    { key: 'messages', label: 'IM 消息', badge: pending, alert: pending > 0 },
    { key: 'tasks', label: '任务', badge: openTasks },
    { key: 'library', label: '文档', badge: content.length },
    { key: 'sop', label: 'SOP', badge: sopWaiting, alert: sopWaiting > 0 },
    { key: 'sessions', label: '会话', badge: agentWaiting, alert: agentWaiting > 0 },
    { key: 'terminal', label: '终端' },
    { key: 'browser', label: '浏览器' },
    { key: 'videos', label: '视频', alert: videoWaiting > 0 },
    { key: 'markets', label: '行情' },
    { key: 'monitor', label: '盯盘' },
    { key: 'etf', label: '宽基监控' },
    { key: 'strategy', label: '策略' },
    { key: 'trading', label: '交易' },
  ]
  // 菜单按工作台里开着的模块和顺序排
  const MENU = bench.modules.map((k) => ALL_MENU.find((m) => m.key === k)).filter((m): m is (typeof ALL_MENU)[number] => !!m)
  const ctx = { tasks, messages, contacts, sops: sops.map((x) => ({ id: x.id, name: x.name })) }

  // 今日：从各模块收「需要你处理」的事；按数据缓存，别的状态变化不重算（点击回调里只用 setState 和稳定的跳转，旧闭包也没关系）
  // 模块不在当前工作台时它贡献的组整组不出现；运行异常、连接异常在设置里，一直有
  const todayNeeds: TodayItem[] = useMemo(() => { const modOn = (k: (typeof bench.modules)[number]) => bench.modules.includes(k); return [
    // 待我处理（AUTO-12，SPEC-today-1.30）：SOP 里等人的每一步（人工检查、人工判断、确认输入、超出上限暂停、失败、超时），
    // 加上停在等人阶段（待确认项目、需人工、待验收）的任务；同一个需求已经有等人的步骤时，阶段那条不重复列
    ...(!modOn('sop') ? [] : (() => {
      const stepItems = runs.flatMap((r) => r.steps.map((_, i) => ({ r, i, w: waitOf(r, i) })).filter((x) => x.w).map(({ r, i, w }) => {
        const tid = (r.object_id ?? (typeof r.input.task_id === 'string' ? r.input.task_id : '')) || ''
        const t = tasks.find((x) => x.id === tid)
        const s = r.steps[i]
        const why = isHeld(s) ? `${w!.label}：${s.hold!.reason}` : s.status === 'failed' ? `${w!.label}：${s.error ?? ''}` : w!.label
        return {
          id: `sop-${r.id}-${s.key}`, kind: '待我处理', tone: w!.danger ? 'danger' as const : 'warn' as const, title: `${r.sop.steps[i].name} · ${r.sop.name}`,
          sub: `${t ? `${t.ref} ${t.title}${t.stage ? ` · ${stageLabel(t.stage)}` : ''}` : r.title} · ${why}`, at: new Date(s.hold?.since ?? s.started_at ?? r.started_at).toISOString(),
          action: w!.action, taskId: t?.id, onClick: () => { setPage('sop'); setOpenRun(r.id); setDrawer(null) },
        }
      }))
      const covered = new Set(stepItems.map((x) => x.taskId).filter(Boolean))
      const STAGE_WAIT: Record<string, [string, string]> = { confirm_project: ['等确认归到哪个项目', '去选项目'], need_human: ['流程转人工，等你裁决', '去裁决'], accepting: ['等你验收', '去验收'] }
      const stageItems = (!modOn('tasks') ? [] : tasks).filter((t) => t.stage && STAGE_WAIT[t.stage] && isOpenTask(t.status) && !covered.has(t.id)).map((t) => ({
        id: `stg-${t.id}`, kind: '待我处理', tone: t.stage === 'need_human' ? 'danger' as const : 'warn' as const, title: `${t.ref} ${t.title}`,
        sub: `${stageLabel(t.stage)} · ${STAGE_WAIT[t.stage!][0]}`, at: t.updated_at, action: STAGE_WAIT[t.stage!][1],
        onClick: () => { setPage('tasks'); setDrawer({ kind: 'task', id: t.id, tab: 'pipeline' }) },
      }))
      return [...stepItems.map(({ taskId: _t, ...x }) => x), ...stageItems]
    })()),
    ...(!modOn('sessions') ? [] : agentRuns).filter((r) => r.status === 'waiting').map((r) => ({
      id: `ar-${r.id}`, kind: 'Agent 待确认', tone: 'warn' as const, title: `${agents.find((a) => a.id === r.agent_id)?.name ?? 'Agent'}：${r.trigger}`,
      sub: r.summary, at: r.at, action: '去确认', onClick: () => { setPage('sessions'); setSessionView('runs'); setDrawer(null) },
    })),
    ...(!modOn('sessions') ? [] : sessions).filter((x) => x.messages.some((m) => m.calls?.some((c) => c.state === 'pending'))).map((x) => ({
      id: `ss-${x.id}`, kind: 'Agent 待确认', tone: 'warn' as const, title: `会话「${x.title}」里有操作等你确认`, sub: agents.find((a) => a.id === x.agent_id)?.name ?? '',
      at: x.updated_at, action: '去确认', onClick: () => { setPage('sessions'); setSessionView('chats'); setCurrentSession(x.id); setDrawer(null) },
    })),
    // 待验收的任务：Claude Code 提交验收后等你拍板，排在 IM 消息前面；在今日页上直接打开抽屉
    ...(!modOn('tasks') ? [] : tasks).filter((t) => t.status === 'review').map((t) => {
      const last = dev.progress.filter((p) => p.task_id === t.id && p.kind === 'review').sort((a, b) => b.at.localeCompare(a.at))[0]
      const pj = projects.find((x) => x.id === t.project_id)?.name
      return {
        id: `rv-${t.id}`, kind: '任务待验收', tone: 'warn' as const, title: `${t.ref} ${t.title}`,
        sub: [last ? `${last.actor_name === 'claude-code' ? 'Claude Code' : last.actor_name} 提交验收` : '等你验收', pj].filter(Boolean).join(' · '),
        at: last?.at ?? t.updated_at, action: '去验收', onClick: () => setDrawer({ kind: 'task', id: t.id }),
      }
    }),
    ...(!modOn('messages') ? [] : messages).filter((m) => m.status === 'pending' && !(m.snooze_until && new Date(m.snooze_until).getTime() > Date.now())).map((m) => ({
      id: `im-${m.id}`, kind: 'IM 消息', tone: 'info' as const, title: `${m.sender_name}：${m.text}`, sub: m.conversation || '私聊', at: m.at, action: '回复',
      onClick: () => { setPage('messages'); openMessage(m.id) },
    })),
    ...(!modOn('videos') ? [] : dueDeals(deals)).map((d) => ({
      id: `deal-${d.id}`, kind: '商单账期', tone: payText(d).tone === 'danger' ? 'danger' as const : 'warn' as const, title: `${d.brand}「${d.title}」${payText(d).text}`,
      sub: `已交付待收款 · ${d.currency === 'CNY' ? '¥' : '$'}${d.quote.toLocaleString('zh-CN')}`, at: d.updated_at, action: '去看看', onClick: () => setDrawer({ kind: 'deal', id: d.id }),
    })),
    ...incidents.filter((x) => x.status === 'open' && x.level === 'error').map((x) => ({
      id: `inc-${x.id}`, kind: '运行异常', tone: 'danger' as const, title: x.title, sub: `${x.module} · 共 ${x.count} 次`, at: x.last_at, action: '去看看',
      onClick: () => { go('settings'); setSection('incidents'); setDrawer({ kind: 'incident', id: x.id }) },
    })),
    ...connectors.filter((c) => c.status === 'error').map((c) => ({
      id: `cn-${c.id}`, kind: '连接异常', tone: 'danger' as const, title: `连接器「${c.name}」异常`, sub: c.error ?? '', action: '去修复',
      onClick: () => { go('settings'); setSection('connectors'); setDrawer({ kind: 'connector', id: c.id }) },
    })),
    ...providers.filter((x) => x.enabled && x.status === 'error').map((x) => ({
      id: `pv-${x.id}`, kind: '连接异常', tone: 'danger' as const, title: `模型服务商「${x.name}」异常`, sub: x.error ?? '', action: '去修复',
      onClick: () => { go('settings'); setSection('providers'); setDrawer({ kind: 'provider', id: x.id }) },
    })),
  ] }, [runs, agentRuns, agents, sessions, messages, incidents, connectors, providers, tasks, dev.progress, projects, bench.modules, deals])
  const todaySchedules: TodayLine[] = useMemo(() => schedules.filter((x) => x.enabled).map((x) => ({ x, n: nextRun(x.rule) }))
    .filter(({ n }) => n && n.toDateString() === new Date().toDateString())
    .map(({ x, n }) => ({ id: x.id, title: x.name, sub: whenText(n).replace('今天 ', ''), onClick: () => { setPage('tasks'); setTaskView('schedules'); setDrawer({ kind: 'schedule', id: x.id }) } })), [schedules])
  const todayRunning: TodayLine[] = useMemo(() => [
    ...projects.flatMap((pj) => pj.prototypes.filter((x) => x.status === 'running').map((x) => ({ id: x.id, title: `${pj.name} / ${x.name}`, sub: `:${x.port}`, href: `http://127.0.0.1:${x.port}` }))),
    ...runs.filter((r) => runStatus(r) === 'running').map((r) => ({ id: r.id, title: r.title, sub: 'SOP 执行中', onClick: () => { setPage('sop'); setOpenRun(r.id) } })),
  ], [projects, runs])
  // 今日菜单上的红点：有要处理的事就亮
  ALL_MENU[0].badge = todayNeeds.length
  ALL_MENU[0].alert = todayNeeds.some((n) => n.tone !== 'info')

  // 连接 / 断开（模拟）：连接 0.9 秒后看凭证，带 expired 的、OAuth 没授权的算失败
  const patchConn = (id: string, p: Partial<Connector>) => setConnectors((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const connectConn = (id: string) => {
    patchConn(id, { status: 'connecting', error: undefined })
    const target = connectors.find((x) => x.id === id)
    const failing = target && /expired|invalid/i.test([...Object.values(target.config), target.auth?.token?.value ?? ''].join(' '))
    window.setTimeout(() => {
      if (failing && target) report({ fingerprint: `conn:${id}:auth`, level: 'error', module: '连接器', title: `${target.name}连接失败`, message: '凭证已失效，连接器连不上，这期间的同步和工具调用都会失败', context: { 连接器: target.name, 工具: target.tool, 认证方式: target.auth?.mode ?? '应用凭证' } })
    }, 900)
    window.setTimeout(() => setConnectors((xs) => xs.map((x) => {
      if (x.id !== id) return x
      const creds = [...Object.values(x.config), x.auth?.token?.value ?? ''].join(' ')
      if (/expired|invalid/i.test(creds)) return { ...x, status: 'error', error: '凭证已失效，改好配置后再连接' }
      // OAuth：断开时撤销了授权，重新连接相当于再授权一次（原型里直接视为授权成功）
      const auth = x.auth?.mode === 'oauth2' && !x.auth.oauth?.account
        ? { ...x.auth, oauth: { ...x.auth.oauth!, account: x.account || '已授权账号', expires_at: new Date(Date.now() + 86400000 * 60).toISOString() } } : x.auth
      return { ...x, auth, status: 'connected', error: undefined, last_sync_at: new Date().toISOString() }
    })), 900)
  }
  // 浏览器的 Google 登录以 Drive 连接器为准：断开或删掉这个账号的 Drive 连接器就算退出登录
  const dropGoogleWith = (id: string) => {
    const c = connectors.find((x) => x.id === id)
    if (c?.tool === 'gdrive' && google && c.account === google.email) setGoogle(null)
  }
  const disconnectConn = (id: string) => {
    dropGoogleWith(id)
    setConnectors((xs) => xs.map((x) => (x.id !== id ? x : {
      ...x, status: 'disconnected', error: undefined,
      auth: x.auth?.mode === 'oauth2' ? { ...x.auth, oauth: { ...x.auth.oauth!, account: undefined, expires_at: undefined } } : x.auth,
    })))
  }

  // 原型启停（模拟）：启动中 1.2 秒后按端口占用决定成功还是失败；停止 0.6 秒
  const patchProto = (protoId: string, f: (x: Project['prototypes'][number], all: Project[]) => Project['prototypes'][number]) =>
    setProjects((ps) => ps.map((pj) => ({ ...pj, prototypes: pj.prototypes.map((x) => (x.id === protoId ? f(x, ps) : x)) })))
  const startProto = (protoId: string) => {
    patchProto(protoId, (x) => ({ ...x, status: 'starting', error: undefined, logs: startLogs(x).slice(0, 2) }))
    window.setTimeout(() => {
      const all = projectsRef.current
      const pj = all.find((p) => p.prototypes.some((x) => x.id === protoId))
      const proto = pj?.prototypes.find((x) => x.id === protoId)
      const bad = proto && portConflict(proto.port, proto.id, all)
      if (pj && proto && bad) report({ fingerprint: `proto:${protoId}:port`, level: 'warn', module: '项目原型', title: `「${proto.name}」启动失败`, message: bad, stack: `Error: listen EADDRINUSE: address already in use :::${proto.port}`, context: { 项目: pj.name, 原型: proto.name, 目录: `${pj.root}/${proto.dir}`, 命令: proto.command, 端口: proto.port } })
    }, 1200)
    window.setTimeout(() => patchProto(protoId, (x, all) => {
      const bad = portConflict(x.port, x.id, all)
      return bad ? { ...x, status: 'error', error: `启动失败：${bad}`, logs: [...x.logs, `Error: listen EADDRINUSE: address already in use :::${x.port}`] }
        : { ...x, status: 'running', started_at: new Date().toISOString(), logs: startLogs(x) }
    }), 1200)
  }
  const stopProto = (protoId: string) => {
    patchProto(protoId, (x) => ({ ...x, status: 'stopping' }))
    window.setTimeout(() => patchProto(protoId, (x) => ({ ...x, status: 'stopped', started_at: undefined, logs: [...x.logs, '^C', '已停止'] })), 600)
  }
  const patchDock = (pid: string, f: (d: ProjectDockState) => ProjectDockState) => setDocks((m) => ({ ...m, [pid]: f(m[pid] ?? EMPTY_DOCK) }))
  /** 展开项目的终端或浏览器，那边一个都没开时先开一个；toggle 时已经在显示的就收起 */
  const showDock = (pid: string, view: DockView, toggle = false) => {
    const d = docks[pid] ?? EMPTY_DOCK
    const has = view === 'term' ? d.term.length > 0 : d.br > 0
    if (toggle && d.open && d.view === view && has) { patchDock(pid, (x) => ({ ...x, open: false })); return }
    const root = projects.find((x) => x.id === pid)?.root || '/Users/me'
    const t = view === 'term' && !d.term.length ? newTab(root) : null
    const br = view === 'browser' && !d.br ? (browserKey.current += 1) : 0
    patchDock(pid, (x) => ({
      ...x, open: true, view,
      ...(t && !x.term.length ? { term: [t], termActive: t.id } : {}),
      ...(br && !x.br ? { br, brTabs: 1 } : {}),
    }))
  }
  /** 全部关闭：终端里跑着的原型一起停，网页和终端都清掉 */
  const closeDock = (pid: string) => {
    const d = docks[pid]
    if (!d) return
    d.term.forEach((t) => t.panes.forEach((pn) => pn.running && stopProto(pn.running)))
    setDocks((m) => ({ ...m, [pid]: EMPTY_DOCK }))
  }
  // 内置浏览器：开了浏览器模块就在里面开，没开交给系统浏览器
  const openInBrowser = (url: string, title?: string) => {
    if (!has('browser')) { window.open(url, '_blank', 'noopener'); return }
    setBrowserReq((r) => ({ url, title, n: (r?.n ?? 0) + 1 }))
    setPage('browser'); setDrawer(null)
  }
  // Google 登录：按授权范围把 Google Drive、Google 日历连接器接上（没有就新建一个）
  const googleLogin = (acc: GoogleAccount) => {
    setGoogle(acc)
    const now = new Date().toISOString()
    const expires = new Date(Date.now() + 86400000 * 60).toISOString()
    const want = [
      { tool: 'gdrive', scopes: acc.scopes.filter((x) => x.startsWith('drive')) },
      { tool: 'gcal', scopes: acc.scopes.filter((x) => x.startsWith('calendar')) },
    ].filter((x) => x.scopes.length)
    setConnectors((xs) => {
      let out = xs
      for (const w of want) {
        const t = TOOLS.find((x) => x.key === w.tool)
        if (!t) continue
        const oauth = { client_id: '', client_secret: '', auth_url: t.oauth?.auth_url ?? '', token_url: t.oauth?.token_url ?? '', scopes: w.scopes.join(', '), account: acc.email, expires_at: expires }
        const ex = out.find((c) => c.tool === w.tool)
        out = ex
          ? out.map((c) => (c.id !== ex.id ? c : { ...c, account: acc.email, status: 'connected', error: undefined, last_sync_at: now, auth: { mode: 'oauth2', oauth: { ...(c.auth?.oauth ?? oauth), ...oauth, client_id: c.auth?.oauth?.client_id ?? '', client_secret: c.auth?.oauth?.client_secret ?? '' } } }))
          : [...out, { id: `cn_${w.tool}`, tool: w.tool, name: t.label, account: acc.email, status: 'connected', config: {}, direction: 'receive', interval: 15, last_sync_at: now, created_at: now, auth: { mode: 'oauth2', oauth } }]
      }
      return out
    })
  }
  const googleLogout = () => {
    setGoogle(null)
    setConnectors((xs) => xs.map((c) => (c.tool !== 'gdrive' && c.tool !== 'gcal') || c.account !== google?.email ? c
      : { ...c, status: 'disconnected', auth: c.auth?.oauth ? { ...c.auth, oauth: { ...c.auth.oauth, account: undefined, expires_at: undefined } } : c.auth }))
  }
  const openChart = (symbol: string) => { setChartFocus((r) => ({ symbol, n: (r?.n ?? 0) + 1 })); setPage('markets'); setDrawer(null) }
  const newAlertFor = (symbol: string) => { setAlertReq((r) => ({ symbol, n: (r?.n ?? 0) + 1 })); setPage('monitor'); setDrawer(null) }
  const tradeFor = (symbol: string, side: 'buy' | 'sell') => { setOrderReq((r) => ({ symbol, side, n: (r?.n ?? 0) + 1 })); setTradingView('orders'); setPage('trading'); setDrawer(null) }
  const deployStrategy = (strategyId: string) => { setDeployReq((r) => ({ strategyId, n: (r?.n ?? 0) + 1 })); setTradingView('runs'); setPage('trading'); setDrawer(null) }
  // 回测：先排进列表显示进度，模拟 1.5 秒后同步算出结果；用策略快照算，之后改策略不影响这次
  const startBacktest = (st: Strategy, cfg: BacktestConfig) => {
    const id = `bt_${Date.now().toString(36)}`
    const n = backtests.filter((b) => b.config.strategy_id === st.id).length + 1
    const snap = structuredClone(st)
    setBacktests((xs) => [{ id, name: `${st.name} #${n}`, config: cfg, status: 'running', progress: 0, strategy_snapshot: snap, created_at: new Date().toISOString() }, ...xs])
    const steps = 5
    for (let i = 1; i < steps; i++) window.setTimeout(() => setBacktests((xs) => xs.map((b) => (b.id === id && b.status === 'running' ? { ...b, progress: i / steps } : b))), i * 300)
    window.setTimeout(() => {
      let patch: Partial<Backtest>
      try { patch = { status: 'done', progress: 1, result: runBacktest(cfg, snap), finished_at: new Date().toISOString() } }
      catch (e) {
        patch = { status: 'failed', error: String(e), finished_at: new Date().toISOString() }
        report({ fingerprint: `bt:${st.id}`, level: 'error', module: '交易', title: `「${st.name}」回测失败`, message: String(e), context: { 策略: st.name } })
      }
      setBacktests((xs) => xs.map((b) => (b.id === id ? { ...b, ...patch } : b)))
    }, steps * 300)
    return id
  }
  const newStrategy = () => {
    const now = new Date().toISOString()
    const st: Strategy = {
      id: `st_${Date.now().toString(36)}`, name: '新策略', desc: '', mode: 'rules', symbols: [], interval: '1h', direction: 'long',
      entry: { logic: 'all', rules: [] }, exit: { logic: 'any', rules: [] }, stop_loss: 0, take_profit: 0, position_pct: 20, code: '', params: {}, tags: [], updated_at: now, created_at: now,
    }
    setStrategies((xs) => [st, ...xs]); setStrategyView(`st:${st.id}`)
  }
  const tradeReport = (title: string, message: string) => report({ fingerprint: `trade:${title}`, level: 'warn', module: '交易', title, message, context: {} })
  // 原型清单：浏览器首页、内网域名都用它；只跟着项目变
  const protoRefs = useMemo(() => projects.flatMap((pj) => pj.prototypes.map((x) => ({ id: x.id, name: x.name, project: pj.name, projectId: pj.id, port: x.port, status: x.status }))), [projects])
  // 浏览器是 memo 过的，传进去的回调要稳定
  const browserStartProto = useStable(startProto)
  const browserLogin = useStable(googleLogin)
  const browserLogout = useStable(googleLogout)
  const addFrameHost = useStable((h: string) => setFrameHosts((xs) => (xs.includes(h) ? xs : [...xs, h])))
  const frameAllow = useMemo(() => ({ suffix: domainSettings.enabled ? domainSettings.suffix : null, hosts: frameHosts, onAdd: addFrameHost }),
    [domainSettings.enabled, domainSettings.suffix, frameHosts, addFrameHost])
  const videoTabs = (
    <VideosTabs view={videoView} from={videoFrom} videos={videos} clips={clips}
      onSelect={(v) => { setVideoView(v); setVideoFrom(undefined); if (v === 'publish') setPublishFilter(undefined); if (v === 'topics') setTopicFocus(null) }} />
  )
  // 选题立项：生成一集视频，带上系列、集数、要出的比例（按目标平台的偏好比例）
  const makeVideoFromTopic = (t: Topic) => {
    const now = new Date().toISOString()
    const ep = t.series_id ? Math.max(0, ...videos.filter((x) => x.series_id === t.series_id).map((x) => x.episode ?? 0)) + 1 : undefined
    const orients = [...new Set(t.platforms.map((k) => PLATFORMS.find((p) => p.key === k)!.prefer))]
    const v: Video = {
      id: newId('vd'), title: ep ? `第 ${ep} 集：${t.title}` : t.title, series_id: t.series_id, episode: ep, orientations: orients.length ? orients : ['landscape'], stage: 'script', topic_id: t.id,
      checkpoints: STAGES.filter((s) => s.checkpoint).map((s) => ({ stage: s.key, state: 'pending' })),
      root: `videos/${t.id}`, chapters: 3, created_at: now, updated_at: now,
    }
    setVideos((xs) => [v, ...xs])
    return v.id
  }
  const newVideo = (seriesId?: string) => {
    const now = new Date().toISOString()
    const ep = seriesId ? Math.max(0, ...videos.filter((x) => x.series_id === seriesId).map((x) => x.episode ?? 0)) + 1 : undefined
    const v: Video = {
      id: `vd_${Date.now().toString(36)}`, title: ep ? `第 ${ep} 集：` : '新视频', series_id: seriesId, episode: ep, orientations: ['landscape'], stage: STAGES[0].key,
      checkpoints: STAGES.filter((s) => s.checkpoint).map((s) => ({ stage: s.key, state: 'pending' })),
      root: `videos/new-${videos.length + 1}`, chapters: 3, created_at: now, updated_at: now,
    }
    setVideos((xs) => [v, ...xs]); setVideoFrom(seriesId ? `sr:${seriesId}` : undefined); setVideoView(`video:${v.id}`)
  }

  const newProject = () => {
    const pj: Project = { id: `pj_${Date.now().toString(36)}`, name: '新项目', desc: '', mark: { text: '', icon: 'folder' }, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], root: '', related: [], agent_ids: [], chats: [], stakeholders: [], sop_ids: [], materials: [], docs: [], prototypes: [], created_at: new Date().toISOString() }
    setProjects((xs) => [...xs, pj]); setProjectId(pj.id); setProjectTab('settings')
  }
  const createSession = (agentId: string, projectId?: string, first?: string, source?: Session['source'], title?: string) => {
    const now = new Date().toISOString()
    const ss: Session = { id: `ss_${Date.now().toString(36)}`, agent_id: agentId, project_id: projectId, title: title ?? '新会话', created_at: now, updated_at: now, messages: [], source }
    setFirstMessage(first ? { sessionId: ss.id, text: first } : null)
    setSessions((xs) => [ss, ...xs])
    return ss.id
  }
  const newSession = (agentId: string, projectId?: string, first?: string, source?: Session['source'], title?: string) => {
    setCurrentSession(createSession(agentId, projectId, first, source, title))
    setPage('sessions'); setSessionView('chats'); setDrawer(null)
  }
  // 在项目里开会话：建好挂到项目，切到 Agent 标签就地打开，不跳会话页（SPEC-projects-10.5、10.13、3.6）
  const newProjectSession = (agentId: string, projectId: string) => {
    setProjectChat(createSession(agentId, projectId)); setProjectTab('agents')
  }
  // 会话的消息更新：第一句话当标题，之后不再自动改。会话页和项目里的就地对话共用
  const setSessionMsgs = (id: string, f: (m: ChatMsg[]) => ChatMsg[]) => setSessions((xs) => xs.map((x) => {
    if (x.id !== id) return x
    const messages = f(x.messages)
    const title = x.title === '新会话' && messages[0] ? messages[0].text.slice(0, 20) : x.title
    return { ...x, messages, title, updated_at: new Date().toISOString() }
  }))
  // 目标已删除时不跳页面，返回提示给产出结果那一行显示
  const openOutputTarget = (o: AgentOutput): string | void => {
    if (o.kind === 'task' && o.target) {
      if (!tasks.some((t) => t.id === o.target)) return '这条任务已删除'
      setDrawer({ kind: 'task', id: o.target })
    } else if (o.kind === 'doc') {
      const doc = content.find((x) => x.id === o.target || x.title === o.title)
      if (!doc) return '这篇文档已删除'
      setPage('library'); switchWs('builtin'); setReading(doc.id)
    } else if (o.kind === 'reply' && o.target) {
      if (!messages.some((m) => m.id === o.target)) return '这条消息已删除'
      setPage('messages'); openMessage(o.target)
    } else if (o.kind === 'sop' && o.target) {
      if (!sops.some((x) => x.id === o.target)) return '这个 SOP 已删除'
      setPage('sop'); setSopView(`sop:${o.target}`); setOpenRun(null)
    }
  }
  const openOutputOrigin = (o: AgentOutput) => {
    if (o.origin.type === 'session') { setCurrentSession(o.origin.id); setSessionView('chats') } else { setRunFocus(o.origin.id); setSessionView('runs') }
  }

  // 命令面板的条目：跳转、操作、各模块的数据；只放当前工作台开着的模块
  // 只在面板打开那一刻拼一次，平时不拼；工作台切换、原型启停各自一组，输入后才出现
  const has = (p: Page) => MENU.some((m) => m.key === p)
  // 分诊建议（SPEC-messages-2.41~2.44、4.10）：查看执行进 SOP 运行页；没分诊过的在抽屉里发起（原型直接用第一条输入带 message_id 的分诊流程，已跑过的不跳过）
  const openTriageRun = (id: string) => { setPage('sop'); setOpenRun(id); setDrawer(null) }
  const startTriage = (ids: string[]) => {
    const list = triageSops(sops)
    const sop = list.find((x) => x.fields.some((f) => f.key === 'message_id')) ?? list[0]
    if (!sop) return
    const now = Date.now()
    setRuns((xs) => [...ids.map((id, i) => startRun(sop, { ...Object.fromEntries(sop.fields.map((f) => [f.key, f.default ?? ''])), message_id: id }, false, now + i,
      { source: 'manual', sourceName: '消息抽屉' })), ...xs])
  }

  // 内容日历和商单（VID-06p、VID-08p）
  /** 定时任务里显示发布记录用的名字：「平台 · 标题」 */
  const pubNames = useMemo(() => publishes.map((p) => ({ id: p.id, name: `${PLATFORMS.find((x) => x.key === p.platform)?.label ?? p.platform} · ${p.title || videos.find((v) => v.id === p.video_id)?.title || '未填标题'}` })), [publishes, videos])
  /** 发布记录页只看这一集（发布抽屉在发布记录页里面，从外面打不开具体一条） */
  const openPublishOf = (p: Publish) => { setPage('videos'); setDrawer(null); setVideoFrom(undefined); setPublishFilter(p.video_id); setVideoView('publish') }
  /** 日历上把发布挪到另一天：时刻不变；已定时的，定时任务由 syncPublishSchedules 跟着改 */
  const movePublish = (id: string, date: string) => setPublishes((xs) => xs.map((p) => {
    if (p.id !== id || !p.scheduled_at) return p
    const d = new Date(p.scheduled_at)
    const [y, m, dd] = date.split('-').map(Number)
    d.setFullYear(y, m - 1, dd)
    return { ...p, scheduled_at: d.toISOString() }
  }))
  const moveTarget = (id: string, date: string) => setVideos((xs) => xs.map((v) => (v.id === id ? { ...v, target_date: date, updated_at: new Date().toISOString() } : v)))
  const openDeal = (id: string) => setDrawer({ kind: 'deal', id })
  /** IM 消息转商单：转过的打开，没转过的按发信人预填询价人、品牌（联系人的公司）、项目（消息所在会话挂的项目） */
  const openDealFromMessage = (mid: string) => {
    const existing = deals.find((d) => d.source_message_id === mid)
    if (existing) { setDrawer({ kind: 'deal', id: existing.id }); return }
    const m = messages.find((x) => x.id === mid)
    if (!m) return
    const who = contactFor(m, contacts)
    const pj = projects.find((x) => projectMessages(x, [m], contacts).length > 0)
    setDrawer({ kind: 'new-deal', initial: { source_message_id: mid, contact_id: who?.id, brand: who?.company ?? '', project_id: pj?.id ?? projects[0]?.id ?? '' } })
  }
  const saveDeal = (d: Deal) => {
    const creating = !deals.some((y) => y.id === d.id)
    setDeals((xs) => (xs.some((y) => y.id === d.id) ? xs.map((y) => (y.id === d.id ? d : y)) : [d, ...xs]))
    // 挂上的视频没有项目的，归到商单的项目
    setVideos((xs) => xs.map((v) => (d.video_ids.includes(v.id) && !v.project_id ? { ...v, project_id: d.project_id } : v)))
    // 新建的落到项目的商单标签，抽屉开着
    if (creating && has('projects')) { setPage('projects'); setProjectId(d.project_id); setProjectTab('deals') }
    setDrawer({ kind: 'deal', id: d.id })
  }
  /** 出结案报告：写一篇文档（重出就覆盖原来那篇），挂进项目文档，商单记下它 */
  const makeDealReport = (d: Deal) => {
    const now = new Date().toISOString()
    const title = `${d.brand} · ${d.title} 结案报告`
    const body = dealReport(d, videos, publishes)
    const id = d.report_content_id && content.some((c) => c.id === d.report_content_id) ? d.report_content_id : newId('dc')
    setContent((xs) => (xs.some((c) => c.id === id) ? xs.map((c) => (c.id === id ? { ...c, body, updated_at: now } : c))
      : [{ id, category: 'doc', title, body, source: `商单「${d.title}」`, tags: ['商单', '结案报告'], starred: false, updated_at: now }, ...xs]))
    setProjects((xs) => xs.map((pj) => (pj.id !== d.project_id || pj.docs.some((x) => x.source.type === 'library' && x.source.content_id === id) ? pj
      : { ...pj, docs: [...pj.docs, { id: newId('pd'), title, kind: '其他', status: 'final', source: { type: 'library', content_id: id }, updated_at: now }] })))
    setDeals((xs) => xs.map((y) => (y.id === d.id ? { ...y, report_content_id: id, updated_at: now } : y)))
  }
  const goto = (p: Page) => () => go(p)
  const buildPaletteItems = (): PaletteItem[] => [
    { id: 'c-quick-session', group: '操作', title: '新建会话', sub: '挑个 Agent 直接开聊（⌘J）', keywords: 'session chat agent 会话 对话 新建', run: () => setQuickSession(true) },
    ...(has('tasks') ? [{ id: 'c-task', group: '操作', title: '新建任务', keywords: 'task 待办', run: () => { setPage('tasks'); setDrawer({ kind: 'new-task' }) } },
      { id: 'c-sched', group: '操作', title: '新建定时任务', keywords: 'schedule 定时', run: () => { setPage('tasks'); setTaskView('schedules'); setDrawer({ kind: 'new-schedule' }) } }] : []),
    ...(has('contacts') ? [{ id: 'c-contact', group: '操作', title: '新建联系人', keywords: 'contact', run: () => { setPage('contacts'); setDrawer({ kind: 'new-contact' }) } }] : []),
    ...(has('sessions') ? [{ id: 'c-chat', group: '操作', title: '和 Agent 开个新会话', keywords: '会话 对话 chat', run: () => { setPage('sessions'); setSessionView('chats'); setPickAgent((n) => n + 1) } }] : []),
    ...(has('sop') ? [{ id: 'c-sop', group: '操作', title: '新建 SOP', keywords: '流程 工作流', run: () => { setPage('sop'); setSopView('edit:new'); setOpenRun(null) } }] : []),
    ...(has('projects') ? [{ id: 'c-proj', group: '操作', title: '新建项目', keywords: 'project', run: () => { setPage('projects'); newProject() } }] : []),
    { id: 'c-theme', group: '操作', title: theme === 'dark' ? '切换到浅色' : '切换到深色', keywords: '配色 主题 dark light 外观', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
    { id: 'c-side', group: '操作', title: collapsed ? '展开左侧菜单' : '收起左侧菜单', keywords: '侧栏 菜单', run: () => setCollapsed(!collapsed) },
    ...benches.filter((b) => b.id !== bench.id).map((b) => ({ id: `c-bench-${b.id}`, group: '工作台', title: `切换到「${b.name}」`, sub: b.role, keywords: '工作台 切换', run: () => switchBench(b.id) })),
    ...(has('projects') ? projects.flatMap((pj) => pj.prototypes.map((x) => (x.status === 'running'
      ? { id: `c-stop-${x.id}`, group: '原型', title: `停止原型「${x.name}」`, sub: `${pj.name} · :${x.port}`, keywords: 'prototype 停止', run: () => stopProto(x.id) }
      : { id: `c-start-${x.id}`, group: '原型', title: `启动原型「${x.name}」`, sub: `${pj.name} · :${x.port}`, keywords: 'prototype 启动', run: () => startProto(x.id) }))) : []),
    ...MENU.map((m) => ({ id: `g-${m.key}`, group: '跳转', title: m.label, sub: '功能模块', run: goto(m.key) })),
    { id: 'g-overview', group: '跳转', title: '原型总览', sub: '每个模块的页面和对应的规格章节', keywords: 'overview spec 规格 总览', run: goto('overview') },
    ...SECTIONS.map((x) => ({ id: `g-set-${x.key}`, group: '跳转', title: `设置 / ${x.label}`, sub: x.desc, run: () => { go('settings'); setSection(x.key); if (x.key === 'agents') setAgentView('list') } })),
    ...(has('projects') ? projects.map((x) => ({ id: `p-${x.id}`, group: '项目', title: x.name, sub: x.desc, keywords: x.root, run: () => { setPage('projects'); setProjectId(x.id); setProjectTab('overview') } })) : []),
    ...(has('tasks') ? tasks.map((x) => ({ id: `t-${x.id}`, group: '任务', title: `${x.ref} ${x.title}`, sub: `${x.priority} · ${x.assignee || '未分配'}`, keywords: x.desc, run: () => { setPage('tasks'); setDrawer({ kind: 'task', id: x.id }) } })) : []),
    ...(has('contacts') ? contacts.map((x) => ({ id: `u-${x.id}`, group: '联系人', title: x.name, sub: [x.company, x.title].filter(Boolean).join(' · '), keywords: `${x.phone} ${x.email} ${Object.values(x.im).join(' ')}`, run: () => { setPage('contacts'); setDrawer({ kind: 'contact', id: x.id }) } })) : []),
    ...(has('library') ? content.map((x) => ({ id: `d-${x.id}`, group: '文档', title: x.title, sub: x.tags.join(' '), keywords: x.body.slice(0, 300), run: () => { setPage('library'); switchWs('builtin'); setReading(x.id) } })) : []),
    ...(has('sessions') ? sessions.map((x) => ({ id: `s-${x.id}`, group: '会话', title: x.title, sub: agents.find((a) => a.id === x.agent_id)?.name, run: () => { setPage('sessions'); setSessionView('chats'); setCurrentSession(x.id) } })) : []),
    ...(has('sop') ? sops.map((x) => ({ id: `f-${x.id}`, group: 'SOP', title: x.name, sub: x.desc, run: () => { setPage('sop'); setSopView(`sop:${x.id}`); setOpenRun(null) } })) : []),
    ...agents.map((x) => ({ id: `a-${x.id}`, group: 'Agent', title: x.name, sub: x.desc, run: () => { go('settings'); setSection('agents'); setAgentView(x.id) } })),
  ]

  // 所有页面共用一个 .content 滚动容器：换页面、换二级菜单都回到顶部；不用 key 重挂 main，会把浏览器一起卸掉
  const mainRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => { mainRef.current?.scrollTo(0, 0) }, [page, section, taskView, sopView, openRun, sessionView, strategyView, tradingView, videoView, projectId, projectTab, agentView])

  useEffect(() => {
    if (page === 'settings' || page === 'overview' || MENU.some((m) => m.key === page)) return
    setPage(((MENU.find((m) => m.key === bench.home) ?? MENU[0])?.key ?? 'settings') as Page)
  }, [page, bench.modules.join(','), bench.home])
  // 一级菜单分组折叠：直接记在工作台配置里，和「设置 / 工作台与模块」的默认折叠是同一个值
  const toggleGroup = (gid: string) => setBenches((xs) => xs.map((w) => (w.id !== bench.id ? w : { ...w, groups: w.groups.map((g) => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)) })))
  const switchBench = (id: string) => {
    const w = benches.find((x) => x.id === id)
    if (!w) return
    setBenchId(id)
    // 切过去后停在设置里就不动；否则打开新工作台的默认模块
    if (page !== 'settings') { setPage(w.home as Page); setDrawer(null) }
  }
  // 会话旁边的终端、浏览器（SPEC-sessions-1.34 到 1.38）：终端和一级菜单是同一套标签；浏览器原型里是单独一个实例（见 SPEC-sessions 的 S-8）
  const sessionTools: SessionTools = {
    available: [...(has('terminal') ? ['term' as const] : []), ...(has('browser') ? ['browser' as const] : [])],
    onOpen: (t, { workdir }) => {
      if (t !== 'term') return
      // 停在会话目录的格子（当前标签优先）就切过去，没有就在那个目录新开一个标签；会话没目录用终端的默认目录
      const dir = workdir || projects.find((x) => x.root)?.root || '/Users/me'
      const cur = termTabs.find((x) => x.id === termActive) ?? termTabs[0]
      const order = cur ? [cur, ...termTabs.filter((x) => x !== cur)] : termTabs
      for (const tb of order) {
        const pn = [...tb.panes].sort((a, b) => Number(b.id === tb.focus) - Number(a.id === tb.focus)).find((x) => x.cwd === dir)
        if (pn) { setTermTabs((ts) => ts.map((x) => (x.id === tb.id ? { ...x, focus: pn.id } : x))); setTermActive(tb.id); return }
      }
      const n = newTab(dir)
      setTermTabs((ts) => [...ts, n]); setTermActive(n.id)
    },
    render: (t, { links, hidden }) => (t === 'term'
      ? <TerminalPage tabs={termTabs} active={termActive || termTabs[0]?.id} onTabs={setTermTabs} onActive={setTermActive}
          projects={projects} onStartProto={startProto} onStopProto={stopProto} />
      : <BrowserPage embedded openRequest={null} prototypes={protoRefs} onStartProto={browserStartProto} google={google}
          onGoogleLogin={browserLogin} onGoogleLogout={browserLogout} hidden={hidden || page !== 'sessions'} links={links} />),
    onPage: (t) => go(t === 'term' ? 'terminal' : 'browser'),
  }
  const go = (p: Page) => { setPage(p); setDrawer(null); if (p === 'library' && page !== 'library' && defaultWs !== 'builtin' && folders.some((f) => `dir:${f.id}` === defaultWs)) { setWs(defaultWs); setLibKind(''); setLibQ(''); setReading(null) } if (p === 'settings') setConnCat(''); if (p === 'sop') { setOpenRun(null); setSopFilter(undefined) } setRunFromTask(null); if (p === 'sessions') setSessionProject(undefined); if (p === 'projects') setProjectId(ALL_PROJECTS) }
  // 从原型总览打开某页：当前工作台没开这个模块就先切到开着它的工作台，再落到对应子页
  const openFromOverview = (m: OverviewKey, view?: string) => {
    if (m !== 'settings' && !bench.modules.includes(m)) { const w = benches.find((x) => x.modules.includes(m)); if (!w) return; setBenchId(w.id) }
    go(m)
    if (!view) return
    if (m === 'tasks') setTaskView(view as TaskView)
    else if (m === 'sessions') setSessionView(view as SessionView)
    else if (m === 'sop') setSopView(view as SopView)
    else if (m === 'videos') setVideoView(view as VideoView)
    else if (m === 'strategy') setStrategyView(view as StrategyView)
    else if (m === 'trading') setTradingView(view as TradingView)
    else if (m === 'projects' && projects[0]) { setProjectId(projects[0].id); setProjectTab(view as ProjectTab) }
    else if (m === 'settings') { setSection(view as Section); if (view === 'agents') setAgentView('list') }
  }
  const openImConnectors = () => { setPage('settings'); setSection('connectors'); setConnCat('im'); setDrawer(null) }

  // 本地目录只在内存里，刷新页面就没了；同一个目录再选一次是重新读取，不会多出一项
  const loadFolder = async (load: () => Promise<LocalFolder | null>) => {
    setFolderBusy(true)
    setFolderError('')
    try {
      const f = await load()
      if (!f) return
      let same: LocalFolder | undefined
      for (const x of folders) if (x.handle && f.handle && await x.handle.isSameEntry?.(f.handle)) same = x
      const next = same ? { ...f, id: same.id } : f
      setFolders((xs) => (same ? xs.map((x) => (x.id === same.id ? next : x)) : [...xs, next]))
      switchWs(`dir:${next.id}`)
    } catch (e) {
      setFolderError(e instanceof DOMException && e.name === 'NotAllowedError' ? '没有拿到读取权限，请重新选择' : `读取失败：${(e as Error).message}`)
    } finally {
      setFolderBusy(false)
    }
  }
  // 换工作目录：两套筛选 key 不通用，筛选和搜索一起清掉
  const switchWs = (w: Workspace) => { setWs(w); setLibKind(''); setLibQ(''); setReading(null) }
  const lib = libraryModel(ws, content, folders, libKind, libQ)
  const addFolder = () => loadFolder(pickFolder)
  const refreshFolder = (id: string) => {
    const h = folders.find((f) => f.id === id)?.handle
    if (h) loadFolder(() => readHandle(h, id))
  }
  const removeFolder = (id: string) => {
    setFolders((xs) => xs.filter((f) => f.id !== id))
    if (ws === `dir:${id}`) switchWs('builtin')
  }

  /* ---------- 删除：先算影响列进确认框；归属关系置空，内嵌关系一起删，执行中的先停或拦截 ---------- */
  // 联系人：从项目干系人里移除，解除项目私聊绑定；历史消息不动
  const contactPlan = (id: string): DelPlan => {
    const stake = projects.filter((p) => p.stakeholders.some((s) => s.contact_id === id)).map((p) => p.name)
    const dm = projects.filter((p) => p.chats.some((c) => c.kind === 'dm' && c.contact_id === id)).map((p) => p.name)
    return { impact: lines(stake.length > 0 && `会从项目${nameList(stake)}的干系人里移除`, dm.length > 0 && `项目${nameList(dm)}里和 TA 的私聊绑定会解除`) }
  }
  const deleteContact = (id: string) => {
    setContacts((xs) => xs.filter((x) => x.id !== id))
    setProjects((ps) => ps.map((p) => ({ ...p, stakeholders: p.stakeholders.filter((s) => s.contact_id !== id), chats: p.chats.filter((c) => !(c.kind === 'dm' && c.contact_id === id)) })))
  }
  // 连接器：消息保留只读；Agent 卸下它和它的工具权限；盯盘提醒去掉 IM 推送
  const connToolKeys = (a: (typeof agents)[number], id: string) => Object.keys(a.abilities).filter((k) => k.startsWith(`conn:${id}:`))
  const connPlan = (id: string): DelPlan => {
    const n = messages.filter((m) => m.connector_id === id).length
    const ag = agents.flatMap((a) => {
      const tools = connToolKeys(a, id).filter((k) => a.abilities[k] !== 'off').map((k) => k.split(':').slice(2).join(':'))
      if (!tools.length && !a.mcps.includes(id)) return []
      return [tools.length ? `${a.name}会失去 ${tools.join('、')} 工具` : `${a.name}会卸下这个连接器`]
    })
    const al = alerts.filter((x) => x.im_connector === id)
    return { impact: lines(
      n > 0 && `${n} 条 IM 消息会变成「渠道已删除」，只能查看`,
      ...ag,
      al.length > 0 && `${al.length} 条盯盘提醒（${nameList(al.map((x) => x.symbol.split(':').pop() ?? x.symbol))}）改为只在应用内提醒`,
    ) }
  }
  const deleteConnector = (id: string) => {
    dropGoogleWith(id)
    setConnectors((xs) => xs.filter((x) => x.id !== id))
    setAgents((xs) => xs.map((a) => {
      const keys = connToolKeys(a, id)
      if (!keys.length && !a.mcps.includes(id)) return a
      return { ...a, mcps: a.mcps.filter((x) => x !== id), abilities: Object.fromEntries(Object.entries(a.abilities).filter(([k]) => !keys.includes(k))) }
    }))
    setAlerts((xs) => xs.map((x) => {
      if (x.im_connector !== id) return x
      const notify = x.notify.filter((k) => k !== 'im')
      return { ...x, notify: notify.includes('app') ? notify : ['app', ...notify], im_connector: undefined }
    }))
  }
  // 任务：关联的异常退回未处理；投递记录保留，去重只认还在的任务
  const taskPlan = (id: string): DelPlan => {
    const inc = incidents.filter((x) => x.task_id === id && x.status === 'tasked')
    const dl = deliveries.some((d) => d.task_id === id && d.result === 'created')
    return { impact: lines(inc.length > 0 && `运行异常${nameList(inc.map((x) => x.title))}会退回未处理`, dl && 'Webhook 再推送同样的内容会重新建任务') }
  }
  const deleteTask = (id: string) => {
    setTasks((xs) => xs.filter((x) => x.id !== id))
    setIncidents((xs) => xs.map((x) => (x.task_id !== id ? x : { ...x, task_id: undefined, status: x.status === 'tasked' ? 'open' : x.status, note: '关联的任务已删除' })))
  }
  // 项目：任务、会话、视频移出项目（任务上留提示）；原型跟着项目走，指向这些原型的域名一起删
  const projectPlan = (pj: Project): DelPlan => {
    const t = tasks.filter((x) => x.project_id === pj.id).length
    const s = sessions.filter((x) => x.project_id === pj.id).length
    const v = videos.filter((x) => x.project_id === pj.id).length
    const live = pj.prototypes.filter((x) => x.status === 'running' || x.status === 'starting').map((x) => x.name)
    const protoIds = new Set(pj.prototypes.map((x) => x.id))
    const routes = domainRoutes.filter((r) => r.target.kind === 'proto' && protoIds.has(r.target.proto_id)).map((r) => `${r.host}.${domainSettings.suffix}`)
    return { impact: lines(
      t + s + v > 0 && `${lines(t > 0 && `${t} 个任务`, s > 0 && `${s} 个会话`, v > 0 && `${v} 个视频`).join('、')}会移出项目，记录保留`,
      live.length > 0 && `运行中的原型${nameList(live)}会停掉`,
      routes.length > 0 && `域名 ${routes.join('、')} 会一起删除`,
    ) }
  }
  const deleteProject = (pj: Project) => {
    const protoIds = new Set(pj.prototypes.map((x) => x.id))
    setProjects((xs) => xs.filter((y) => y.id !== pj.id))
    setTasks((xs) => xs.map((t) => (t.project_id === pj.id ? { ...t, project_id: undefined, project_removed: pj.name } : t)))
    setSessions((xs) => xs.map((x) => (x.project_id === pj.id ? { ...x, project_id: undefined } : x)))
    setVideos((xs) => xs.map((x) => (x.project_id === pj.id ? { ...x, project_id: undefined } : x)))
    setDomainRoutes((xs) => xs.filter((r) => !(r.target.kind === 'proto' && protoIds.has(r.target.proto_id))))
    setProjectId(ALL_PROJECTS)
  }
  // 模型服务商：用它模型的 Agent 换成别家第一个可用模型；没得换就拦截
  const providerPlan = (id: string): DelPlan => {
    const mine = new Set(models.filter((m) => m.provider_id === id).map((m) => m.id))
    const users = agents.filter((a) => mine.has(a.model))
    if (!users.length) return { impact: [] }
    const rest = providers.filter((p) => p.id !== id)
    const alt = models.find((m) => !mine.has(m.id) && usable(m, rest).ok)
    if (!alt) return { block: `${nameList(users.map((a) => a.name))}在用它的模型，又没有别的可用模型可换；先接入别的服务商或给它们换模型`, impact: [] }
    return { impact: [`${nameList(users.map((a) => a.name))}在用它的模型，删除后改用 ${alt.name}`] }
  }
  const deleteProvider = (id: string) => {
    const mine = new Set(models.filter((m) => m.provider_id === id).map((m) => m.id))
    const alt = models.find((m) => !mine.has(m.id) && usable(m, providers.filter((p) => p.id !== id)).ok)
    setProviders((xs) => xs.filter((x) => x.id !== id))
    setModels((xs) => xs.filter((m) => m.provider_id !== id))
    if (alt) setAgents((xs) => xs.map((a) => (mine.has(a.model) ? { ...a, model: alt.id } : a)))
  }
  // Agent：有等确认的操作、被定时任务用着就拦截；项目里摘掉；会话、执行记录、产出保留
  const agentPlan = (id: string): DelPlan => {
    const waiting = agentRuns.filter((r) => r.agent_id === id && r.status === 'waiting').length
    const pend = sessions.filter((x) => x.agent_id === id && x.messages.some((m) => m.calls?.some((c) => c.state === 'pending'))).length
    const sc = schedules.filter((x) => x.action.kind === 'agent' && x.action.agent_id === id).map((x) => x.name)
    const block = lines(
      waiting + pend > 0 && `还有 ${waiting + pend} 处操作等你确认（执行记录或会话里），先处理完`,
      sc.length > 0 && `定时任务${nameList(sc)}交给它执行，先改掉或删掉这些定时任务`,
    ).join('；')
    const pj = projects.filter((p) => p.agent_ids.includes(id)).map((p) => p.name)
    return { block: block || undefined, impact: lines(pj.length > 0 && `会从项目${nameList(pj)}里摘掉`, '会话、执行记录和产出保留，显示为已删除的 Agent') }
  }
  const deleteAgent = (id: string) => {
    setAgents((xs) => xs.filter((x) => x.id !== id))
    setProjects((ps) => ps.map((p) => (p.agent_ids.includes(id) ? { ...p, agent_ids: p.agent_ids.filter((x) => x !== id) } : p)))
    setAgentView('list')
  }
  // SOP：有没走完的执行、被定时任务用着就拦截；项目里摘掉；执行记录带快照，保留
  const sopPlan = (id: string): DelPlan => {
    const live = runs.filter((r) => r.sop_id === id && ['running', 'waiting', 'failed'].includes(runStatus(r))).length
    const sc = schedules.filter((x) => x.action.kind === 'sop' && x.action.sop_id === id).map((x) => x.name)
    const block = lines(
      live > 0 && `还有 ${live} 次执行没走完（执行中、等人处理或失败待重试），先处理完或停掉`,
      sc.length > 0 && `定时任务${nameList(sc)}会发起它，先改掉或删掉这些定时任务`,
    ).join('；')
    const pj = projects.filter((p) => p.sop_ids.includes(id)).map((p) => p.name)
    return { block: block || undefined, impact: lines(pj.length > 0 && `会从项目${nameList(pj)}里摘掉`, '已有的执行记录保留') }
  }
  const deleteSop = (id: string) => {
    const i = SOPS.findIndex((s) => s.id === id)
    if (i >= 0) SOPS.splice(i, 1)
    setSops([...SOPS])
    setProjects((ps) => ps.map((p) => (p.sop_ids.includes(id) ? { ...p, sop_ids: p.sop_ids.filter((x) => x !== id) } : p)))
    setSopView('runs'); setOpenRun(null)
  }
  // 策略：先停掉没停的部署（运行中、暂停、异常挂起）并撤掉挂单，再删；回测有快照，保留
  const strategyPlan = (id: string): DelPlan => {
    const mine = tradeRuns.filter((r) => r.strategy_id === id)
    const live = mine.filter((r) => r.status !== 'stopped').length
    const ids = new Set(mine.map((r) => r.id))
    const n = orders.filter((o) => o.run_id && ids.has(o.run_id) && ACTIVE_ORDER.includes(o.status)).length
    return { impact: lines(live > 0 && `${live} 个运行中、暂停或异常挂起的部署会停止`, n > 0 && `${n} 笔挂单会撤销`, '已有的回测记录保留') }
  }
  const deleteStrategy = (st: Strategy) => {
    const at = new Date().toISOString()
    const mine = tradeRuns.filter((r) => r.strategy_id === st.id)
    // 异常挂起的也停：留着的话还能点「启动」，跑一个没有策略的运行
    const live = new Set(mine.filter((r) => r.status !== 'stopped').map((r) => r.id))
    const ids = new Set(mine.map((r) => r.id))
    setTradeRuns((xs) => xs.map((r) => (!live.has(r.id) ? r : {
      ...r, status: 'stopped', stopped_at: at, stop_reason: '策略已删除',
      logs: [...r.logs, { at, level: 'warn', text: `策略「${st.name}」已删除，运行停止，未成交的挂单已撤销` }],
    })))
    setOrders((xs) => xs.map((o) => (o.run_id && ids.has(o.run_id) && ACTIVE_ORDER.includes(o.status) ? { ...o, status: 'canceled', updated_at: at } : o)))
    setStrategies((xs) => xs.filter((x) => x.id !== st.id))
    setStrategyView('list')
  }
  // 交易账户：有持仓、挂单、在跑的部署就拦截；已停的运行和成交记录保留
  const accountBlock = (id: string) => {
    const pos = positions.filter((p) => p.account_id === id).length
    const ord = orders.filter((o) => o.account_id === id && ACTIVE_ORDER.includes(o.status)).length
    const run = tradeRuns.filter((r) => r.account_id === id && r.status !== 'stopped').length
    const left = lines(pos > 0 && `${pos} 个持仓`, ord > 0 && `${ord} 笔挂单`, run > 0 && `${run} 个没停的策略部署`)
    return left.length ? `账户里还有 ${left.join('、')}，先平仓、撤单、停掉部署再删除` : null
  }
  const deleteAccount = (id: string) => { if (!accountBlock(id)) setAccounts((xs) => xs.filter((x) => x.id !== id)) }

  /* ---------- 抽屉 ---------- */
  let drawerEl: React.ReactNode = null
  if (drawer?.kind === 'contact' || drawer?.kind === 'new-contact') {
    const current = drawer.kind === 'contact' ? contacts.find((c) => c.id === drawer.id) ?? null : null
    drawerEl = (
      <ContactDrawer key={drawer.kind === 'contact' ? drawer.id : 'new'} contact={current}
        initial={drawer.kind === 'new-contact' ? drawer.initial : undefined}
        onClose={() => setDrawer(null)}
        onSave={(d) => {
          if (current) { patchContact(current.id, d); return }
          const id = `ct_${Date.now().toString(36)}`
          setContacts((xs) => [{ ...d, id, created_at: new Date().toISOString() }, ...xs])
          setDrawer({ kind: 'contact', id })
        }}
        delImpact={current ? contactPlan(current.id).impact : []}
        onDelete={() => { if (current) deleteContact(current.id); setDrawer(null) }}
        onTouch={() => current && patchContact(current.id, { last_contact_at: new Date().toISOString() })} />
    )
  } else if (drawer?.kind === 'im-queue') {
    drawerEl = (
      <QueueDrawer runs={runs} messages={messages} onClose={() => setDrawer(null)}
        onOpenRun={(id) => { setPage('sop'); setOpenRun(id); setDrawer(null) }}
        onOpenMessage={(id) => setDrawer({ kind: 'message', id })}
        onStop={(ids) => setRuns((xs) => xs.map((r) => (ids.includes(r.id) ? actOnRun(r, { kind: 'stop' }) : r)))}
        onRetry={(id, step) => setRuns((xs) => xs.map((r) => (r.id === id ? actOnRun(r, { kind: 'retry', step }) : r)))} />
    )
  } else if (drawer?.kind === 'im-group') {
    const c = clusterMessages(messages).byKey.get(drawer.key)
    if (c) {
      const items = [...c.all].reverse()
      drawerEl = (
        <GroupDrawer key={c.key} row={{ ...c, head: items[0], items }} who={(m) => contactFor(m, contacts)?.name ?? m.sender_name}
          statusLabel={(k) => ({ done: '已处理', ignored: '已忽略', expired: '已过期', pending: '待处理' } as Record<string, string>)[k] ?? k}
          links={imLinksOf(c.all.map((m) => m.id))} onClose={() => setDrawer(null)}
          onAct={(id, kind) => actOnMessage(id, { kind })} onOpenMessage={openMessage}
          onStart={(intent) => setImStart({ ids: c.all.map((m) => m.id), intent })} onOpenSession={openSessionById}
          notes={notesOf(projects, c.all.map((m) => m.id))} onToMaterial={() => setImToMat(c.all.map((m) => m.id))} onOpenMaterial={openMaterial}
          triage={has('sop') ? <GroupTriageAdvice msgs={c.all} runs={runs} onOpenRun={openTriageRun} onStart={() => startTriage(c.all.map((m) => m.id))} /> : undefined}
          contactId={contactFor(items[0], contacts)?.id} onOpenContact={(id) => setDrawer({ kind: 'contact', id })}
          onSaveContact={() => setDrawer({ kind: 'new-contact', initial: { name: items[0].sender_name, im: { [items[0].channel]: items[0].sender_id }, group: '其他' } })} />
      )
    }
  } else if (drawer?.kind === 'message') {
    const m = messages.find((x) => x.id === drawer.id)
    if (m) drawerEl = (
      <MessageDrawer key={m.id} msg={m} contact={contactFor(m, contacts)} connector={connectors.find((c) => c.id === m.connector_id)}
        members={mentionMembers(messages, contacts, m.channel, (x) => (m.conversation ? x.conversation === m.conversation : !x.conversation && x.sender_id === m.sender_id))}
        onClose={() => setDrawer(null)} onAct={(a) => actOnMessage(m.id, a)}
        onOpenContact={(id) => setDrawer({ kind: 'contact', id })}
        onSaveContact={() => setDrawer({ kind: 'new-contact', initial: { name: m.sender_name, im: { [m.channel]: m.sender_id }, group: '其他' } })}
        task={tasks.find((t) => t.source.kind === 'im' && t.source.message_id === m.id)} onToTask={() => openTaskFromMessage(m.id)}
        deal={deals.find((d) => d.source_message_id === m.id)} onToDeal={has('videos') ? () => openDealFromMessage(m.id) : undefined}
        onFixConnector={() => { const cid = m.connector_id; go('settings'); setSection('connectors'); setDrawer({ kind: 'connector', id: cid }) }}
        projects={projects} msgProjects={projects.filter((pj) => projectMessages(pj, [m], contacts).length > 0).map((pj) => pj.id)}
        onFetchAttachment={(aid) => fetchAttachment(m.id, aid)} onAddAttachment={(aid, pid) => addAttachmentToProject(pid, m.id, aid)}
        onSetProject={(pid) => patchMsg(m.id, { project_id: pid })}
        links={imLinksOf([m.id])} onStartSession={(intent) => setImStart({ ids: [m.id], intent })} onOpenSession={openSessionById}
        onToMaterial={() => setImToMat([m.id])} onOpenMaterial={openMaterial}
        triage={has('sop') ? <TriageAdvice runs={triageRunsOf(runs, m.id)} focus={drawer.focus === 'triage'} onOpenRun={openTriageRun} onStart={() => startTriage([m.id])} /> : undefined}
        thread={threadOf(m, messages)} threadParent={m.thread?.parent_id ? messages.find((x) => x.id === m.thread!.parent_id) : undefined}
        onOpenMessage={openMessage} onActOther={actOnMessage} />
    )
  } else if (drawer?.kind === 'connector' || drawer?.kind === 'new-connector') {
    // 一个工具只接一个账号：对已经接过的工具发起接入，就打开它现有的那个
    const current = drawer.kind === 'connector' ? connectors.find((c) => c.id === drawer.id) ?? null : connectors.find((c) => c.tool === drawer.tool) ?? null
    const tool = TOOLS.find((t) => t.key === (current?.tool ?? (drawer.kind === 'new-connector' ? drawer.tool : '')))
    // 即时通讯用原来的抽屉；应用与 API、自定义用带认证方式和工具清单的抽屉
    const Drawer = tool && tool.category !== 'im' ? ApiConnectorDrawer : ConnectorDrawer
    if (tool) drawerEl = (
      <Drawer key={current?.id ?? `new-${tool.key}`} tool={tool} connector={current}
        onConnect={current ? () => connectConn(current.id) : undefined} onDisconnect={current ? () => disconnectConn(current.id) : undefined}
        onClose={() => setDrawer(null)}
        onSave={(d) => {
          // 断开、连接中的状态由连接条管，保存配置不改它
          if (current) setConnectors((xs) => xs.map((x) => (x.id === current.id ? { ...x, ...d, ...(x.status === 'disconnected' || x.status === 'connecting' ? { status: x.status, error: x.error } : {}) } : x)))
          else setConnectors((xs) => [...xs, { ...d, id: `cn_${Date.now().toString(36)}`, created_at: new Date().toISOString() }])
          setDrawer(null)
        }}
        delImpact={current ? connPlan(current.id).impact : []}
        onBackfillEmails={current?.tool === 'slack' ? () => {
          // 从 Slack 补联系人邮箱（SPEC-settings-4.7d）：Token 里带 noemail 时模拟缺 users:read.email
          const { result, patches } = backfillSlackEmails(contacts, /noemail/i.test(current.config.bot_token ?? ''))
          if (Object.keys(patches).length) setContacts((xs) => xs.map((x) => (patches[x.id] ? { ...x, email: patches[x.id] } : x)))
          return result
        } : undefined}
        onDelete={() => { if (current) deleteConnector(current.id); setDrawer(null) }} />
    )
  }

  if (drawer?.kind === 'task' || drawer?.kind === 'new-task') {
    const task = drawer.kind === 'task' ? tasks.find((t) => t.id === drawer.id) ?? null : null
    const msg = drawer.kind === 'new-task' && drawer.fromMessage ? messages.find((x) => x.id === drawer.fromMessage) : undefined
    if (drawer.kind === 'new-task' || task) drawerEl = (
      <TaskDrawer key={task?.id ?? `new-${msg?.id ?? ''}`} projects={projects} task={task} initial={drawer.kind === 'new-task' ? drawer.initial : undefined} fromMessage={msg}
        fromThread={msg ? threadForTask(msg, messages) : undefined} threadWho={(x) => contactFor(x, contacts)?.name ?? x.sender_name}
        tab={drawer.kind === 'task' ? drawer.tab : undefined} focusRun={drawer.kind === 'task' ? drawer.run : undefined} focusSopRun={drawer.kind === 'task' ? drawer.sopRun : undefined}
        hooks={hooks} deliveries={deliveries} assignees={assignees} onClose={() => setDrawer(null)}
        onOpenMessage={(id) => { setPage('messages'); openMessage(id) }}
        onOpenHook={(id) => { setPage('tasks'); setTaskView(`hook:${id}`); setDrawer(null) }}
        onOpenSchedule={(id) => { setPage('tasks'); setTaskView('schedules'); setDrawer({ kind: 'schedule', id }) }}
        onOpenIncident={(id) => { go('settings'); setSection('incidents'); setDrawer({ kind: 'incident', id }) }}
        delImpact={task ? taskPlan(task.id).impact : []} dev={dev}
        reminders={task ? {
          list: remindersOf(schedules, task.id),
          onAdd: (f) => setSchedules((xs) => [taskReminder(newId('sc'), task.id, f), ...xs]),
          onCancel: (id) => setSchedules((xs) => xs.filter((y) => y.id !== id)),
        } : undefined}
        handoff={{
          // 终端插件在跑 = 当前工作台开着终端模块（原型里插件启停就是模块开关）
          terminalOn: has('terminal'),
          onTerminal: ({ task: t, runId, workdir }) => {
            const cmd = renderClaudeCommand(claudeCommand, { ...handoffFiles(runId), workdir })
            const tb = launchTab(workdir, t.ref, cmd, `从任务 ${t.ref} 交给 Claude Code（执行记录 ${runId}），按设置里的启动命令打开会话`)
            setTermTabs((ts) => [...ts, tb]); setTermActive(tb.id)
            go('terminal')
          },
          onManagePresets: () => { setDrawer(null); go('settings'); setSection('run-prompts') },
        }}
        sop={task ? {
          runs, sops,
          onStart: (sopId) => { const s = sopById(sopId); if (s) setDrawer({ kind: 'sop-start', sopId, initial: taskPrefill(s, task), objectId: task.id }) },
          onOpenRun: (id) => { setPage('sop'); setOpenRun(id); setRunFromTask(task.id); setDrawer(null) },
          gov: sopGov,
          onAct: (runId, a) => setRuns((xs) => xs.map((r) => (r.id === runId ? actOnRun(r, a) : r))),
        } : undefined}
        onDelete={() => { if (task) deleteTask(task.id); setDrawer(null) }}
        onSave={(d, markDone, replyOnDone) => {
          // 重新挑了项目，「原属项目已删除」的提示就不要了
          if (task) { patchTask(task.id, d.project_id ? { ...d, project_removed: undefined } : d); setDrawer(null); return }
          // 提出人（SPEC-tasks-11.6）：发送者认到联系人记联系人，认不上记发送者快照；IM 转来的从「已接收」开始
          const ct = msg ? contactFor(msg, contacts) : undefined
          const requester = msg ? (ct ? { contact_id: ct.id, name: ct.name, channel: msg.channel, sender_id: msg.sender_id }
            : { name: msg.sender_name || msg.sender_id, channel: msg.channel, sender_id: msg.sender_id, sender_name: msg.sender_name }) : undefined
          const t = newTask(tasks, { ...d, ...(msg ? { stage: 'received', requester } : {}), source: msg ? { kind: 'im', message_id: msg.id, channel: msg.channel, sender: msg.sender_name, text: msg.text, reply_on_done: replyOnDone } : { kind: 'manual' } })
          setTasks((xs) => [t, ...xs])
          if (msg && markDone && msg.status === 'pending') patchMsg(msg.id, { status: 'done', snooze_until: null, read: true })
          setDrawer({ kind: 'task', id: t.id })
        }} />
    )
  }

  if (drawer?.kind === 'provider' || drawer?.kind === 'new-provider') {
    const current = drawer.kind === 'provider' ? providers.find((p) => p.id === drawer.id) ?? null : null
    const kind = current?.kind ?? (drawer.kind === 'new-provider' ? drawer.provider : 'anthropic')
    drawerEl = (
      <ProviderDrawer key={current?.id ?? `new-${kind}`} provider={current} kind={kind} models={models} onClose={() => setDrawer(null)}
        onSave={(p, ms) => {
          setProviders((xs) => (xs.some((x) => x.id === p.id) ? xs.map((x) => (x.id === p.id ? p : x)) : [...xs, p]))
          setModels((xs) => [...xs.filter((m) => m.provider_id !== p.id), ...ms])
          setDrawer(null)
        }}
        delPlan={current ? providerPlan(current.id) : undefined}
        // 对方返回的错误按 provider:<id>:<错误码> 记，和连接器一样；没有错误码的（地址写错这类）记成 config
        onFail={(id, name, error) => {
          const code = /^(\d{3})\b/.exec(error)?.[1] ?? 'config'
          report({ fingerprint: `provider:${id}:${code}`, level: 'error', module: '模型服务商', title: `${name} ${code === '401' ? '鉴权失败' : '连接失败'}`, message: error, context: { 服务商: name, 类型: kindOf(kind).label } })
        }}
        onDelete={() => { if (current && !providerPlan(current.id).block) deleteProvider(current.id); setDrawer(null) }} />
    )
  }

  // 知识库能检索的资料：勾选的文档分类 + 本地目录里的文件
  if (drawer?.kind === 'kb' || drawer?.kind === 'new-kb') {
    const kb = drawer.kind === 'kb' ? kbs.find((x) => x.id === drawer.id) ?? null : null
    if (drawer.kind === 'new-kb' || kb) drawerEl = (
      <KbDrawer key={kb?.id ?? 'new'} kb={kb} agents={agents} onClose={() => setDrawer(null)}
        onSave={(k) => { setKbs((xs) => (xs.some((y) => y.id === k.id) ? xs.map((y) => (y.id === k.id ? k : y)) : [...xs, k])); setDrawer({ kind: 'kb', id: k.id }) }}
        onDelete={() => { if (kb) { setKbs((xs) => xs.filter((y) => y.id !== kb.id)); setAgents((xs) => xs.map((a) => ({ ...a, kbs: a.kbs.filter((x) => x !== kb.id) }))) } setDrawer(null) }} />
    )
  }
  if (drawer?.kind === 'skill' || drawer?.kind === 'new-skill') {
    const sk = drawer.kind === 'skill' ? skills.find((x) => x.id === drawer.id) ?? null : null
    const from = drawer.kind === 'new-skill' && drawer.from ? skills.find((x) => x.id === drawer.from) : undefined
    if (drawer.kind === 'new-skill' || sk) drawerEl = (
      <SkillDrawer key={sk?.id ?? `new-${from?.id ?? ''}`} isNew={!sk} skill={sk ?? (from ? { ...from, id: `sk_${Date.now().toString(36)}`, name: `${from.name}（我的）`, source: '自定义' } : null)}
        agents={agents} toolNames={connToolChoices.map((t) => `${t.conn} · ${t.name}`)} onClose={() => setDrawer(null)}
        onSave={(k) => { setSkills((xs) => (xs.some((y) => y.id === k.id) ? xs.map((y) => (y.id === k.id ? k : y)) : [...xs, k])); setDrawer({ kind: 'skill', id: k.id }) }}
        onDuplicate={(k) => setDrawer({ kind: 'new-skill', from: k.id })}
        onDelete={() => { if (sk) { setSkills((xs) => xs.filter((y) => y.id !== sk.id)); setAgents((xs) => xs.map((a) => ({ ...a, skills: a.skills.filter((x) => x !== sk.id) }))) } setDrawer(null) }} />
    )
  }

  if (drawer?.kind === 'incident') {
    const inc = incidents.find((x) => x.id === drawer.id)
    if (inc) drawerEl = (
      <IncidentDrawer key={inc.id} incident={inc} task={inc.task_id ? tasks.find((t) => t.id === inc.task_id) : undefined} assignees={assignees}
        onClose={() => setDrawer(null)}
        onStatus={(st) => setIncidents((xs) => xs.map((x) => (x.id === inc.id ? { ...x, status: st, note: undefined } : x)))}
        onOpenTask={(id) => setDrawer({ kind: 'task', id })}
        onToTask={(d) => {
          const t = newTask(tasks, { ...d, source: { kind: 'incident', incident_id: inc.id, title: inc.title } })
          setTasks((xs) => [t, ...xs])
          setIncidents((xs) => xs.map((x) => (x.id === inc.id ? { ...x, status: 'tasked', task_id: t.id, note: undefined } : x)))
        }} />
    )
  }

  if (drawer?.kind === 'schedule' || drawer?.kind === 'new-schedule') {
    const sc = drawer.kind === 'schedule' ? schedules.find((x) => x.id === drawer.id) ?? null : null
    if (drawer.kind === 'new-schedule' || sc) drawerEl = (
      <ScheduleDrawer key={sc?.id ?? 'new'} schedule={sc} sops={sops} agents={agents} assignees={assignees} publishes={pubNames}
        onOpenPublish={(id) => { const p = publishes.find((x) => x.id === id); if (p) openPublishOf(p) }}
        onOpenCalendar={has('videos') ? () => { setPage('videos'); setDrawer(null); setVideoView('calendar') } : undefined}
        onClose={() => setDrawer(null)}
        onSave={(x) => { setSchedules((xs) => (xs.some((y) => y.id === x.id) ? xs.map((y) => (y.id === x.id ? x : y)) : [x, ...xs])); setDrawer({ kind: 'schedule', id: x.id }) }}
        onDelete={() => { setSchedules((xs) => xs.filter((y) => y.id !== sc?.id)); setDrawer(null) }}
        onRunNow={runScheduleNow}
        taskName={(id) => { const t = tasks.find((x) => x.id === id); return t && `${t.ref} ${t.title}` }}
        openTask={(ref) => { const t = tasks.find((x) => x.ref === ref); return t && (() => setDrawer({ kind: 'task', id: t.id })) }} />
    )
  }

  if (drawer?.kind === 'deal' || drawer?.kind === 'new-deal') {
    const dl = drawer.kind === 'deal' ? deals.find((x) => x.id === drawer.id) ?? null : null
    const init = drawer.kind === 'new-deal' ? drawer.initial : undefined
    const srcId = dl?.source_message_id ?? init?.source_message_id
    if (drawer.kind === 'new-deal' || dl) drawerEl = (
      <DealDrawer key={dl?.id ?? `new-${srcId ?? ''}`} deal={dl} initial={init} projects={projects} contacts={contacts} videos={videos} publishes={publishes} artifacts={artifacts}
        message={srcId ? messages.find((m) => m.id === srcId) : undefined}
        onClose={() => setDrawer(null)} onSave={saveDeal}
        onDelete={() => { setDeals((xs) => xs.filter((y) => y.id !== dl?.id)); setDrawer(null) }}
        onReport={makeDealReport}
        onOpenReport={(cid) => { setDrawer(null); setPage('library'); switchWs('builtin'); setReading(cid) }}
        onOpenVideo={(id) => { setDrawer(null); setPage('videos'); openVideo(id) }}
        onOpenMessage={has('messages') ? (id) => { setPage('messages'); setDrawer({ kind: 'message', id }) } : undefined}
        onReview={(aid, r) => setArtifacts((xs) => xs.map((a) => (a.id === aid ? { ...a, reviews: [...a.reviews, r] } : a)))} />
    )
  }

  if (drawer?.kind === 'sop-start') {
    const sop = sopById(drawer.sopId)
    const objectId = drawer.objectId
    const objectTask = objectId ? tasks.find((t) => t.id === objectId) : undefined
    // SOP 删了（比如从旧执行记录点重新执行）就不开
    if (sop) drawerEl = (
      <SopStartDrawer key={drawer.sopId} sop={sop} initial={drawer.initial} onClose={() => setDrawer(objectId ? { kind: 'task', id: objectId } : null)}
        object={objectTask && { ref: objectTask.ref, title: objectTask.title }}
        onStart={(input, stepThrough) => {
          const run = startRun(sop, input, stepThrough, Date.now(), { objectId, source: 'manual' })
          setRuns((xs) => [run, ...xs])
          // 在任务上发起的留在任务详情，新的一条出现在「SOP 执行」最上面
          if (objectId) { setDrawer({ kind: 'task', id: objectId }); return }
          setOpenRun(run.id)
          setDrawer(null)
        }} />
    )
  }

  const selectedId = drawer && 'id' in drawer ? drawer.id : null

  return (
    <EnumContext.Provider value={enums}>
    <TopbarContext.Provider value={topSlot}>
    <OpenUrlContext.Provider value={openInBrowser}>
    <ProtoDomainContext.Provider value={(id) => protoDomain(id, domainRoutes, domainSettings, protoRefs)}>
    <FrameAllowContext.Provider value={frameAllow}>
    <div className="shell" data-lib={page === 'library' ? (lib.rows.some((r) => r.id === reading) ? 'reader' : 'tree') : undefined}>
      <aside className={cls('side', collapsed && 'side-collapsed')}>
        <div className="brand-row">
          <WorkspaceSwitcher list={benches} current={bench.id} collapsed={collapsed}
            onSwitch={switchBench} onManage={() => { go('settings'); setSection('workspace') }} />
          <button className="icon-btn side-toggle" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开菜单' : '收起菜单'} aria-expanded={!collapsed}>
            <svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.4" />{collapsed ? <path d="m9 6.5 1.8 1.5L9 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M10.8 6.5 9 8l1.8 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}</svg>
          </button>
        </div>
        {/* 搜索和新建会话并排；快捷键放在提示里，按钮太窄放不下 */}
        <div className="side-actions">
          <button className="side-act" onClick={() => setPalette(true)} title="搜索 (⌘K)">
            <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            <span className="side-label">搜索</span>
          </button>
          <button className="side-act" onClick={() => setQuickSession(true)} title="新建会话 (⌘J)">
            <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15"><path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a2 2 0 0 1-1.5-2Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 4.8v3.6M6.2 6.6h3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            <span className="side-label">新建会话</span>
          </button>
        </div>
        <nav className="side-group">
          {/* 按工作台的分组显示；分组名为空只留间距，菜单收起时分组之间画一条线 */}
          {bench.groups.map((grp, gi) => {
            const items = grp.modules.map((k) => MENU.find((m) => m.key === k)).filter((m): m is (typeof MENU)[number] => !!m)
            if (!items.length) return null
            const folded = !!grp.name && !!grp.collapsed
            return (
              <div key={grp.id} className={cls('side-sec', gi > 0 && 'side-sec-gap', folded && 'side-sec-folded')}>
                {grp.name && (
                  <button className="side-sec-title" onClick={() => toggleGroup(grp.id)} aria-expanded={!folded} title={folded ? '展开' : '折叠'}>
                    <svg className="side-sec-chev" viewBox="0 0 16 16" width="10" height="10"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <span>{grp.name}</span>
                    {/* 折叠后组里有事等你处理，红点挪到标题上 */}
                    {folded && items.some((it) => it.alert) && <span className="side-dot" />}
                  </button>
                )}
                {items.map((it) => (
                  // 折叠的组里只留当前打开的那一项；收起成图标和窄屏横排时不折叠（见样式）
                  <button key={it.key} className={cls('side-item', page === it.key && 'active', folded && page !== it.key && 'side-item-folded')} onClick={() => go(it.key)} title={collapsed ? it.label : undefined}>
                    {icons[it.key]}<span className="side-label">{it.label}</span>
                    {/* 菜单上不放数量，只在有事等你处理时给个红点 */}
                    {it.alert && <span className="side-dot" title={`${it.badge} 条待处理`} />}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="side-foot">
          <button className={cls('side-item', page === 'settings' && 'active')} onClick={() => go('settings')} title={collapsed ? '设置' : undefined}>
            {icons.settings}<span className="side-label">设置</span>
            {brokenConnectors + brokenProviders + openIncidents > 0 && (
              <span className="side-dot" title={[brokenConnectors && `${brokenConnectors} 个连接器异常`, brokenProviders && `${brokenProviders} 个模型服务商连接异常`, openIncidents && `${openIncidents} 个运行错误未处理`].filter(Boolean).join('，')}/>
            )}
          </button>
          {/* 总览不是模块，不占一级菜单的位置；放在设置旁边，冒烟脚本点的第一个 .side-item 仍是设置 */}
          <button className={cls('icon-btn side-ov', page === 'overview' && 'active')} onClick={() => go('overview')} title="原型总览：每页做什么、对应规格哪一节" aria-label="原型总览">
            {icons.overview}
          </button>
        </div>
      </aside>
      {page === 'tasks' && <TasksNav tasks={tasks} hooks={hooks} deliveries={deliveries} view={taskView} onSelect={(v) => { setTaskView(v); setDrawer(null) }} onNewHook={() => { setTaskView('hook:new'); setDrawer(null) }} />}
      {page === 'library' && <LibraryTree ws={ws} model={lib} items={content} folders={folders} selected={reading} onSelect={setReading} onSwitch={switchWs}
        defaultWs={defaultWs} onSetDefault={setDefaultWs}
        onAddFolder={addFolder} onRemoveFolder={removeFolder} q={libQ} onQ={setLibQ} adding={folderBusy} error={folderError} />}
      {page === 'strategy' && <StrategyNav strategies={strategies} backtests={backtests} runs={tradeRuns} view={strategyView} onSelect={setStrategyView} onNew={newStrategy} />}
      {page === 'trading' && <TradingNav view={tradingView} onSelect={setTradingView} accounts={accounts} runs={tradeRuns} risk={risk}
        onKill={() => { const s = killAll({ runs: tradeRuns, orders, risk }, '手动一键全停'); setTradeRuns(s.runs); setOrders(s.orders); setRisk(s.risk) }} />}
      {page === 'sop' && !sopView.startsWith('edit:') && <SopNav sops={sops} runs={runs} view={sopView} onSelect={(v) => { setSopView(v); setOpenRun(null); setSopFilter(undefined) }} onNew={() => { setSopView('edit:new'); setOpenRun(null) }} />}
      {page === 'settings' && (
        <SettingsNav active={section} alerts={{ connectors: brokenConnectors, providers: brokenProviders, incidents: openIncidents }}
          onSelect={(k) => leaveAgent(() => { setSection(k as Section); if (k === 'agents') setAgentView('list'); setDrawer(null) })} />
      )}
      <div className="main">
        <div className="topbar">
          {page === 'library' ? <LibraryBar model={lib} kind={libKind} onKind={setLibKind} onRefresh={refreshFolder} /> : <div className="tb-slot" ref={setTopSlot} />}
        </div>
        {/* 内容页自己分两栏各自滚动，外层不滚 */}
        <main ref={mainRef} className={cls('content', (page === 'library' || page === 'terminal' || page === 'browser' || page === 'markets' || (page === 'sessions' && sessionView === 'chats') || (page === 'settings' && (section === 'enums' || (section === 'agents' && agentView !== 'list'))) || (page === 'sop' && (openRun || sopView.startsWith('edit:')))) && 'content-flush')}>
          {page === 'library' && (
            <LibraryReader model={lib} selected={reading} onSelect={setReading}
              onStar={(id) => setContent((xs) => xs.map((x) => (x.id === id ? { ...x, starred: !x.starred } : x)))} />
          )}
          {page === 'contacts' && (
            <ContactsPage contacts={contacts} selected={selectedId} onOpen={(id) => setDrawer({ kind: 'contact', id })} onNew={() => setDrawer({ kind: 'new-contact' })}
              onStar={(id) => patchContact(id, { starred: !contacts.find((c) => c.id === id)?.starred })} />
          )}
          {page === 'tasks' && taskView === 'schedules' && (
            <SchedulesPage schedules={schedules} sops={sops} agents={agents} publishes={pubNames} selected={drawer?.kind === 'schedule' ? drawer.id : null}
              onOpen={(id) => setDrawer({ kind: 'schedule', id })} onNew={() => setDrawer({ kind: 'new-schedule' })}
              onToggle={(id, on) => setSchedules((xs) => xs.map((y) => (y.id === id ? { ...y, enabled: on } : y)))} />
          )}
          {page === 'tasks' && taskView !== 'schedules' && (taskView.startsWith('hook:') ? (() => {
            const id = taskView.slice(5)
            const hook = id === 'new' ? null : hooks.find((h) => h.id === id)
            const h = hook ?? newHook()
            return (
              <WebhookPage key={hook?.id ?? 'new'} hook={h} creating={!hook} deliveries={deliveries} tasks={tasks}
                onCancel={() => setTaskView('hooks')}
                onSave={(x) => { setHooks((xs) => (hook ? xs.map((y) => (y.id === x.id ? x : y)) : [...xs, x])); if (!hook) setTaskView(`hook:${x.id}`) }}
                onDelete={() => { setHooks((xs) => xs.filter((y) => y.id !== h.id)); setTaskView('hooks') }}
                onOpenTask={(tid) => setDrawer({ kind: 'task', id: tid })}
                onTest={(x, payload) => {
                  const r = ingest(x, payload, tasks, deliveries)
                  setDeliveries((ds) => [r.delivery, ...ds])
                  if (r.delivery.result === 'failed') report({ fingerprint: `webhook:${x.id}:${r.delivery.reason}`, level: 'warn', module: 'Webhook', title: `${x.name}：推送没建成任务`, message: r.delivery.reason ?? '映射失败', context: { Webhook: x.name, 推送内容: payload } })
                  if (r.task) setTasks((ts) => [r.task!, ...ts])
                  return r
                }} />
            )
          })() : (
            <TasksPage tasks={tasks} hooks={hooks} projects={projects} view={taskView as 'all'} selected={selectedId} onOpen={(id) => setDrawer({ kind: 'task', id })}
              onNew={() => setDrawer({ kind: 'new-task' })} onStatus={(id, st: TaskStatus) => patchTask(id, { status: st })} onApprove={(id) => dev.review(id, true, '')}
              deliveries={deliveries} onOpenHook={(id) => setTaskView(`hook:${id}`)} onNewHook={() => setTaskView('hook:new')}
              onStage={(id, stage) => {
                // 阶段变化记进 stage_log，流水线时间线用（正式产品是审计 kind=stage）
                const t = tasks.find((x) => x.id === id)
                if (!t || (t.stage ?? '') === stage) return
                patchTask(id, { stage: stage || undefined, stage_log: [...(t.stage_log ?? []), { at: new Date().toISOString(), from: t.stage ?? '', to: stage }] })
              }}
              onOpenBoard={(id) => setDrawer({ kind: 'task', id, tab: 'pipeline' })} />
          ))}
          {page === 'messages' && (
            <MessagesPage messages={messages} contacts={contacts} connectors={connectors} selected={selectedId}
              onSync={syncMessages} syncing={syncing} syncResult={syncResult}
              onOpen={openMessage} onAct={actOnMessage} onGoConnectors={openImConnectors} onToTask={openTaskFromMessage}
              taskOf={(id) => tasks.find((t) => t.source.kind === 'im' && t.source.message_id === id)?.ref}
              projects={projects} groupProjects={groupProjects}
              onSetGroupProject={(k, pid) => setGroupProjects((x) => { const n = { ...x }; if (pid) n[k] = pid; else delete n[k]; return n })}
              sops={sops} runs={runs} onOpenQueue={() => setDrawer({ kind: 'im-queue' })}
              onOpenTriage={(id) => { openMessage(id); setDrawer({ kind: 'message', id, focus: 'triage' }) }}
              selectedGroup={drawer?.kind === 'im-group' ? drawer.key : null} onOpenGroup={(key) => setDrawer({ kind: 'im-group', key })}
              onStartSession={(ids, intent) => setImStart({ ids, intent })} linksOf={imLinksOf} onOpenSession={openSessionById}
              onToMaterial={setImToMat} onOpenMaterial={openMaterial}
              onBatchTriage={(sopId, ids, rerun) => {
                // 正式产品是 SOP 插件的批量发起接口：按 message_id 跳过这条流程已经跑过的（任意状态），来源记手动「批量发起」
                const sop = sops.find((x) => x.id === sopId)
                if (!sop) return { started: 0, skipped: 0 }
                const ran = new Set(runs.filter((r) => r.sop_id === sopId).map((r) => r.input.message_id))
                const now = Date.now()
                const todo = rerun ? ids : ids.filter((id) => !ran.has(id))
                const fresh = todo.map((id, i) => startRun(sop, { ...Object.fromEntries(sop.fields.map((f) => [f.key, f.default ?? ''])), message_id: id }, false, now + i,
                  { source: 'manual', sourceName: '批量发起' }))
                setRuns((xs) => [...fresh, ...xs])
                return { started: fresh.length, skipped: ids.length - todo.length }
              }} />
          )}
          {page === 'sop' && (() => {
            const run = runs.find((r) => r.id === openRun)
            if (run) return (
              <SopRunView key={run.id} run={run}
                onBack={() => { const back = openRun ?? undefined; setOpenRun(null); if (runFromTask) { const id = runFromTask; setRunFromTask(null); setPage('tasks'); setDrawer({ kind: 'task', id, tab: 'sop', sopRun: back }) } }}
                onAct={(a: RunAction) => setRuns((xs) => xs.map((r) => (r.id === run.id ? actOnRun(r, a) : r)))}
                onRerun={() => setDrawer({ kind: 'sop-start', sopId: run.sop_id, initial: run.input })}
                onOpenSettings={() => { go('settings'); setSection('sop') }}
                onOpenRun={(id) => { if (runs.some((r) => r.id === id)) setOpenRun(id) }} />
            )
            if (sopView.startsWith('edit:')) {
              const id = sopView.slice(5)
              const existing = id === 'new' ? null : sopById(id)
              return (
                <SopEditor key={sopView} initial={existing ?? newSopDraft()} creating={!existing} runs={runs} sopList={sops.map((x) => ({ id: x.id, name: x.name }))}
                  onCancel={() => setSopView(existing ? `sop:${existing.id}` : 'runs')}
                  onSave={(sop, thenRun) => {
                    upsertSop(sop)
                    setSops([...SOPS])
                    setSopView(`sop:${sop.id}`)
                    if (thenRun) setDrawer({ kind: 'sop-start', sopId: sop.id })
                  }} />
              )
            }
            if (sopView.startsWith('sop:')) {
              const sop = sopById(sopView.slice(4))
              if (!sop) return <div className="page"><PageTitle>SOP</PageTitle><div className="empty"><div className="empty-title">这个 SOP 已经删除</div></div></div>
              return <SopDetailPage key={sop.id} sop={sop} runs={runs} onOpen={setOpenRun} onEdit={() => setSopView(`edit:${sop.id}`)} onStart={() => setDrawer({ kind: 'sop-start', sopId: sop.id })}
                onAllRuns={() => { setSopFilter(sop.id); setSopView('runs') }}
                delPlan={sopPlan(sop.id)} onDelete={() => { if (!sopPlan(sop.id).block) deleteSop(sop.id) }} />
            }
            // 流程库（library）也走这里；带着 SOP 筛选进来时换 key 重置页面里的筛选
            return <SopRunsPage key={`${sopView}:${sopFilter ?? ''}`} runs={runs} view={sopView as 'runs' | 'waiting' | 'library'} sop={sopFilter} onOpen={setOpenRun}
              onRerun={(ids, action) => { const x = rerunRuns(runs, ids, action); setRuns(x.runs); return x.result }}
              sops={sops} onOpenSop={(id) => setSopView(`sop:${id}`)} onNew={() => { setSopView('edit:new'); setOpenRun(null) }} />
          })()}
          {page === 'overview' && <OverviewPage benches={benches} current={bench.id} onOpen={openFromOverview} />}
          {page === 'today' && (
            <TodayPage needs={todayNeeds} tasks={tasks} schedules={todaySchedules} running={todayRunning}
              more={{
                待我处理: has('sop') ? () => { go('sop'); setSopView('waiting') } : undefined,
                // 原型的任务页不能带状态筛选打开，先去全部任务；正式产品带 status=review
                任务待验收: has('tasks') ? () => { go('tasks'); setTaskView('all') } : undefined,
                'Agent 待确认': has('sessions') ? () => { go('sessions'); setSessionView('runs') } : undefined,
                'IM 消息': has('messages') ? () => go('messages') : undefined,
                运行异常: () => { go('settings'); setSection('incidents') },
                连接异常: () => { go('settings'); setSection('connectors') },
              }}
              onOpenTask={(id) => setDrawer({ kind: 'task', id })} onDoneTask={(id) => patchTask(id, { status: 'done' })} onApproveTask={(id) => dev.review(id, true, '')}
              // 逾期视图的 key 和任务组约定为 due
              onAllTasks={(v) => { go('tasks'); setTaskView(v ?? 'all') }}
              onAllSchedules={() => { go('tasks'); setTaskView('schedules') }}
              onAllRunning={() => {
                // 有原型在跑就去浏览器首页（按项目分组、在跑的展开），否则看 SOP 执行记录
                if (has('browser') && todayRunning.some((r) => r.href)) openInBrowser(HOME_URL, '新标签页')
                else if (has('sop')) { go('sop'); setSopView('runs') }
                else go('projects')
              }} />
          )}
          {page === 'projects' && projectId === ALL_PROJECTS && (
            <ProjectsListPage projects={projects} messages={messages} contacts={contacts} tasks={tasks} recent={recentProjects}
              onOpen={(id) => { setProjectId(id); setProjectTab('overview'); setProjectChat(null) }} onNew={newProject} />
          )}
          {page === 'projects' && projectId !== ALL_PROJECTS && (() => {
            const pj = projects.find((x) => x.id === projectId)
            if (!pj) return <div className="page"><div className="empty"><div className="empty-title">这个项目不存在或已删除</div><button className="btn btn-outline" onClick={() => setProjectId(ALL_PROJECTS)}>回到项目列表</button></div></div>
            return (
              <ProjectPage key={pj.id} project={pj} projects={projects} agents={agents} content={content} tab={projectTab} onTab={(t) => { setProjectTab(t); setMatFocus(null) }} onAll={() => setProjectId(ALL_PROJECTS)}
                recent={recentProjects} onSwitch={(id) => { setProjectId(id); setMatFocus(null); setProjectChat(null) }}
                dock={(() => { const d = docks[pj.id] ?? EMPTY_DOCK; return { term: d.term.length, browser: d.brTabs, open: d.open && (d.term.length || d.br) ? d.view : null } })()}
                onDock={(v) => showDock(pj.id, v, true)}
                onChange={(x) => setProjects((xs) => xs.map((y) => (y.id === x.id ? x : y)))}
                delImpact={projectPlan(pj).impact}
                onDelete={() => deleteProject(pj)}
                onStart={startProto} onStop={stopProto}
                onOpenDoc={(cid) => { setPage('library'); switchWs('builtin'); setReading(cid) }}
                onChat={(agentId) => newProjectSession(agentId, pj.id)}
                onOpenAgent={(id) => { go('settings'); setSection('agents'); setAgentView(id) }}
                deals={has('videos') ? <DealsTab project={pj} deals={deals} videos={videos} selected={drawer?.kind === 'deal' ? drawer.id : null} onOpen={openDeal}
                  onNew={() => setDrawer({ kind: 'new-deal', initial: { project_id: pj.id } })} /> : undefined}
                dealAlert={has('videos') && dueDeals(deals).some((d) => d.project_id === pj.id)}
                links={{
                  messages, contacts, tasks, sops, runs, sessions,
                  connectors: connectors.filter((c) => TOOLS.find((t) => t.key === c.tool)?.category === 'im'),
                  onOpenMessage: openMessage, onOpenContact: (id) => setDrawer({ kind: 'contact', id }),
                  onNewTask: () => setDrawer({ kind: 'new-task', initial: { project_id: pj.id } }),
                  onOpenTask: (id) => setDrawer({ kind: 'task', id }),
                  // 待验收的任务点圆圈和任务页一样先弹确认，确认后等于验收通过
                  onTaskStatus: (id, st) => patchTask(id, { status: st }), onApproveTask: (id) => dev.review(id, true, ''),
                  onStartSop: (id) => setDrawer({ kind: 'sop-start', sopId: id }),
                  onOpenRun: (id) => { setPage('sop'); setOpenRun(id) },
                  onOpenSop: (id) => { setPage('sop'); setSopView(`sop:${id}`); setOpenRun(null) },
                  onOpenSession: (id) => { setPage('sessions'); setSessionView('chats'); setCurrentSession(id) },
                  onAllSessions: () => { setPage('sessions'); setSessionView('chats'); setSessionProject(pj.id); setDrawer(null) },
                  chatOpen: projectChat, onChatOpen: setProjectChat,
                  renderChat: (s, head) => {
                    const found = agents.find((a) => a.id === s.agent_id)
                    const agent = found ?? goneAgent(s.agent_id)
                    return (
                      <ChatPane key={s.id} agent={agent} msgs={s.messages} onMsgs={(f) => setSessionMsgs(s.id, f)} ctx={ctx}
                        onExecute={(c) => executeAgentCall(c, s.agent_id, { type: 'session', id: s.id })}
                        examples={CHAT_EXAMPLES} head={head} permHint="可以到「设置 / Agent / 工具与权限」里打开"
                        placeholderNote={!found ? '这个 Agent 已删除，只能回看' : agent.enabled ? undefined : '这个 Agent 已停用，只能回看'} />
                    )
                  },
                  onFetchAttachment: (mid, aid) => fetchAttachment(mid, aid), onAddAttachment: addAttachmentToProject,
                  onOpenMaterial: (mid) => openMaterial(pj.id, mid), imOn: has('messages'),
                  focusMaterial: matFocus,
                }} />
            )
          })()}
          {page === 'terminal' && (
            <TerminalPage tabs={termTabs} active={termActive || termTabs[0]?.id} onTabs={setTermTabs} onActive={setTermActive}
              projects={projects} onStartProto={startProto} onStopProto={stopProto} />
          )}
          {/* 浏览器一直挂着，切走只是藏起来：标签页和已加载的页面都留着；藏起来时不给它顶栏位置，免得标题叠在别的页面上 */}
          {has('browser') && (
            <div className="browser-host" hidden={page !== 'browser'}>
              <TopbarContext.Provider value={page === 'browser' ? topSlot : null}>
                <BrowserPage openRequest={browserReq} onStartProto={browserStartProto} google={google} onGoogleLogin={browserLogin} onGoogleLogout={browserLogout}
                  prototypes={protoRefs} hidden={page !== 'browser'} />
              </TopbarContext.Provider>
            </div>
          )}
          {page === 'videos' && (videoView === 'all' || videoView === 'review' || videoView === 'single' || videoView.startsWith('sr:')) && (
            <VideosListPage view={videoView} videos={videos} artifacts={artifacts} series={series} projects={projects} onOpen={openVideo} onNew={newVideo} onView={setVideoView}
              tabs={videoTabs} onSeries={setSeries} onVideos={setVideos} />
          )}
          {page === 'videos' && videoView === 'calendar' && (
            <CalendarPage videos={videos} publishes={publishes} deals={deals} tabs={videoTabs} onMovePublish={movePublish} onMoveTarget={moveTarget}
              onOpenVideo={openVideo} onOpenPublish={openPublishOf} onOpenDeal={openDeal} />
          )}
          {page === 'videos' && videoView === 'topics' && (
            <TopicsPage topics={topics} clips={clips} series={series} videos={videos} focus={topicFocus} onTopics={setTopics} onClips={setClips}
              onMakeVideo={makeVideoFromTopic} onOpenVideo={openVideo} tabs={videoTabs} />
          )}
          {page === 'videos' && videoView === 'clips' && (
            <ClipsPage clips={clips} topics={topics} onClips={setClips} onTopics={setTopics} tabs={videoTabs}
              onOpenTopic={(id) => { setTopicFocus((r) => ({ id, n: (r?.n ?? 0) + 1 })); setVideoView('topics') }} />
          )}
          {page === 'videos' && videoView === 'series' && (
            <SeriesPage series={series} videos={videos} onSeries={setSeries} onOpenSeries={(id) => setVideoView(`sr:${id}`)} tabs={videoTabs} />
          )}
          {page === 'videos' && videoView === 'publish' && (
            <PublishPage publishes={publishes} videos={videos} artifacts={artifacts} videoId={publishFilter} onPublishes={setPublishes}
              onArtifacts={setArtifacts}
              channels={Object.fromEntries(PLATFORMS.map((pl) => [pl.key, channelOf(pl.key)])) as Record<(typeof PLATFORMS)[number]['key'], ChannelState>}
              onConnect={(k) => {
                const c = connectors.find((x) => x.tool === PLATFORM_TOOL[k])
                setPage('settings'); setSection('connectors'); setConnCat('media')
                setDrawer(c ? { kind: 'connector', id: c.id } : { kind: 'new-connector', tool: PLATFORM_TOOL[k] })
              }}
              onOpenVideo={openVideo} onOpenUrl={openInBrowser} onClearFilter={() => setPublishFilter(undefined)} tabs={videoTabs} />
          )}
          {page === 'videos' && videoView.startsWith('video:') && (() => {
            const v = videos.find((x) => x.id === videoView.slice(6))
            if (!v) return <div className="page"><PageTitle>视频</PageTitle><div className="empty"><div className="empty-title">这个视频已经删除</div></div></div>
            return (
              <VideoDetail key={v.id} video={v} artifacts={artifacts} series={series} projects={projects} tabs={videoTabs}
                topics={topics} clips={clips} onTopics={setTopics} onClips={setClips} texts={videoTexts} onTexts={setVideoTexts}
                publishCount={publishes.filter((x) => x.video_id === v.id).length}
                onChange={(nv) => setVideos((xs) => xs.map((x) => (x.id === nv.id ? nv : x)))}
                onArtifacts={setArtifacts}
                onOpenSeries={(sid) => setVideoView(`sr:${sid}`)}
                onOpenPublish={(id) => { setPublishFilter(id); setVideoView('publish') }}
                onPreview={openInBrowser}
                onDelete={() => {
                  setVideos((xs) => xs.filter((x) => x.id !== v.id)); setPublishes((xs) => xs.filter((x) => x.video_id !== v.id))
                  // 系列里「需要按新模板重做」的名单也摘掉它
                  setSeries((xs) => xs.map((s) => (s.stale.includes(v.id) ? { ...s, stale: s.stale.filter((x) => x !== v.id) } : s)))
                  setVideoView('all')
                }} />
            )
          })()}
          {page === 'markets' && <MarketsPage watchlists={watchlists} onWatchlists={setWatchlists} focus={chartFocus} onNewAlert={newAlertFor} onTrade={tradeFor} />}
          {page === 'monitor' && (
            <MonitorPage alerts={alerts} events={alertEvents} watchlists={watchlists} onAlerts={setAlerts} onEvents={setAlertEvents} onOpenChart={openChart} newRequest={alertReq}
              imConnectors={connectors.filter((c) => TOOLS.find((t) => t.key === c.tool)?.category === 'im').map((c) => ({ id: c.id, name: c.name, status: c.status }))} />
          )}
          {page === 'etf' && <EtfPage />}
          {page === 'trading' && (
            <TradingPage view={tradingView} accounts={accounts} positions={positions} orders={orders} runs={tradeRuns} risk={risk} strategies={strategies}
              onAccounts={setAccounts} onPositions={setPositions} onOrders={setOrders} onRuns={setTradeRuns} onRisk={setRisk}
              accountDeleteBlock={accountBlock} onDeleteAccount={deleteAccount}
              orderRequest={orderReq} deployRequest={deployReq} onView={setTradingView} onOpenChart={openChart} onOpenStrategy={(id) => { setPage('strategy'); setStrategyView(`st:${id}`) }} onReport={tradeReport} />
          )}
          {page === 'strategy' && strategyView === 'list' && <StrategyListPage strategies={strategies} backtests={backtests} onOpen={(id) => setStrategyView(`st:${id}`)} onNew={newStrategy} />}
          {page === 'strategy' && strategyView === 'runs' && (
            <StrategyRunsPage runs={tradeRuns} strategies={strategies} accounts={accounts} onOpenStrategy={(id) => setStrategyView(`st:${id}`)}
              onManage={() => { setTradingView('runs'); setPage('trading') }} />
          )}
          {page === 'strategy' && strategyView === 'backtests' && <BacktestsPage backtests={backtests} strategies={strategies} onOpen={(id) => setStrategyView(`bt:${id}`)} />}
          {page === 'strategy' && strategyView.startsWith('st:') && (() => {
            const st = strategies.find((x) => x.id === strategyView.slice(3))
            if (!st) return <div className="page"><PageTitle>策略</PageTitle><div className="empty"><div className="empty-title">这个策略已经删除</div></div></div>
            return (
              <StrategyEditor key={st.id} strategy={st} lastBacktest={backtests.find((b) => b.config.strategy_id === st.id)}
                onChange={(ns) => setStrategies((xs) => xs.map((x) => (x.id === ns.id ? ns : x)))}
                delImpact={strategyPlan(st.id).impact}
                onDelete={() => deleteStrategy(st)}
                onBacktest={(cfg) => startBacktest(st, cfg)} onDeploy={deployStrategy} onOpenBacktest={(id) => setStrategyView(`bt:${id}`)}
                runs={tradeRuns} accounts={accounts} onOpenRuns={() => setStrategyView('runs')} />
            )
          })()}
          {page === 'strategy' && strategyView.startsWith('bt:') && (() => {
            const b = backtests.find((x) => x.id === strategyView.slice(3))
            if (!b) return <div className="page"><PageTitle>回测</PageTitle><div className="empty"><div className="empty-title">这条回测记录不在了</div></div></div>
            return (
              <BacktestReport key={b.id} backtest={b} onDeploy={deployStrategy} onOpenStrategy={(id) => setStrategyView(`st:${id}`)}
                onRerun={(cfg) => { const st = strategies.find((x) => x.id === b.config.strategy_id) ?? b.strategy_snapshot; setStrategyView(`bt:${startBacktest(st, cfg)}`) }}
                onDelete={() => { setBacktests((xs) => xs.filter((x) => x.id !== b.id)); setStrategyView('backtests') }} />
            )
          })()}
          {page === 'sessions' && sessionView === 'chats' && (
            <ChatsView agents={agents} sessions={sessions} current={currentSession} ctx={ctx} pickRequest={pickAgent} firstMessage={firstMessage}
              projects={projects} initialProject={sessionProject} tools={sessionTools}
              onOpenSource={(id) => { setPage('messages'); openMessage(id) }}
              onOpen={setCurrentSession} onNew={(id) => newSession(id)}
              onMsgs={setSessionMsgs}
              onRename={(id, title) => setSessions((xs) => xs.map((x) => (x.id === id ? { ...x, title } : x)))}
              onDelete={(id) => { setSessions((xs) => xs.filter((x) => x.id !== id)); setCurrentSession(sessions.find((x) => x.id !== id)?.id ?? null) }}
              onExecute={(sid, c) => executeAgentCall(c, sessions.find((x) => x.id === sid)?.agent_id ?? '', { type: 'session', id: sid })}
              onOpenAgent={(id) => { go('settings'); setSection('agents'); setAgentView(id) }}
              onOpenRuns={() => setSessionView('runs')} onOpenOutputs={() => setSessionView('outputs')} runsWaiting={agentWaiting} />
          )}
          {page === 'sessions' && sessionView === 'runs' && <RunsView agents={agents} runs={agentRuns} onSettle={settleAgentRun} focus={runFocus} onFocused={() => setRunFocus(null)} onBack={() => setSessionView('chats')} />}
          {page === 'sessions' && sessionView === 'outputs' && <OutputsView agents={agents} outputs={outputs} sessions={sessions} runs={agentRuns} onOpenTarget={openOutputTarget} onOpenOrigin={openOutputOrigin} onBack={() => setSessionView('chats')} />}
          {page === 'settings' && section === 'agents' && (agentView === 'list' ? (
            <AgentsPage agents={agents} models={modelChoices} onOpen={setAgentView} onNew={() => setAgentView('new')}
              scenarios={agentScenarios} onScenario={(key, id) => setAgentScenarios((xs) => xs.map((x) => (x.key === key ? { ...x, agent_id: id } : x)))}
              onToggle={(id, on) => setAgents((xs) => xs.map((a) => (a.id === id ? { ...a, enabled: on } : a)))} />
          ) : (() => {
            const existing = agents.find((a) => a.id === agentView)
            return (
              <AgentEditor key={agentView} models={modelChoices} conns={mountableConns} kbs={kbs} skills={skills} agent={existing ?? { ...newAgent(), model: modelChoices.find((x) => x.ok)?.key ?? newAgent().model }} creating={!existing}
                ctx={ctx} guard={agentGuard} onCreateKb={(kb) => setKbs((xs) => [...xs, kb])} onGoConnectors={() => { setSection('connectors'); setAgentView('list') }}
                onBack={() => setAgentView('list')}
                onSave={(a) => { setAgents((xs) => (xs.some((x) => x.id === a.id) ? xs.map((x) => (x.id === a.id ? a : x)) : [...xs, a])); setAgentView(a.id) }}
                delPlan={existing ? agentPlan(existing.id) : undefined}
                onDelete={() => { if (existing && !agentPlan(existing.id).block) deleteAgent(existing.id) }}
                onExecute={(c) => executeAgentCall(c, agentView, null)} />
            )
          })())}
          {page === 'settings' && section === 'providers' && (
            <ProvidersPage providers={providers} models={models} selected={drawer?.kind === 'provider' ? drawer.id : null}
              onOpen={(id) => setDrawer({ kind: 'provider', id })} onAdd={(k) => setDrawer({ kind: 'new-provider', provider: k })} />
          )}
          {page === 'settings' && section === 'workspace' && (
            <WorkspacesPage list={benches} current={bench.id} onSwitch={switchBench}
              onChange={(w) => setBenches((xs) => xs.map((x) => (x.id === w.id ? w : x)))}
              onCreate={(w) => setBenches((xs) => [...xs, w])}
              onDelete={(id) => { const rest = benches.filter((x) => x.id !== id); setBenches(rest); if (id === bench.id) switchBench(rest[0].id) }} />
          )}
          {page === 'settings' && section === 'kbs' && (
            <KnowledgePage kbs={kbs} agents={agents} content={content} providers={providers} onOpenAgent={(id) => { setSection('agents'); setAgentView(id) }} selected={drawer?.kind === 'kb' ? drawer.id : null} onOpen={(id) => setDrawer({ kind: 'kb', id })} onNew={() => setDrawer({ kind: 'new-kb' })} />
          )}
          {page === 'settings' && section === 'skills' && (
            <SkillsPage skills={skills} agents={agents} selected={drawer?.kind === 'skill' ? drawer.id : null} onOpen={(id) => setDrawer({ kind: 'skill', id })} onNew={() => setDrawer({ kind: 'new-skill' })} />
          )}
          {page === 'settings' && section === 'incidents' && (
            <IncidentsPage incidents={incidents} tasks={tasks} selected={drawer?.kind === 'incident' ? drawer.id : null} onOpen={(id) => setDrawer({ kind: 'incident', id })}
              sweep={(() => { const xs = schedules.filter((x) => x.action.kind === 'incident_sweep'); return xs.find((x) => x.enabled) ?? xs[0] })()}
              onEnableSweep={() => setSchedules((xs) => [sweepSchedule(newId('sc')), ...xs])}
              onOpenSweep={(id) => { setPage('tasks'); setTaskView('schedules'); setDrawer({ kind: 'schedule', id }) }} />
          )}
          {page === 'settings' && section === 'domains' && (
            <DomainsPage settings={domainSettings} routes={domainRoutes} protos={protoRefs} onSettings={setDomainSettings} onRoutes={setDomainRoutes} onOpenUrl={openInBrowser} />
          )}
          {page === 'settings' && section === 'sop' && <SopSettingsPage value={sopConcurrency} runs={runs} onSave={setSopConcurrency} gov={sopGov} onSaveGov={(p) => setSopGov((g) => ({ ...g, ...p }))} />}
          {page === 'settings' && section === 'worktrees' && <WorktreeSettingsPage />}
          {page === 'settings' && section === 'terminal' && <TerminalSettingsPage value={claudeCommand} onSave={setClaudeCommand} />}
          {page === 'settings' && section === 'appearance' && <AppearancePage theme={theme} onTheme={setTheme} collapsed={collapsed} onCollapsed={setCollapsed} />}
          {page === 'settings' && section === 'update' && <UpdatePage />}
          {page === 'settings' && section === 'run-prompts' && <RunPresetsPage />}
          {page === 'settings' && section === 'enums' && (
            <EnumsPage groups={enums} usage={enumUsage} onMigrate={migrateEnum}
              onSave={(g) => setEnums((xs) => (xs.some((x) => x.key === g.key) ? xs.map((x) => (x.key === g.key ? g : x)) : [...xs, g]))}
              onDeleteGroup={(k) => setEnums((xs) => xs.filter((x) => x.key !== k))} />
          )}
          {page === 'settings' && section === 'connectors' && (
            <ConnectorsSettings key={connCat} initialCat={connCat} connectors={connectors} messageCount={messageCount} onConnect={connectConn} onDisconnect={disconnectConn}
              imExpireDays={imExpireDays} onImExpireDays={setImExpireDays}
              onConfigure={(id) => setDrawer({ kind: 'connector', id })} onAdd={(tool) => setDrawer({ kind: 'new-connector', tool })} />
          )}
        </main>
        {/* 项目的终端和浏览器：一直挂着，只在打开的是这个项目、并且展开时显示；切走、收起后网页和终端都留着 */}
        {Object.entries(docks).map(([pid, d]) => {
          const pj = projects.find((x) => x.id === pid)
          if (!pj || (!d.term.length && !d.br)) return null
          return (
            <ProjectDock key={pid} project={pj} projects={projects} state={d} hidden={!(d.open && page === 'projects' && projectId === pid)}
              prototypes={protoRefs.filter((x) => x.projectId === pid)} google={google}
              onState={(f) => patchDock(pid, f)} onShow={(v) => showDock(pid, v)} onCollapse={() => patchDock(pid, (x) => ({ ...x, open: false }))}
              onCloseAll={() => closeDock(pid)} onStartProto={browserStartProto} onStopProto={stopProto}
              onGoogleLogin={browserLogin} onGoogleLogout={browserLogout} />
          )
        })}
      </div>
      {drawerEl}
      {palette && <CommandPalette items={buildPaletteItems} onClose={() => setPalette(false)} />}
      {quickSession && (
        <QuickSession agents={agents} projects={projects} onClose={() => setQuickSession(false)}
          defaultAgent={[...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.agent_id}
          defaultProject={page === 'projects' && projectId !== ALL_PROJECTS ? projectId : undefined}
          onCreate={(agentId, pid, text) => { setQuickSession(false); newSession(agentId, pid, text || undefined) }} />
      )}
      {imToMat && (() => {
        // 转项目资料（SPEC-messages-6）：项目默认取消息归到的项目（含群组默认），再看哪个项目的沟通里有它
        const ms = messages.filter((m) => imToMat.includes(m.id)).sort((a, b) => a.at.localeCompare(b.at))
        if (!ms.length) return null
        const last = ms[ms.length - 1]
        const who = (m: Message) => contactFor(m, contacts)?.name ?? m.sender_name
        const pid = [...ms].reverse().find((m) => m.project_id)?.project_id ?? projects.find((x) => ms.some((m) => projectMessages(x, [m], contacts).length > 0))?.id
        return (
          <ToMaterialDialog messages={ms} thread={threadForMany(ms, messages)} projects={projects} defaultProject={pid ?? undefined} who={who}
            chLabel={IM_CHANNELS.find((c) => c.key === last.channel)?.label ?? last.channel}
            onCancel={() => setImToMat(null)} onOpen={openMaterial}
            onSave={(projectId, title, body, withAtts, markDone, extraIds) => saveImMaterial(imToMat, projectId, title, body, withAtts, markDone, extraIds)} />
        )
      })()}
      {imStart && (() => {
        // 发起会话、拆分任务（SPEC-messages-5）：建一个挂 Agent 的会话，来源指回这组消息，项目按消息归属，打开后自动发出第一句话
        const ms = messages.filter((m) => imStart.ids.includes(m.id)).sort((a, b) => a.at.localeCompare(b.at))
        if (!ms.length) return null
        const last = ms[ms.length - 1]
        const who = (m: Message) => contactFor(m, contacts)?.name ?? m.sender_name
        const pj = projects.find((x) => ms.some((m) => projectMessages(x, [m], contacts).length > 0))
        return (
          <StartSessionDialog messages={ms} intent={imStart.intent} agents={agents} who={who} chLabel={IM_CHANNELS.find((c) => c.key === last.channel)?.label ?? last.channel}
            project={pj?.name} workdir={pj?.root} onCancel={() => setImStart(null)}
            onStart={(agentId, intent, prompt) => {
              setImStart(null)
              const gist = `${who(last)}「${last.text.slice(0, 16)}」`
              newSession(agentId, pj?.id, prompt, { kind: 'im_message', message_ids: ms.map((m) => m.id), label: `${IM_CHANNELS.find((c) => c.key === last.channel)?.label ?? ''} 消息：${gist}${ms.length > 1 ? ` 等 ${ms.length} 条` : ''}`, intent },
                intent === 'split' ? `拆分任务：${gist}` : `IM 消息：${gist}`)
            }} />
        )
      })()}
      <ReminderPopups items={reminderPops}
        onOpenTask={(id) => { if (tasks.some((t) => t.id === id)) { setPage('tasks'); setDrawer({ kind: 'task', id }) } }}
        onDismiss={(id) => setReminderPops((xs) => (id === 'toasts' ? xs.filter((x) => x.popup === 'modal') : xs.filter((x) => x.id !== id)))} />
    </div>
    </FrameAllowContext.Provider>
    </ProtoDomainContext.Provider>
    </OpenUrlContext.Provider>
    </TopbarContext.Provider>
    </EnumContext.Provider>
  )
}
