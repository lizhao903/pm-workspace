// 启用的插件 id，顺序就是插件在侧边栏里的顺序。
// 后端 GET /api/plugins 里没有记录的插件才看这里（CORE-04b 起以后端为准）：后端还没编译进插件时，示例插件 hello 靠它加载
export const enabledPlugins: readonly string[] = ['hello']
