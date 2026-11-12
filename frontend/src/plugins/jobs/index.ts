import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.settings.register({
      key: 'jobs', label: '后台任务', desc: '后台 Job 状态与最近一小时运行统计',
      page: lazy(() => import('./Section')),
    })
  },
})
