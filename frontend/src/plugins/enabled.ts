// 启用的插件 id，顺序就是插件在侧边栏里的顺序。
// CORE-04b 之前的本地配置；之后改由 core/plugin/registry.ts 的 fetchPluginState 读 GET /api/plugins，这个文件删掉
export const enabledPlugins: readonly string[] = ['hello']
