# 前端 ESM 契约参考

> 状态：**P1-a 已实现**（`window.__PMW_PLUGIN__`、import map、模块/设置/今日卡片/命令槽位、CSS 注入可用；`ctx.ui`/object.section 仍 P1-b）。
> 本文是 `docs/plugin-spec-v2.md` 第 8 节的开发速查，冲突时以规范为准。
> 前端接口是新的一套（宿主 ESM 容器），**不要**复用第一方内置插件的 `frontend/src/core/plugin/api.ts`。

## 1. 入口与注册

发布包里的 `web/entry.js` 是 ESM 入口，由宿主动态 `import()`，求值时**同步注册一次**：

```js
window.__PMW_PLUGIN__.register({
  id: "hello_world",              // 必须和清单一致
  api: ">=2.0.0 <3.0.0",          // 必须和清单 api 一致
  activate(ctx) {                 // 只注册，不发请求
    ctx.slots.register("module", { id: "hello_world", title: "Hello World" }, Page)
  },
  deactivate() {                  // 清自己的定时器/订阅；宿主按插件 id 兜底撤销
  },
})
```

宿主规则（设计）：

- 先校验 `api` 与清单一致且包含宿主 API 版本，通过后才登记；重复注册、id 不符、api 不兼容
  → 拒绝并记问题，插件不显示。
- `activate` 里只注册；数据在组件里按需取（沿用 1.x 的约定，避免拖慢启用）。
- 停用：先调 `deactivate()`，再撤槽位、卸载模块；页面刷新兜底。

## 2. 加载与资源

- 加载 URL：`/api/plugins/external/<id>/web/<web_entry>?v=<version>`（`v=` 破缓存，升级即新 URL）。
- 包内资源走同源 `/api/plugins/external/<id>/web/*`；`web/` 里的相对 `import` 允许（chunk 一起发布），
  不得引用 CDN、`/` 开头的站内路径、`data:`/`blob:` 可执行脚本。
- 图标走 `/api/plugins/external/<id>/icon`。
- 不得加载远程脚本、字体、图片；静态资源必须在包内。

## 3. import map 与 React 共享

宿主在页面注入 import map，插件 **不得自带 React / react-dom**：

| specifier | 指向 |
|---|---|
| `react` | 宿主同一份 React 19 |
| `react-dom` | 宿主同一份 React 19 |
| `react-dom/client` | 宿主同一份 React 19 |
| `react/jsx-runtime` | 宿主同一份 React 19 |

裸 import 只允许这四个（其余一律失败）。用 Vite 打包时：

```js
// vite.config.js（仅当你要上完整打包时；模板的 entry.ts 是零构建的 JS 语法子集）
export default {
  build: {
    lib: { entry: "web/entry.ts", formats: ["es"], fileName: "entry" },
    rollupOptions: { external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"] },
  },
}
```

不要自带路由（路径由宿主外壳管理）；跳转能力用 `ctx` 提供的导航 API（P1 定稿）。

## 4. `ctx` API

| API | 说明 |
|---|---|
| `ctx.id` / `ctx.version` / `ctx.apiVersion` | 插件 id、版本、宿主 API 版本 |
| `ctx.slots.register(key, spec, Component)` | 注册槽位，返回 `Disposable` |
| `ctx.ui` | **P1-b 才提供**；P1-a 只有 `ctx.theme` 的主题变量 |
| `ctx.host.call(method, params)` | 调宿主 `host.*` 能力；权限同样被 broker 拦，前端绕不过 |
| `ctx.permissions.has(perm)` | 当前**已授予**的权限（安装确认的非高风险项 + 已单独授权项）；只用于展示/降级，不构成授权 |
| `ctx.i18n` | `{ lang, t(key, vars) }` |
| `ctx.theme` | `{ mode: "light"\|"dark"\|"system", resolved, subscribe(cb) }` |
| `ctx.notify(payload)` | 发通知；需要清单声明 `notify` |
| `ctx.openExternal(url)` | 打开外链（P1-a 已实现）；只允许 http(s)，其它协议抛错 |

示例（模板 `web/entry.ts` 的真实写法）：

```js
const res = await ctx.host.call("host.objects.list", { limit: 5 })
const items = Array.isArray(res && res.items) ? res.items : []

if (ctx.permissions.has("objects:read")) { /* 展示 */ }

ctx.notify({ level: "info", title: "Hello World", body: "来自外部插件的问候" })
```

