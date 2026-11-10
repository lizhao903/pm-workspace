// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音转写插件 recording（M1）：清单在后端 internal/plugins/recording/plugin.json，这里只有入口。
// 注册一级模块「录音」、设置分节「录音转写」和命令面板的「开始录音」（跳到 /recording 直接开录）。
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'recording',
      label: '录音',
      path: 'recording',
      load: () => import('./Page'),
    })
    api.settings.register({
      key: 'recording',
      label: '录音转写',
      desc: '本机 whisper.cpp 转写设置',
      page: lazy(() => import('./SettingsPage')),
    })
    api.commands.register({
      id: 'recording.start',
      group: '操作',
      title: '开始录音',
      sub: '打开录音页，直接用麦克风录一段',
      keywords: 'recording 录音 转写 麦克风',
      run: ({ shell }) => shell.navigate('/recording'),
    })
  },
})
