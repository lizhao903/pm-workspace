// 项目插件（PJ-01a 起）：清单在后端 internal/plugins/projects/plugin.json，这里只有入口。
// 页面是全部项目列表加项目详情（PJ-01c），没有二级菜单
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import {
  PROJECT_TYPE, dataKeys, listAllObjects, onServerEvent, prototypeUp, prototypesApi, queryClient, releaseKeys, testRunKeys, worktreeKeys, type ObjectFilter, type ProjectPrototype,
} from '../../core/data'
import { firstLine, searchProjects } from './search'

// 命令面板搜项目：和项目列表共用一份缓存，半分钟内不重取
const PROJECT_FILTER: ObjectFilter = { type: [PROJECT_TYPE], sort: '-updated_at' }
const loadProjects = () => queryClient.fetchQuery({
  queryKey: dataKeys.objects.listAll(PROJECT_FILTER),
  queryFn: ({ signal }) => listAllObjects(PROJECT_FILTER, signal),
  staleTime: 30_000,
})

// 今日「正在运行」的项目原型（SPEC-today-1.14）：逐个项目取原型列表，只留在跑的（含外部启动的，PJ-04c）。原型启停不发事件，靠轮询
async function runningPrototypes(signal: AbortSignal) {
  const projects = (await listAllObjects({ type: [PROJECT_TYPE] }, signal)).data
  const lists = await Promise.all(projects.map((p) => prototypesApi.list(p.id, signal)))
  return projects.flatMap((p, i) => lists[i].filter((x) => prototypeUp(x.status)).map((x) => ({ project: p.title, proto: x })))
}

/** 今日「正在运行」里的一行；外部启动的在端口后面注明 */
export function todayProtoItem(project: string, x: Pick<ProjectPrototype, 'id' | 'name' | 'port' | 'status'>) {
  return {
    id: x.id, tone: 'ok' as const, title: `${project} / ${x.name}`,
    sub: x.status === 'external' ? `:${x.port} · 外部启动` : `:${x.port}`, href: `http://127.0.0.1:${x.port}`,
  }
}

// 工作区变化（准备、清理、清理失败）时后端发 projects.worktree_changed，标脏任务详情里的工作区
let offWorktree: (() => void) | undefined
// 测试开始、每步变化、结束时后端发 projects.test_changed，标脏任务详情里的「最近一次测试」
let offTests: (() => void) | undefined
// 发布开始、每步变化、结束时后端发 projects.release_changed（AUTO-10），标脏任务详情里的「最近一次发布」
let offReleases: (() => void) | undefined

