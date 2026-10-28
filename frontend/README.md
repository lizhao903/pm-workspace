# frontend：正式前端

一人之下的正式前端，独立工程。原型 `web-next/` 只当规格参考，这里不 import 原型的任何代码；旧前端 `web/` 不再迭代，本工程上线后替换它（构建产物嵌进 Go 二进制由 FE-03 负责）。

## 启动

```bash
cd frontend
npm ci            # 按 package-lock.json 安装
npm run dev       # dev server：http://127.0.0.1:7780
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器，固定 `127.0.0.1:7780`（端口被占就直接失败，不换端口） |
| `npm run build` | 类型检查加构建，产物在 `frontend/dist` |
| `npm run typecheck` | 只做类型检查（`tsc -b`） |
| `npm run lint` | oxlint，配置在 `.oxlintrc.json` |
| `npm test` | Vitest 跑一遍退出（非 watch），纯函数测试和组件测试都跑，见下面「测试」一节 |
| `npm run test:watch` | Vitest watch 模式，开发时用 |
| `npm run preview` | 本地预览构建产物 |

## 接口代理

dev server 把 `/api` 代理到环境变量 `PMW_API`，默认 `http://127.0.0.1:7796`，也就是测试实例（真实库的副本，用 `scripts/dev-instance.sh` 起）。

```bash
PMW_API=http://127.0.0.1:7921 npm run dev   # 连别的临时实例
```

联调只连测试实例或临时实例。真实服务的端口不要写进配置，要连真实库必须显式设置 `PMW_API`，并且清楚界面上的写操作会落到真实数据上。

端口分配：7778 原型，7780 本工程，7796 测试实例。

## 测试

Vitest，配置在 `vitest.config.ts`，分两个 project：

| project | 匹配 | 环境 | 用途 |
|---|---|---|---|
| `unit` | `src/**/*.test.ts` | node | 纯函数、打桩 `fetch` 的接口层测试 |
| `dom` | `src/**/*.test.tsx` | jsdom | 组件测试，用 `@testing-library/react` 渲染、`@testing-library/user-event` 操作 |

约定：

- 测试文件放在被测文件旁边，纯函数用 `*.test.ts`，组件用 `*.test.tsx`，扩展名决定跑在哪个环境。
- 样板：纯函数看 `src/core/ui/cls.test.ts`，组件看 `src/core/ui/ThemeSwitch.test.tsx`。
- 组件测试的公共准备在 `src/test/setup.ts`：注册 `@testing-library/jest-dom` 的断言（`toBeInTheDocument`、`toHaveAttribute` 等），补上 jsdom 没有的 `matchMedia`（默认系统浅色），每条用例后卸载渲染的组件。
- 按角色和可见文字找元素（`getByRole('radio', { name: '深色' })`），不按 className 找。
- 模块级状态（比如 `theme.ts` 的主题偏好）在用例之间不会重置，要在 `beforeEach` 里自己复位。
- 测试文件都在 `src` 下，`npm run typecheck` 会一起检查；不 import `web-next` 的任何代码。
- 不连后端。要连测试实例的只读用例见下面「联调测试实例」。

```bash
npm test                                   # 全部跑一遍
npx vitest run src/core/ui                 # 只跑某个目录
npx vitest run --project dom               # 只跑组件测试
npm run test:watch                         # 开发时 watch
```

浏览器端到端（Playwright）不在这里，见 QA-02a、QA-02b。

## 接口层

`src/core/api` 是唯一发请求的地方，`.oxlintrc.json` 的 `no-restricted-globals` / `no-restricted-properties` 禁止在它之外用 `fetch`（含 `window.fetch`、`globalThis.fetch`）。

| 文件 | 内容 |
|---|---|
| `client.ts` | 统一请求函数：解开 `{data, meta}` 信封；失败抛 `ApiError{status, code, message}`；写请求统一带 `X-Actor-Source: ui` |
| `types.ts` | 按 `docs/api-contract.md` 手写的类型。契约里的 `Object` 在这里叫 `WorkObject`，免得遮住全局 `Object` |
| `query.ts` | query 参数生成（`objectListQuery`、`artifactListQuery`）、聚焦口径 `focusParams`、PATCH 挑改动字段 `changedFields` |
| `resources.ts` | 各资源的请求函数：`objects`、`objectTypes`、`dictionaries`、`stakeholders`、`artifacts`、`runs`、`fs`、`counts` 等 |
| `queries.ts` | 查询键和查询 hook（缓存与数据访问层在 CORE-03a） |

错误码：`validation` 400、`not_found` 404、`conflict` 409、`readonly` 403、`internal` 500，后端没给码或给了不认识的码时按状态码归类；请求没到后端（服务没起、断网）是 `network`，`status` 为 0。

几条容易写错的语义：

