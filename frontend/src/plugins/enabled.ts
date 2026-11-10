// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 启用的插件 id，顺序就是插件在侧边栏里的顺序。
// 后端 GET /api/plugins 里没有记录的插件才看这里（CORE-04b 起以后端为准）：后端还没编译进插件时，示例插件 hello 靠它加载。
// 示例插件只在开发模式（npm run dev、测试）出现，生产构建的侧栏里没有它
export const enabledPlugins: readonly string[] = import.meta.env.DEV ? ['hello'] : []
