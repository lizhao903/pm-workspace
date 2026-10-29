// 视频创作插件（VID-01a 起）：清单在后端 internal/plugins/video/plugin.json，这里只有入口。
// 模块 key 是 videos，同工作台目录（core/shell/workspace.ts）；视频列表和详情的制作流程、设置是 VID-01c，产出物和系列页是 VID-01d。
// 另登记两个 SOP 节点的展示（名字、颜色、配置项），不登记时流程图上只能显示 kind
import { definePlugin } from '../../core/plugin'
import { STAGES } from './model'

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
