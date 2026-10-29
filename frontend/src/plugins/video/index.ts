// 视频创作插件（VID-01a 起）：清单在后端 internal/plugins/video/plugin.json，这里只有入口。
// 模块 key 是 videos，同工作台目录（core/shell/workspace.ts）；页面先是空的，视频列表和详情是 VID-01c，发布页是 VID-01d
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'videos',
      label: '视频',
      path: 'videos',
      load: () => import('./Page'),
    })
  },
})
