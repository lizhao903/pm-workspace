// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内置浏览器的数据：标签页、Google 账号、Drive 假数据和地址工具函数

export type TabKind = 'web' | 'proto' | 'drive' | 'home'

export interface BrowserTab {
  id: string
  url: string
  title: string
  kind: TabKind
  history: string[]
  cursor: number
  loading?: boolean
  pinned?: boolean
}

export interface GoogleAccount {
  email: string
  name: string
  avatarColor: string
  scopes: string[]
  connected_at: string
}

export type DriveMime = 'doc' | 'sheet' | 'slide' | 'pdf' | 'folder' | 'image' | 'video'

export interface DriveFile {
  id: string
  name: string
  mime: DriveMime
  parent?: string
  owner: string
  modified_at: string
  size?: string
  shared: boolean
}

export const HOME_URL = 'about:home'
export const DRIVE_HOME = 'https://drive.google.com/drive/my-drive'
export const DRIVE_SHARED = 'https://drive.google.com/drive/shared-with-me'
export const DRIVE_RECENT = 'https://drive.google.com/drive/recent'

/** 申请的授权范围；key 是 Google 的 scope 短名 */
export const GOOGLE_SCOPES: { key: string; label: string; desc: string }[] = [
  { key: 'drive.readonly', label: '查看 Google Drive 文件', desc: '在内置浏览器里浏览、预览你的云端硬盘' },
  { key: 'drive.file', label: '管理本应用创建的文件', desc: '只能读写由「一人之下」创建或打开过的文件' },
  { key: 'calendar.events', label: '查看和编辑 Google 日历日程', desc: '把日程同步到工作台的日程页，也允许助手建日程' },
]

const daysAgo = (d: number, h = 10) => {
  const t = new Date()
  t.setDate(t.getDate() - d)
  t.setHours(h, 20, 0, 0)
  return t.toISOString()
}

export const seedDriveFiles: DriveFile[] = [
  { id: 'fd0PrdReqs7Qm', name: '产品需求', mime: 'folder', owner: '我', modified_at: daysAgo(1), shared: false },
  { id: 'fd0CompeteK2x', name: '竞品分析', mime: 'folder', owner: '我', modified_at: daysAgo(6), shared: true },
  { id: 'fd0WeeklyR9a', name: '周报', mime: 'folder', owner: '我', modified_at: daysAgo(2), shared: false },
  { id: 'fd0ReviewP4n', name: '评审材料', mime: 'folder', owner: '我', modified_at: daysAgo(3), shared: true },
  { id: 'fd0RecordZ1c', name: '录屏', mime: 'folder', owner: '我', modified_at: daysAgo(4), shared: false },

  { id: '1xQd8RmPrdV3TaskFlow', name: '任务流转 v3 需求文档', mime: 'doc', parent: 'fd0PrdReqs7Qm', owner: '我', modified_at: daysAgo(0, 9), size: '86 KB', shared: true },
  { id: '1kLm2NbPrdAgentHelper', name: 'AI 助手接入方案', mime: 'doc', parent: 'fd0PrdReqs7Qm', owner: '我', modified_at: daysAgo(1, 15), size: '42 KB', shared: false },
  { id: '1pRt5WsPrdMsgCenter', name: '消息中心改版 PRD', mime: 'pdf', parent: 'fd0PrdReqs7Qm', owner: '我', modified_at: daysAgo(9), size: '2.4 MB', shared: false },

  { id: '1cMp9AxCompeteTable', name: '竞品功能对比表 2026 Q4', mime: 'sheet', parent: 'fd0CompeteK2x', owner: '我', modified_at: daysAgo(2, 11), size: '128 KB', shared: true },
  { id: '1cMp3UiCompeteShots', name: '竞品首页截图', mime: 'image', parent: 'fd0CompeteK2x', owner: '陈若溪', modified_at: daysAgo(6), size: '1.8 MB', shared: true },

  { id: '1wKr4DzWeekly1027', name: '周报 10.21 - 10.27', mime: 'doc', parent: 'fd0WeeklyR9a', owner: '我', modified_at: daysAgo(1, 18), size: '18 KB', shared: false },
  { id: '1wKr7HqWeekly1020', name: '周报 10.14 - 10.20', mime: 'doc', parent: 'fd0WeeklyR9a', owner: '我', modified_at: daysAgo(8, 18), size: '21 KB', shared: false },
  { id: '1wKr2MtMetricsBoard', name: '核心指标周表', mime: 'sheet', parent: 'fd0WeeklyR9a', owner: '我', modified_at: daysAgo(1, 17), size: '64 KB', shared: true },

  { id: '1rVw6EjReviewDeck', name: '第四季度需求评审', mime: 'slide', parent: 'fd0ReviewP4n', owner: '我', modified_at: daysAgo(3, 14), size: '5.6 MB', shared: true },
  { id: '1rVw8FoReviewNotes', name: '评审会纪要 10.25', mime: 'doc', parent: 'fd0ReviewP4n', owner: '周屿', modified_at: daysAgo(3, 16), size: '12 KB', shared: true },

  { id: '1vDm5GiRecordDemo', name: '任务看板演示录屏.mp4', mime: 'video', parent: 'fd0RecordZ1c', owner: '我', modified_at: daysAgo(4), size: '186 MB', shared: false },

  { id: '1sHr3LaRoadmap2027', name: '2027 产品路线图', mime: 'slide', owner: '我', modified_at: daysAgo(5, 10), size: '3.1 MB', shared: false },
  { id: '1sHr9KbUserInterview', name: '用户访谈记录汇总', mime: 'doc', owner: '我', modified_at: daysAgo(12), size: '64 KB', shared: false },
  { id: '1oTh1PcDesignSpec', name: '设计规范 v2', mime: 'pdf', owner: '陈若溪', modified_at: daysAgo(7), size: '8.2 MB', shared: true },
  { id: '1oTh4QdOkrSheet', name: '团队 OKR 2026 H2', mime: 'sheet', owner: '林予安', modified_at: daysAgo(10), size: '36 KB', shared: true },
]

