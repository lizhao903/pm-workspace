// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 语音合成（tts）是后端插件：没有自己的功能模块和设置页，配置在 设置 → 连接器 → 内容平台 → 语音合成，
// 音频合成阶段由视频插件调它的 /api/tts/voices；这里只登记一个空入口，让插件清单能正常加载。
import { definePlugin } from '../../core/plugin'

export default definePlugin({
  activate() {
    // 不需要注册模块、设置分节或命令
  },
})