- 列表多选（`type`、`status`、`priority`）逗号拼接；`tag` 是重复参数（`tag=a&tag=b`，AND 语义）；布尔开关只在 `true` 时出现。
- `due_after` / `due_before` 传纯日期 `YYYY-MM-DD`，由后端补时（下界补 00:00:00、上界补 23:59:59），前端不要自己补；「今日」「本周」用 `focusParams`，口径和 `/api/counts` 一致。
- PATCH 只传改动字段（用 `changedFields(原对象, 草稿)` 挑）；`category_id: null` 表示置空，`owner_id: ""` 表示清空负责人，`participant_ids`、`tags`、`props` 都是整体替换。
- 列表函数返回 `{ data, total, limit, offset }`，`total` 来自 `meta.total`。

### 联调测试实例（手工验证）

联调只连测试实例 `127.0.0.1:7796`（或自己起的临时实例），不连真实服务。`src/core/api/live.test.ts` 是一组只读联调用例，默认跳过，设了 `PMW_LIVE_API` 才跑：

```bash
curl -s http://127.0.0.1:7796/api/health          # 先确认测试实例在跑
cd frontend
PMW_LIVE_API=http://127.0.0.1:7796 npx vitest run src/core/api/live.test.ts --reporter=verbose
```

期望全部通过，其中：

1. `objects.list({type:['task']})` 返回 `data`（每条 `type_id` 都是 `task`）和数字 `total`；
2. `objects.get('obj_does_not_exist')` 抛 `ApiError`，`status` 为 404、`code` 为 `not_found`；
3. 非法 `sort` 得到 `validation`；类型、字典、干系人、计数能读；进展带 `kind`、`commits`、`files`、`status`，修订带 `actor_name`、`session_id`。

## 构建嵌入

pmw 单文件分发，前端产物由 `internal/webui` 用 `//go:embed` 嵌进二进制。嵌哪套前端由仓库根目录 Makefile 的 `FRONTEND` 开关决定，默认仍是旧前端 `web/`，默认值切到本工程留给 REL-01。

```bash
make build                  # 嵌旧前端 web/（默认，等同 FRONTEND=legacy）
make build FRONTEND=new     # 嵌本工程：npm run build 后把 frontend/dist 整份换进 internal/webui/dist
make frontend               # 只构建并拷贝本工程，不编译 Go
make deps                   # 同时安装 web/ 和 frontend/ 的依赖
```

- `make frontend` 先清空 `internal/webui/dist` 再拷，然后补回 `.gitkeep`（理由见根目录 `.gitignore`）；旧前端的 `make web` 由 vite 的 `emptyOutDir` 清空，两套来回切不会留下对方的文件。
- `internal/webui/dist` 只有一份，最后一次构建的是谁就嵌谁。`go build`、`scripts/dev-instance.sh start` 不会自己构建前端，嵌的是当时 dist 里的东西。
- `go test ./internal/webui/` 会检查嵌进去的 `index.html` 引用的 `/assets` 文件都在，拷了一半或混了两套产物时直接失败。
- 后端对没命中文件的路径一律回落 `index.html`，所以 `createBrowserRouter` 的前端路由直接刷新也能打开；`/assets` 下的文件永久缓存，`index.html` 每次回源。

在测试实例上看本工程（不要 reset，看完换回旧前端）：

```bash
make build FRONTEND=new BIN=/tmp/pmw BIN_MCP=/tmp/pmw-mcp   # 二进制放临时目录，不覆盖 bin/pmw、bin/pmw-mcp
scripts/dev-instance.sh stop && scripts/dev-instance.sh start   # start 重新编译 bin/pmw-dev，嵌入当前 dist
# 打开 http://127.0.0.1:7796/ ，标题是「一人之下」
make build BIN=/tmp/pmw BIN_MCP=/tmp/pmw-mcp                  # 换回旧前端
scripts/dev-instance.sh stop && scripts/dev-instance.sh start
```

## 目录

```
src/
  main.tsx            入口：挂 QueryClientProvider 和路由
  core/               内核，插件和模块只能依赖这里暴露的东西
    api/              接口层：请求、错误、查询键、各接口的查询 hook 和类型
    shell/            外壳：布局、侧边栏、路由、出错页、占位页
    ui/               设计变量、基础排版、主题（FE-01a）；基础组件（FE-01b）
    plugin/           模块和插件的描述结构、注册表（清单加载在 FE-00b）
  modules/            内核模块，每个一个目录：today 今日、tasks 任务、docs 文档、
                      contacts 联系人、conversations 会话、settings 设置
    index.ts          内核模块列表，顺序即侧边栏顺序
  plugins/<id>/       插件，目录名就是插件 id，插件之间互不 import
```

