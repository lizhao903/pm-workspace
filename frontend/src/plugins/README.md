# 插件目录

每个插件一个子目录 `src/plugins/<id>/`，目录名就是插件 id。插件只能依赖 `src/core/` 暴露的接口，插件之间互不 import。

加载方式（FE-00b）：

- 启用列表现在读 `enabled.ts`；CORE-04b 做完后改由 `core/plugin/registry.ts` 的 `fetchPluginState()` 读 `GET /api/plugins`，只改这一个函数。
- 每个插件的入口 `index.ts` 是独立代码块，只有启用的插件才会请求；页面再按路由懒加载。
- 依赖缺失、版本不符、清单不合法的插件不加载，外壳侧栏底部提示原因。
- 清单暂时放在 `src/plugins/<id>/plugin.json`；规范要求清单只有一份，放在后端 `internal/plugins/<id>/plugin.json`，后端有第一个插件时把 `discoverPlugins` 的 glob 改指过去。
- `hello` 是示例插件，只用来验证加载流程。
