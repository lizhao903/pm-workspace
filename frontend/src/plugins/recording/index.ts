// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音转写插件 recording（M1）：清单在后端 internal/plugins/recording/plugin.json，这里只有入口。
// 注册一级模块「录音」、设置分节「录音转写」、命令面板的「开始录音」，以及外壳状态条（录音常驻，
// 切页面也能看到计时和停止）；录音引擎在 ./recorder，停用插件时停掉正在录的并保存。
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import { disposeRecorder, startRecording } from './recorder'

// 状态条只在录音时才有内容，按需加载；入口本身保持轻量（节点环境下也能加载插件清单）
const RecorderStatus = lazy(() => import('./RecorderStatus'))

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
    // 任意页面都能看到的录音状态：录着的时候显示计时、暂停/停止，不用回录音页
    api.shellStatus.register({
      key: 'recorder',
      order: 10,
      render: RecorderStatus,
    })
    api.commands.register({
      id: 'recording.start',
      group: '操作',
      title: '开始录音',
      sub: '打开录音页并直接开始录（按上次选的录音来源）',
      keywords: 'recording 录音 转写 麦克风 系统声音',
      run: ({ shell }) => {
        shell.navigate('/recording')
        void startRecording()
      },
    })
  },
  deactivate() {
    // 停用插件时正在录：先停下并保存，别把音频丢了
    disposeRecorder()
  },
})
