// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// B 站组件（TSK-0455）的纯函数：账户数据的指标、趋势、退避和时间的文案。页面见 BiliPage.tsx，照原型 web-next/src/videobili.tsx
import type { BiliAccount, BiliGuard, BiliSnapshot, BiliTrend, BiliTrendMetric } from '../../core/data'

export type BiliStatKey = 'followers' | 'total_click' | 'total_like' | 'total_coin' | 'total_fav' | 'total_elec' | 'total_reply' | 'total_dm' | 'total_share'
  | 'following' | 'archives'

/** 概览的数字卡，按这个顺序；incr 是同一张卡上显示的昨日新增 */
export const BILI_STATS: { key: BiliStatKey; label: string; incr?: 'incr_fans' | 'incr_click' }[] = [
  { key: 'followers', label: '粉丝', incr: 'incr_fans' },
  { key: 'total_click', label: '总播放', incr: 'incr_click' },
  { key: 'total_like', label: '获赞' },
  { key: 'total_coin', label: '投币' },
  { key: 'total_fav', label: '收藏' },
  { key: 'total_elec', label: '充电' },
  { key: 'total_reply', label: '评论' },
  { key: 'total_dm', label: '弹幕' },
  { key: 'total_share', label: '分享' },
  { key: 'following', label: '关注' },
  { key: 'archives', label: '过审稿件' },
]

/** 趋势能切的几项：创作中心的按天增量，加上本地快照攒出来的粉丝数 */
export type BiliCurveKey = BiliTrendMetric | 'followers'
export const BILI_CURVES: { key: BiliCurveKey; label: string; desc: string }[] = [
  { key: 'click', label: '播放', desc: '每天新增播放（创作中心近 30 天）' },
  { key: 'like', label: '点赞', desc: '每天新增点赞（创作中心近 30 天）' },
  { key: 'coin', label: '投币', desc: '每天新增投币（创作中心近 30 天）' },
  { key: 'fav', label: '收藏', desc: '每天新增收藏（创作中心近 30 天）' },
  { key: 'elec', label: '充电', desc: '每天新增充电（创作中心近 30 天）' },
  { key: 'followers', label: '粉丝', desc: '每天的粉丝总数（本地每天一次快照攒出来的）' },
]

export const LOGIN_LABEL: Record<BiliAccount['login'], { label: string; color: string }> = {
  logged_in: { label: '已登录', color: 'var(--ok)' },
  logged_out: { label: '未登录', color: 'var(--faint)' },
  expired: { label: '登录已失效', color: 'var(--warn)' },
}

export const biliNum = (n: number | undefined) => (n == null ? '-' : n >= 100000 ? `${+(n / 10000).toFixed(1)} 万` : n.toLocaleString('zh-CN'))

/** 一条曲线的点：按天升序，没有的天不补 */
export function curveOf(key: BiliCurveKey, trends: BiliTrend[], days: BiliSnapshot[]): { date: string; value: number }[] {
  if (key === 'followers') return days.filter((d) => d.followers != null).map((d) => ({ date: d.date, value: d.followers! }))
  return [...(trends.find((t) => t.metric === key)?.points ?? [])].sort((a, b) => a.date.localeCompare(b.date))
}

const two = (n: number) => String(n).padStart(2, '0')

/** MM-DD HH:mm，本地时间 */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 消息时间：今天的只写时分，别的天写月日加时分 */
export function msgTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return same ? `${two(d.getHours())}:${two(d.getMinutes())}` : shortTime(iso)
}

/** 退避说明：到什么时候、为什么；已经过了的回 null */
export function guardText(g: BiliGuard | undefined | null, now = Date.now()): string | null {
  if (!g || new Date(g.until).getTime() <= now) return null
  return `B 站请求暂停到 ${shortTime(g.until)}，期间不发任何请求，到点后自动恢复。原因：${g.reason}`
}

/** 私信输入框的剩余字数提示，超了回负数 */
export const leftChars = (text: string, max: number) => max - [...text].length