export function driveUrl(f: DriveFile): string {
  switch (f.mime) {
    case 'doc': return `https://docs.google.com/document/d/${f.id}`
    case 'sheet': return `https://docs.google.com/spreadsheets/d/${f.id}`
    case 'slide': return `https://docs.google.com/presentation/d/${f.id}`
    case 'folder': return `https://drive.google.com/drive/folders/${f.id}`
    default: return `https://drive.google.com/file/d/${f.id}`
  }
}

/** Drive 地址解析：文件夹 / 三个固定视图 / 单个文件 */
export type DriveRoute =
  | { view: 'my' | 'shared' | 'recent' }
  | { view: 'folder'; id: string }
  | { view: 'file'; id: string }

export function parseDrive(url: string): DriveRoute {
  const folder = url.match(/\/drive\/(?:u\/\d+\/)?folders\/([^/?#]+)/)
  if (folder) return { view: 'folder', id: folder[1] }
  const file = url.match(/\/d\/([^/?#]+)/)
  if (file) return { view: 'file', id: file[1] }
  if (/shared-with-me/.test(url)) return { view: 'shared' }
  if (/\/drive\/recent/.test(url)) return { view: 'recent' }
  return { view: 'my' }
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function classify(url: string): TabKind {
  if (!url || url === HOME_URL || url.startsWith('about:')) return 'home'
  const h = hostOf(url)
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]') return 'proto'
  if (h === 'drive.google.com' || h === 'docs.google.com') return 'drive'
  return 'web'
}

export function portOf(url: string): number | null {
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : 80
  } catch { return null }
}

/** 地址栏输入转成 url：有协议原样；本机地址补 http；像域名补 https；其它当搜索词 */
export function normalize(input: string): string {
  const s = input.trim()
  if (!s) return HOME_URL
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s
  if (/^:?\d{2,5}(\/.*)?$/.test(s)) return `http://127.0.0.1:${s.replace(/^:/, '')}`
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return `http://${s}`
  // 域名部分不能有空格；路径里可以有（地址栏显示的是解码后的地址）
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/** 地址栏显示：去掉协议前缀；新标签页显示空 */
export function displayUrl(url: string): string {
  if (classify(url) === 'home') return ''
  const s = url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/\/$/, '')
  try { return decodeURI(s) } catch { return s }
}

/** 同一个地址的判定：忽略协议后的尾斜杠和 localhost / 127.0.0.1 的差别 */
export function sameUrl(a: string, b: string): boolean {
  const k = (u: string) => u.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1')
  return k(a) === k(b)
}

export const AVATAR_COLORS = ['#3d4fd6', '#0c8599', '#e8590c', '#7048e8', '#2f7d43', '#c2255c']
export function avatarColorFor(email: string): string {
  const h = [...email].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7)
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
