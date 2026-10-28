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
| `npm run test` | 占位，QA-01 接入测试框架后替换 |
| `npm run preview` | 本地预览构建产物 |

## 接口代理

dev server 把 `/api` 代理到环境变量 `PMW_API`，默认 `http://127.0.0.1:7796`，也就是测试实例（真实库的副本，用 `scripts/dev-instance.sh` 起）。

```bash
PMW_API=http://127.0.0.1:7921 npm run dev   # 连别的临时实例
```

联调只连测试实例或临时实例。真实服务的端口不要写进配置，要连真实库必须显式设置 `PMW_API`，并且清楚界面上的写操作会落到真实数据上。

端口分配：7778 原型，7780 本工程，7796 测试实例。

## 目录

```
src/
  main.tsx            入口：挂 QueryClientProvider 和路由
  core/               内核，插件和模块只能依赖这里暴露的东西
    api/              接口层：请求、错误、查询键、各接口的查询 hook 和类型
    shell/            外壳：布局、侧边栏、路由、出错页、占位页
    ui/               基础组件（FE-01a 填充）
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

## 约定

- 组件里不直接 `fetch`，请求一律走 `src/core/api`。后端返回 `{ data, meta? }`，出错返回 `{ error: { code, message } }`，接口层统一解开信封，出错抛 `ApiError`（带 `status`、`code`）。
- 状态、类型、优先级从后端读（`/api/object-types`、`/api/dictionaries`，对应 `useObjectTypes`、`useDictionaries`），不在前端写死。
- 副作用不写进 `setState` 的 updater。
- 不使用 emoji。