export default definePlugin({
  activate(api) {
    api.modules.register({
      id: 'projects',
      label: '项目',
      path: 'projects',
      load: () => import('./Page'),
    })
    // SOP 节点（AUTO-06）：给自动受理这类流程取项目档案；节点本身、必填项在后端登记，没装 SOP 插件时没人读
    api.sopNodes.register({
      kind: 'projects_list_profiles', label: '列项目档案', group: '项目', color: '#2f9e44',
      desc: '取建过档案的项目摘要（简介、关键词、平台），输出 profiles 和给模型看的 profiles_text',
      fields: [],
    })
    api.sopNodes.register({
      kind: 'projects_get_profile', label: '读项目档案', group: '项目', color: '#2b8a3e',
      desc: '读一个项目的档案，输出 profile；profile.dirs 是代码库、原型库、PRD 目录（没设的依次回退）',
      fields: [
        { key: 'project', label: '项目', type: 'text', required: true, default: '{{project.id}}', hint: '项目 id、编号或名字，支持 {{字段}}' },
      ],
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
        items: rows.map(({ project, proto: x }) => todayProtoItem(project, x)),
      }),
    })
    // 需求工作区（AUTO-07）：任务详情基础信息末尾的「工作区」、设置里的端口范围、SOP 的「准备工作区」节点
    api.objectSections.register({ key: 'worktree', typeIds: ['task'], order: 40, section: lazy(() => import('./WorktreeSection')) })
    api.settings.register({ key: 'worktrees', label: '工作区', desc: '需求工作区的端口范围、测试环境保留时长', page: lazy(() => import('./WorktreeSettings')) })
    api.sopNodes.register({
      kind: 'projects_prepare_worktree', label: '准备工作区', group: '项目', color: '#1971c2',
      desc: '给任务在项目代码库建独立的 worktree 和分支 auto/<任务编号>，分一段端口；下游 Claude Code 的工作目录填 {{worktree.path}}',
      fields: [
        { key: 'task', label: '任务', type: 'text', hint: '任务 id 或编号，支持 {{字段}}；留空取输入里的 task_id' },
      ],
      summary: (c) => (c.task ? `任务 ${c.task}` : '任务取输入里的 task_id'),
    })
    // 测试环境与测试报告（AUTO-08）：SOP 的「跑测试」节点，下游条件分支写 test.ok 等于 false 走修复
    api.sopNodes.register({
      kind: 'projects_run_test', label: '跑测试', group: '项目', color: '#2b8a3e',
      desc: '在任务的工作区上按项目档案构建、起临时测试环境、跑测试和冒烟，写测试报告登记为任务产出；跑完回收环境，要求保留时通过后留给人工验收。输出 test.ok、test.report_url、test.env_text、test.steps',
      fields: [
        { key: 'task', label: '任务', type: 'text', hint: '任务 id 或编号，支持 {{字段}}；留空取输入里的 task_id 或 worktree.task_id' },
        { key: 'keep_env', label: '保留测试环境', type: 'text', hint: '留空不保留；「是」按设置里的时长保留，也可以写「24 小时」「2 天」。只在全部通过时保留，到点或验收结束回收' },
      ],
      summary: (c) => [c.task ? `任务 ${c.task}` : '任务取输入里的 task_id', c.keep_env ? `通过后保留环境（${c.keep_env}）` : ''].filter(Boolean).join('，'),
    })
    // 发布（AUTO-10）：准备发布（审批前，只跑版本号与打包）和上线（审批后，冒烟没过自动回滚），下游条件分支按 release.ok
    api.sopNodes.register({
      kind: 'projects_prepare_release', label: '准备发布', group: '项目', color: '#2b8a3e',
      desc: '在任务的工作区上按项目档案跑版本号与更新日志、打包，不碰生产；跑完定下审批后要跑的命令，等上线审批。输出 release.ok、release.id、release.version、release.changelog、release.report_url',
      fields: [
        { key: 'task', label: '任务', type: 'text', hint: '任务 id 或编号，支持 {{字段}}；留空取输入里的 task_id 或 task.id' },
      ],
      summary: (c) => (c.task ? `任务 ${c.task}` : '任务取输入里的 task_id'),
    })
    api.sopNodes.register({
      kind: 'projects_release', label: '上线', group: '项目', color: '#c92a2a',
      desc: '放在人工审批之后：按项目档案跑发布前检查（备份、核对密钥）、发布、线上冒烟，发布或冒烟没过自动回滚。只认准备好、等审批的发布。输出 release.ok、release.rolled_back、release.text',
      fields: [
        { key: 'release', label: '发布', type: 'text', hint: '发布 id，支持 {{字段}}；留空取输入里的 release.id（接在「准备发布」后面不用填）' },
      ],
      summary: (c) => (c.release ? `发布 ${c.release}` : '发布取输入里的 release.id'),
    })
    offWorktree = onServerEvent('projects.worktree_changed', () => void queryClient.invalidateQueries({ queryKey: worktreeKeys.all }))
    offTests = onServerEvent('projects.test_changed', () => void queryClient.invalidateQueries({ queryKey: testRunKeys.all }))
    offReleases = onServerEvent('projects.release_changed', () => void queryClient.invalidateQueries({ queryKey: releaseKeys.all }))
  },
  deactivate() {
    offWorktree?.()
    offWorktree = undefined
    offTests?.()
    offTests = undefined
    offReleases?.()
    offReleases = undefined
  },
})
