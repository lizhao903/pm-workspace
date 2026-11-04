// 项目档案标签（AUTO-04，SPEC-projects-15）的纯逻辑：表单、拆关键词、算要存的改动。
import { PROFILE_COMMANDS, type ProfileCommand, type ProfileCommandKey, type ProjectProfile, type ProjectProfilePatch } from '../../core/data'

/** 平台标签的常用项，点一下加上；别的平台在「其他」里手填 */
export const PLATFORM_PRESETS = ['web', 'H5', '桌面', '云端', '移动端', '小程序'] as const

/** 三个目录在表单和接口里的字段名 */
export const DIR_FIELDS = [
  { key: 'code_dir', label: '代码库目录', hint: '研发 pipeline 在这里改代码、跑命令；不填时沿用项目目录' },
  { key: 'proto_dir', label: '原型库目录', hint: '产品 Agent 写原型、发布后回写原型的地方' },
  { key: 'prd_dir', label: 'PRD 目录', hint: '产品 Agent 写 PRD 的地方' },
] as const
export type DirField = (typeof DIR_FIELDS)[number]['key']

/** 一条命令在表单里：超时是输入框里的原文；ready 只有起测试环境用（就绪检查） */
export type CommandDraft = { command: string; dir: string; timeout: string; ready: string }

export type ProfileForm = {
  intro: string
  /** 关键词输入框原文，逗号、顿号、换行分隔 */
  keywords: string
  platforms: string[]
  /** 不在常用项里的平台，输入框原文 */
  otherPlatforms: string
  code_dir: string
  proto_dir: string
  prd_dir: string
  commands: Record<ProfileCommandKey, CommandDraft>
  owner_ids: string[]
  acceptor_ids: string[]
}

const isPreset = (x: string) => PLATFORM_PRESETS.some((p) => p.toLowerCase() === x.toLowerCase())

/** 按逗号（全角半角）、顿号、换行拆开，去空、去重（不分大小写，留第一次的写法） */
export function splitTags(s: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of s.split(/[,，、\n]/)) {
    const x = raw.trim()
    if (!x || seen.has(x.toLowerCase())) continue
    seen.add(x.toLowerCase())
    out.push(x)
  }
  return out
}

export function formOfProfile(p: ProjectProfile): ProfileForm {
  const commands = {} as Record<ProfileCommandKey, CommandDraft>
  for (const { key } of PROFILE_COMMANDS) {
    const c = p.commands[key]
    commands[key] = { command: c?.command ?? '', dir: c?.dir ?? '', timeout: c?.timeout_sec ? String(c.timeout_sec) : '', ready: c?.ready ?? '' }
  }
  return {
    intro: p.intro,
    keywords: p.keywords.join('，'),
    platforms: p.platforms.filter(isPreset),
    otherPlatforms: p.platforms.filter((x) => !isPreset(x)).join('，'),
    code_dir: p.code_dir, proto_dir: p.proto_dir, prd_dir: p.prd_dir,
    commands,
    owner_ids: p.owner_ids, acceptor_ids: p.acceptor_ids,
  }
}

/** 超时输入框原文 → 秒；空、不是非负整数时当 0（用默认值） */
export function timeoutOf(s: string): number {
  const t = s.trim()
  return /^\d+$/.test(t) ? Number(t) : 0
}

/** 就绪检查原文有没有毛病：空没毛病；要 / 开头，或本机的 http 地址（后端也挡） */
export function readyError(s: string): string {
  const t = s.trim()
  if (!t) return ''
  if (/\s/.test(t)) return '就绪检查里不能有空格'
  if (t.startsWith('/')) return ''
  const m = /^https?:\/\/(\[::1\]|127\.0\.0\.1|localhost)(:|\/|$)/i.exec(t)
  return m ? '' : '就绪检查填 / 开头的路径，或本机地址（http://127.0.0.1:{{PORT}}/…）'
}

/** 超时原文有没有毛病：空没毛病，非整数或超过一天有 */
export function timeoutError(s: string): string {
  const t = s.trim()
  if (!t) return ''
  if (!/^\d+$/.test(t)) return '超时填整数秒'
  return Number(t) > 86400 ? '超时最多一天（86400 秒）' : ''
}

/** 表单里的命令 → 接口的 commands：空命令不发（等于清掉） */
export function commandsOf(f: ProfileForm): Partial<Record<ProfileCommandKey, ProfileCommand>> {
  const out: Partial<Record<ProfileCommandKey, ProfileCommand>> = {}
  for (const { key } of PROFILE_COMMANDS) {
    const c = f.commands[key]
    if (!c.command.trim()) continue
    out[key] = { command: c.command.trim(), dir: c.dir.trim(), timeout_sec: timeoutOf(c.timeout) }
    // 就绪检查只有起测试环境有，空的不发（等于没设）
    if (key === 'test_env' && c.ready.trim()) out[key].ready = c.ready.trim()
  }
  return out
}

export const platformsOf = (f: ProfileForm) => splitTags([...f.platforms, ...splitTags(f.otherPlatforms)].join('\n'))

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 两份表单之间要存的改动，分两份：目录一个一个单独存（目录不存在时只那一项存不上，不连累别的），其余合成一次。
 * 超时有毛病的命令先不存命令（等改好）
 */
export function profileDiff(f: ProfileForm, saved: ProfileForm): { patch: ProjectProfilePatch; dirs: Partial<Record<DirField, string>> } {
  const patch: ProjectProfilePatch = {}
  if (f.intro.trim() !== saved.intro.trim()) patch.intro = f.intro.trim()
  if (!same(splitTags(f.keywords), splitTags(saved.keywords))) patch.keywords = splitTags(f.keywords)
  if (!same(platformsOf(f), platformsOf(saved))) patch.platforms = platformsOf(f)
  const bad = PROFILE_COMMANDS.some(({ key }) => timeoutError(f.commands[key].timeout)) || !!readyError(f.commands.test_env.ready)
  if (!bad && !same(commandsOf(f), commandsOf(saved))) patch.commands = commandsOf(f)
  if (!same(f.owner_ids, saved.owner_ids)) patch.owner_ids = f.owner_ids
  if (!same(f.acceptor_ids, saved.acceptor_ids)) patch.acceptor_ids = f.acceptor_ids
  const dirs: Partial<Record<DirField, string>> = {}
  for (const { key } of DIR_FIELDS) if (f[key].trim() !== saved[key].trim()) dirs[key] = f[key].trim()
  return { patch, dirs }
}

/** 档案填了多少：概览、标签上提示用 */
export function profileGaps(p: Pick<ProjectProfile, 'intro' | 'keywords' | 'code_dir' | 'proto_dir' | 'prd_dir' | 'root'>): string[] {
  const out: string[] = []
  if (!p.intro.trim()) out.push('简介')
  if (!p.keywords.length) out.push('关键词')
  if (!p.code_dir && !p.root) out.push('代码库目录')
  if (!p.proto_dir) out.push('原型库目录')
  if (!p.prd_dir) out.push('PRD 目录')
  return out
}
