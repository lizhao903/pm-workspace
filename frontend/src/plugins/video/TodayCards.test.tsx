// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { FailedCard, ScheduledCard, WaitingCard } from './TodayCards'
import { scheduleText, type TodayPublish, type TodayWaiting } from './todayModel'

const T = '2026-10-29T08:00:00Z'
const waiting = (x: Partial<TodayWaiting> = {}): TodayWaiting => ({
  kind: 'checkpoint', video_id: 'vd_1', video_title: '第 2 集', stage: 'ch1', stage_label: '第一章检查', state: 'pending', label: '待第一章检查', at: T,
  link: '/videos/v/vd_1', ...x,
})
const pub = (x: Partial<TodayPublish> = {}): TodayPublish => ({
  id: 'vp_1', video_id: 'vd_1', video_title: '第 2 集', platform: 'youtube', platform_label: 'YouTube', variant: 'landscape', title: '发布标题',
  status: 'scheduled', scheduled_at: new Date(Date.now() + 3600_000).toISOString(), at: T, link: '/videos/v/vd_1?p=vp_1', ...x,
})

// 卡片放进路由里，点了看落到哪
function mount(el: React.ReactNode) {
  const router = createMemoryRouter([
    { path: '/', element: el },
    { path: '/videos/*', element: <div>到了视频页</div> },
  ])
  render(<RouterProvider router={router} />)
  return router
}

describe('视频今日卡片', () => {
  it('待验收：检查点和产出物都列出来，退回的带原因，点一条跳到 link', async () => {
    const r = mount(<WaitingCard data={{ total: 3, items: [
      waiting(),
      waiting({ video_id: 'vd_2', video_title: '第 3 集', state: 'rejected', label: '退回修改', note: '开头太慢', link: '/videos/v/vd_2' }),
      waiting({ kind: 'artifact', artifact_id: 'va_1', artifact_name: '口播稿', version: 2, label: '脚本待验收', link: '/videos/v/vd_1/artifacts?a=va_1' }),
    ] }} />)
    expect(screen.getByText('共 3 条')).toBeTruthy()
    expect(screen.getByText('待第一章检查')).toBeTruthy()
    expect(screen.getByText('开头太慢')).toBeTruthy()
    expect(screen.getByText('口播稿 v2')).toBeTruthy()
    await userEvent.click(screen.getByText('口播稿 v2'))
    expect(r.state.location.pathname).toBe('/videos/v/vd_1/artifacts')
    expect(r.state.location.search).toBe('?a=va_1')
  })

  it('待发布：平台和横竖屏，定时时刻；点了带上发布 id 去视频详情', async () => {
    const r = mount(<ScheduledCard data={{ total: 1, items: [pub()] }} />)
    expect(screen.getByText('YouTube · 横屏')).toBeTruthy()
    await userEvent.click(screen.getByText('第 2 集'))
    expect(r.state.location.pathname).toBe('/videos/v/vd_1')
    expect(r.state.location.search).toBe('?p=vp_1')
  })

  it('发布失败：副标题是平台和失败原因', () => {
    mount(<FailedCard data={{ total: 1, items: [pub({ status: 'failed', variant: '', platform_label: '抖音', error: '封面比例不对' })] }} />)
    expect(screen.getByText('抖音：封面比例不对')).toBeTruthy()
  })

  it('没有数据时什么都不画', () => {
    const { container } = render(<WaitingCard data={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('定时时刻：今天写时分，明天写「明天」，过点写「已过点」', () => {
    const now = new Date(2026, 9, 29, 10, 0)
    expect(scheduleText(new Date(2026, 9, 29, 20, 0).toISOString(), now)).toEqual({ text: '20:00', late: false })
    expect(scheduleText(new Date(2026, 9, 30, 8, 5).toISOString(), now)).toEqual({ text: '明天 08:05', late: false })
    expect(scheduleText(new Date(2026, 9, 29, 9, 0).toISOString(), now)).toEqual({ text: '已过点', late: true })
    expect(scheduleText(null, now).text).toBe('未定时')
  })
})