每个模块目录导出一个 `ModuleDef`（`id`、`label`、`path`、`load`），页面通过 `load` 按需加载，路由由 `core/shell/router.tsx` 根据模块列表生成。

## 选型

| 方面 | 选型 | 约定 |
|---|---|---|
| 框架 | React 19 + TypeScript 6 + Vite 8 | 版本与原型 `web-next` 对齐 |
| 路由 | react-router 8（`createBrowserRouter` 数据路由） | 模块页面用路由的 `lazy` 按需加载；模块内子路由挂在 `<path>/*` 下 |
| 服务端状态 | TanStack Query 5 | 后端数据一律用查询 hook 取，查询键集中在 `core/api/queries.ts` 的 `keys`；写操作用 mutation，成功后按键失效缓存，不手动拷一份到组件状态 |
| 本地界面状态 | React 自带的 state / context | 不引入全局状态库，确有需要再评估 |
| 代码检查 | oxlint | 规则沿用旧前端 `web/` |

## 主题和设计变量

样式入口在 `src/core/ui/`，`import '../ui'`（或 `src/core/ui/index.ts`）时一起加载：

| 文件 | 内容 |
|---|---|
| `tokens.css` | 设计变量：颜色、圆角、阴影、布局尺寸、字体，浅色写在 `:root`，深色写在 `:root[data-theme='dark']` |
| `base.css` | 基础排版：正文字体和行高（13px / 1.5）、按钮与表单继承字体、焦点框、链接、滚动条 |
| `theme.ts` | 主题偏好：`useTheme()` 返回 `{ pref, resolved, setTheme }`，`ThemeSwitch` 是三选一的切换控件（放在侧栏底部） |

- 颜色一律引用变量（`var(--accent)`），组件和页面里不写色值；`.tsx` 里不出现 `#xxxxxx`，验收用 `grep -rnE "#[0-9a-fA-F]{3,8}\b" src --include=*.tsx` 检查。
- 主题三选一：浅色（默认）、深色、跟随系统。偏好存 localStorage 的 `pmw-theme`（旧前端用的是 `pmw.theme`，换键避免同域上线后互相读错）；读写都包了 try/catch，拿不到存储时只在本次会话生效。实际生效的明暗写在 `<html data-theme>`，模块加载时就写上，首屏不闪；选跟随系统时监听系统明暗变化，别的标签页改了偏好也会跟着变。
- 字号 `--fs-*` 和间距 `--sp-*` 原型里没有，按原型用得最多的取值补的：字阶 10.5 / 11.5 / 12.5 / 13 / 14 / 15 / 18 / 22 / 26px（`--fs-2xs` 到 `--fs-3xl`，正文是 `--fs`），原型里零散的 11px、12px 搬模块时并到相邻档；间距 `--sp-N` 等于 N 个 2px（`--sp-1` 2px 到 `--sp-16` 32px）。
- 模块样式不在这里整份搬，做对应页面时再从原型拿。
- 对照页：`npm run dev` 后打开 `/_dev/tokens`，列出色板、字阶、间距、圆角阴影和布局尺寸，值从页面实际生效的样式里读，页内可切主题。路由用 `import.meta.env.DEV` 守着，`npm run build` 的产物里没有这个页面。

与原型 `web-next/src/styles.css` 的对照结果（2026-10-28，脚本解析两边 `:root` 和暗色段逐个比对同名变量，空白归一后比较）：

| 段 | 同名变量 | 一致 | 不一致 | 本工程新增 |
|---|---|---|---|---|
| `:root`（浅色） | 32 | 32 | 0 | 22（`--fs-*` 9 个、`--lh` 2 个、`--sp-*` 11 个） |
| `:root[data-theme='dark']` | 22 | 22 | 0 | 0 |

浅色 32 个：`--bg` `--side` `--panel` `--panel-2` `--hover` `--line` `--line-2` `--text` `--muted` `--faint` `--accent` `--accent-ink` `--accent-soft` `--accent-line` `--ok` `--warn` `--warn-soft` `--danger` `--danger-soft` `--r-sm` `--r` `--r-lg` `--shadow-sm` `--shadow` `--shadow-lg` `--side-w` `--drawer-w` `--subnav-w` `--foot-h` `--top-h` `--sans` `--mono`；深色覆盖其中的 19 个颜色和 3 个阴影。原型改了这两段的值，这里要同步改，并重跑对照。

## 约定

- 组件里不直接 `fetch`，请求一律走 `src/core/api`。后端返回 `{ data, meta? }`，出错返回 `{ error: { code, message } }`，接口层统一解开信封，出错抛 `ApiError`（带 `status`、`code`）。
- 状态、类型、优先级从后端读（`/api/object-types`、`/api/dictionaries`，对应 `useObjectTypes`、`useDictionaries`），不在前端写死。
- 副作用不写进 `setState` 的 updater。
- 不使用 emoji。
