// 项目插件（PJ-01a 起）：清单在后端 internal/plugins/projects/plugin.json，这里只有入口。
// 页面是全部项目列表加项目详情（PJ-01c），没有二级菜单
import { definePlugin } from '../../core/plugin'
import { PROJECT_TYPE, dataKeys, listAllObjects, prototypesApi, queryClient, type ObjectFilter } from '../../core/data'
import { firstLine, searchProjects } from './search'

// 命令面板搜项目：和项目列表共用一份缓存，半分钟内不重取
const PROJECT_FILTER: ObjectFilter = { type: [PROJECT_TYPE], sort: '-updated_at' }
const loadProjects = () => queryClient.fetchQuery({
  queryKey: dataKeys.objects.listAll(PROJECT_FILTER),
  queryFn: ({ signal }) => listAllObjects(PROJECT_FILTER, signal),
  staleTime: 30_000,
})

// 今日「正在运行」的项目原型（SPEC-today-1.14）：逐个项目取原型列表，只留运行中的。原型启停不发事件，靠轮询
async function runningPrototypes(signal: AbortSignal) {
  const projects = (await listAllObjects({ type: [PROJECT_TYPE] }, signal)).data
  const lists = await Promise.all(projects.map((p) => prototypesApi.list(p.id, signal)))
  return projects.flatMap((p, i) => lists[i].filter((x) => x.status === 'running').map((x) => ({ project: p.title, proto: x })))
}

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'projects',
      label: '项目',
      path: 'projects',
      load: () => import('./Page'),
    })
    api.commands.provide('projects', async (q) => searchProjects((await loadProjects()).data, q).map((p) => ({
      id: `projects.open.${p.id}`, group: '项目', title: p.name, sub: firstLine(p.desc) || p.root, keywords: `${p.desc} ${p.root}`,
      // 和列表里点卡片一样记进最近打开
      run: async ({ shell }) => {
        const { touchRecent } = await import('./model')
        touchRecent(p.id)
        shell.navigate(`/projects/${encodeURIComponent(p.id)}`)
      },
    })))
    api.todaySources.register({
      key: 'prototypes', slot: 'running', label: '运行中的原型', order: 10, refetchInterval: 10_000,
      queryKey: ['project-prototypes', '*today'],
      queryFn: ({ signal }) => runningPrototypes(signal),
      select: (rows: Awaited<ReturnType<typeof runningPrototypes>>) => ({
        total: rows.length,
        items: rows.map(({ project, proto: x }) => ({
          id: x.id, tone: 'ok' as const, title: `${project} / ${x.name}`, sub: `:${x.port}`, href: `http://127.0.0.1:${x.port}`,
        })),
      }),
    })
  },
})
