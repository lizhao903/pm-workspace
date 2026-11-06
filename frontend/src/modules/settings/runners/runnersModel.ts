// 设置「执行器」（TSK-0722）的纯函数：状态文字、检查项的标记、时间。
import type { RunnerSmoke, RunnerStatus, SmokeCheck } from '../../../core/data'

/** 可执行文件从哪来 */
export function binSourceText(st: RunnerStatus): string {
  if (st.bin_source === 'builtin') return '工作台自己，不起外部进程'
  if (st.bin_source === 'flag') return st.harness === 'deepseek' ? '启动参数 --dsh-bin 或环境变量 DSH_BIN 指定' : '启动时指定'
  return '按名字在 PATH 里找'
}

/** 卡片右上的状态：可用 / 不可用，可用但有提示的写「可用，有提示」 */
export function runnerState(st: RunnerStatus): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!st.available) return { text: '不可用', tone: 'bad' }
  if (st.problems.length) return { text: '可用，有提示', tone: 'warn' }
  return { text: '可用', tone: 'ok' }
}

/** 一项检查的标记文字，不用图标 */
export const CHECK_MARK: Record<SmokeCheck['status'], string> = {
  pass: '通过', fail: '失败', skip: '跳过', running: '进行中', pending: '等待',
}

/** 整次检查的一句话 */
export function smokeSummary(sm: RunnerSmoke): string {
  if (sm.status === 'running') {
    const done = sm.checks.filter((c) => c.status !== 'pending' && c.status !== 'running').length
    return `检查中：${done} / ${sm.checks.length} 项有结果`
  }
  const failed = sm.checks.filter((c) => c.status !== 'pass')
  if (!failed.length) return `全部 ${sm.checks.length} 项通过`
  return `${failed.length} 项没通过：${failed.map((c) => c.label).join('、')}`
}

/** 本地时间，到秒 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 用时：毫秒转「1.2 秒」/「1 分 5 秒」；不到 0.1 秒的不写（起进程这类只是 exec 一下） */
export function fmtMs(ms: number): string {
  if (ms < 100) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}
