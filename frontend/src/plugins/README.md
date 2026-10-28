# 插件目录

每个插件一个子目录 `src/plugins/<id>/`，目录名就是插件 id。插件只能依赖 `src/core/` 暴露的接口，插件之间互不 import。

加载方式（FE-00b）：

- 启用列表由 `core/plugin/registry.ts` 的 `fetchPluginState()` 读 `GET /api/plugins`（3 秒超时），按 `running` 决定加载哪些；后端没有记录的插件按 `enabled.ts` 接在后面。读取失败只显示内核模块，侧栏提示原因。
- 每个插件的入口 `index.ts` 是独立代码块，只有启用的插件才会请求；页面再按路由懒加载。
- 依赖缺失、版本不符、清单不合法的插件不加载，外壳侧栏底部提示原因。
- 清单只有一份：有后端的插件放在后端 `internal/plugins/<id>/plugin.json`（前端构建时用 glob 读进来），前端目录里只放入口和页面；只有前端的插件（示例 `hello`）清单放在 `src/plugins/<id>/plugin.json`。`discoverPlugins` 两处都读，目录名就是 id。
- 有后端记录的插件（`projects`）不要加进 `enabled.ts`，启停以 `GET /api/plugins` 为准。
- 插件取数、写数据只走 `core/data`（数据访问层），不 import `core/api`，lint 规则拦着；写完报 `Change` 由失效规则刷新，见 frontend/README「数据访问层」。
- `hello` 是示例插件，只用来验证加载流程。
- `projects` 是项目插件，菜单放在「工作」组：列表页、详情的概览和设置标签（PJ-01c），其余标签是占位，由 PJ-01d、PJ-02b、PJ-03b、PJ-04b 等补。