`ctx.host.call` 返回 Promise；失败时 reject 一个带 `message` 的错误，**要 catch 并降级**，
不要把未捕获的 rejection 留给宿主错误边界。

## 5. 槽位

首批只开放 5 个槽位，和清单 `provides` 分组一一对应：

| `key` | 对应 `provides` | `spec` 要点 | 第三参数 |
|---|---|---|---|
| `module` | `modules` | `{ id, title, icon?, order? }`，id 必须在 `provides.modules` 里 | 页面组件 |
| `settings.section` | `settings` | `{ id, title, order? }` | 分节内容组件 |
| `today.card` | `today_cards` | `{ key, title, order? }`，key 是 `provides.today_cards` 里的 id | 卡片组件 |
| `command` | `commands` | `{ id, title, keywords?, run(args) }`，id 是 `<id>.<动作>` | 省略 |
| `object.section` | `object_types` | `{ object_type, title, order? }` | 对象详情区块组件 |

- 每个槽位渲染都在该插件的错误边界里；组件抛错只影响这一块。
- 停用时宿主按插件 id 一次性 dispose 全部注册；插件自己 `register` 返回的 disposable 也可以主动 dispose。
- 注册的 id 不在清单 `provides` 里：开发环境抛错，生产环境拒绝注册并记运行异常。

## 6. 错误边界

模板里 `ErrorBoundary` 包每个组件；`componentDidCatch` 只写 `console.error`，不弹宿主级提示。
插件界面异常不能影响外壳、菜单和其它插件。不要自己实现全局错误上报/覆盖 `window.onerror`。

## 7. 隔离与 CSP

- 每个插件一个错误边界；一个插件的异常不影响外壳、菜单和其它插件。
- CSS 必须挂在 `[data-pmw-plugin="<id>"]` 下（宿主在容器上加这个属性）；禁止全局选择器、
  禁止覆盖 `html/body`、禁止用 `!important` 改宿主样式。
- 禁止：`document.body` 追加第二应用、读写其它插件/内核的 DOM、加载远程脚本、
  `eval` / `new Function` / `setTimeout(string)`、`document.write`、`innerHTML` 拼不可信内容。
- CSP（设计）：`script-src 'self'`，禁止内联/远程脚本；插件资源单独目录、同源提供。
- 违规的包在评审/加载校验里拒绝（P2 补静态检查，P1 先人工评审 + 运行时错误边界兜底）。
- **不信任插件上报的权限状态**：前端判断只用于展示，真正授权在宿主 broker。

## 8. 主题与样式

- 用宿主样式变量，前缀 `--pmw-*`；不要依赖 1.x 的 `--bg/--panel/--text` 变量（旧前端遗留）。
- 暗色/亮色跟随 `ctx.theme`；不要写死背景色和文字色。
- 模板提供 `web/style.css`，所有选择器都写成 `[data-pmw-plugin="{{PMW_ID}}"] .xxx`。
  颜色优先 `var(--pmw-panel, #fff)` 这类「宿主 token + 中性兜底」形式。

## 9. 状态与数据

- 组件状态放自己的 React state；跨页面共享的少量设置用 `host.settings.get/set`。
- 数据一律 `ctx.host.call` 按需取；不要在 `activate` 里预取。
- 订阅事件：清单 `subscribes` + 后端 `plugin.event.deliver`；前端不直连事件总线。

## 10. 常见错误

| 现象 | 原因 |
|---|---|
| 插件不显示、控制台 404 | `runtime.web.entry` 路径写错，或没把 `web/` 放进发布包 |
| `Failed to resolve module specifier "react"` | 宿主 import map 没注入/你访问的不是宿主页面；不要改成自带 React |
| 页面白屏、但插件后端正常 | 入口没调 `register`、id/api 和清单不一致，或组件抛错未在错误边界内 |
| 样式串到别的页面 | 选择器没挂在 `[data-pmw-plugin="<id>"]` 下 |
| `ctx.permissions.has` 为 true 但 `host.call` 还是 `permission_denied` | 权限状态不可信；以 `host.call` 的错误为准并降级 |
| 停用后定时器还在跑 | `deactivate` 里没清自己的定时器/订阅 |
