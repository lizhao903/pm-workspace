// 视频创作插件（VID-01a 起）：清单在后端 internal/plugins/video/plugin.json，这里只有入口。
// 模块 key 是 videos，同工作台目录（core/shell/workspace.ts）；视频列表和详情的制作流程、设置是 VID-01c，产出物和系列页是 VID-01d。
// 另登记两个 SOP 节点的展示（名字、颜色、配置项），不登记时流程图上只能显示 kind；商单（VID-08d）登记项目标签和今日卡片；VID-07b 登记视频的三张今日卡片
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import { DealsTabBadge } from './DealBadge'
import { DealDueCard, type DealDueItem } from './DealDueCard'
import { STAGES } from './model'
import { FailedCard, ScheduledCard, WaitingCard } from './TodayCards'
import type { TodayPublish, TodayWaiting } from './todayModel'

// SOP 节点的配置里阶段、检查点存阶段 key（后端 sopnodes.go）
const stageOpts = (checkpoint: boolean) => STAGES.filter((s) => s.checkpoint === checkpoint).map((s) => ({ value: s.key, label: s.label }))

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'videos',
      label: '视频',
      path: 'videos',
      load: () => import('./Page'),
    })
    // 商单（VID-08d）：项目详情的「商单」标签，在「任务」后面；账期快到的进今日卡片 video_deal_due
    api.projectTabs.register({ key: 'deals', label: '商单', after: 'tasks', page: lazy(() => import('./DealsTab')), badge: DealsTabBadge })
    // 今日卡片（VID-07b）：待验收、24 小时内定时、发布失败，数据和顺序同后端 today.go
    api.todayCards.register<{ total: number; items: TodayWaiting[] }>({ key: 'video_waiting', title: '视频待验收', order: 60, render: WaitingCard })
    api.todayCards.register<{ total: number; items: TodayPublish[] }>({ key: 'video_scheduled', title: '视频待发布', order: 61, render: ScheduledCard })
    api.todayCards.register<{ total: number; items: TodayPublish[] }>({ key: 'video_failed', title: '视频发布失败', order: 62, render: FailedCard })
    api.todayCards.register<{ total: number; items: DealDueItem[] }>({ key: 'video_deal_due', title: '商单账期', order: 63, render: DealDueCard })
    // SOP 节点的展示（PR-14）；节点本身、必填项在后端登记（VID-03d），没装 SOP 插件时没人读
    api.sopNodes.register({
      kind: 'video_run_stage', label: '跑视频阶段', group: '视频', color: '#c2255c', desc: '用视频里这一阶段配的执行器跑一遍，跑完再往下走',
      fields: [
        { key: 'video', label: '视频', type: 'text', required: true, hint: '视频 id，支持 {{字段}}' },
        { key: 'stage', label: '阶段', type: 'select', required: true, options: () => stageOpts(false) },
      ],
    })
    api.sopNodes.register({
      kind: 'video_wait_checkpoint', label: '等视频检查点', group: '视频', color: '#b0570b', desc: '停下等人在视频页通过这个检查点',
      fields: [
        { key: 'video', label: '视频', type: 'text', required: true, hint: '视频 id，支持 {{字段}}' },
        { key: 'checkpoint', label: '检查点', type: 'select', required: true, options: () => stageOpts(true) },
      ],
    })
  },
})
