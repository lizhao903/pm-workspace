// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目插件（PJ-01a 起）：清单在后端 internal/plugins/projects/plugin.json，这里只有入口。
// 页面是全部项目列表加项目详情（PJ-01c），没有二级菜单
import { lazy } from 'react'
import { definePlugin } from '../../core/plugin'
import {
  PROJECT_TYPE, dataKeys, listAllObjects, onServerEvent, prototypeUp, prototypesApi, queryClient, releaseKeys, protoSyncKeys, testRunKeys, worktreeKeys, type ObjectFilter, type ProjectPrototype,
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
// 原型同步开始、每步变化、结束时后端发 projects.proto_sync_changed（AUTO-11），标脏档案标签里的「原型同步」
let offProtoSync: (() => void) | undefined

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
    // 原型同步（AUTO-11）：内置流程「原型同步」用的六个节点，下游条件分支按 sync.changed、sync.has_pending
    const syncField = { key: 'sync', label: '同步', type: 'text' as const, hint: '同步记录 id，支持 {{字段}}；留空取输入里的 sync.id（接在「取同步范围」后面不用填）' }
    api.sopNodes.register({
      kind: 'projects_proto_sync_range', label: '取同步范围', group: '项目', color: '#5f3dc4',
      desc: '取项目上次同步点到生产分支 HEAD 的代码 diff（首次同步对比整个代码库），判断有没有涉及界面或接口的改动。输出 sync.changed、sync.diff_path、sync.diff_stat、sync.base、sync.head',
      fields: [
        { key: 'project', label: '项目', type: 'text', hint: '项目 id、编号或名字，支持 {{字段}}；留空取输入里的 project_id' },
        { key: 'sync', label: '同步', type: 'text', hint: '项目插件发起时带的同步记录 id；留空取输入里的 sync_id，没有就新建一次' },
      ],
      summary: (c) => (c.project ? `项目 ${c.project}` : '项目取输入里的 project_id'),
    })
    api.sopNodes.register({
      kind: 'projects_proto_sync_branch', label: '准备原型同步分支', group: '项目', color: '#5f3dc4',
      desc: '在原型库拉 proto-sync/<日期> 分支的独立 worktree，不切换、不改原型库主目录。输出 sync.proto_path（Claude Code 的工作目录）、sync.proto_branch',
      fields: [syncField],
      summary: () => '原型库 proto-sync/<日期>',
    })
    api.sopNodes.register({
      kind: 'projects_proto_sync_classify', label: '登记差异', group: '项目', color: '#5f3dc4',
      desc: '读 Claude Code 回报的 result.items，按新增、不一致、未实现、已下线、不确定分类，记规格的实现状态；有不确定项时等产品裁决。输出 sync.has_pending、sync.pending_text、sync.items_text',
      fields: [syncField, { key: 'result', label: '结论字段', type: 'text', hint: '留空取输入里的 result' }],
      summary: () => '按五类登记',
    })
    api.sopNodes.register({
      kind: 'projects_proto_sync_verdict', label: '记裁决', group: '项目', color: '#5f3dc4',
      desc: '把还没裁决的不确定项记成这次的裁决：design 当作新设计、defect 当作缺陷（给项目建修复任务）、ignore 暂不处理',
      fields: [{ key: 'decision', label: '裁决', type: 'select', required: true, options: () => [
        { value: 'design', label: '当作新设计' }, { value: 'defect', label: '当作缺陷' }, { value: 'ignore', label: '暂不处理' }] }, syncField],
      summary: (c) => ({ design: '当作新设计', defect: '当作缺陷', ignore: '暂不处理' } as Record<string, string>)[c.decision ?? ''] ?? '还没选裁决',
    })
    api.sopNodes.register({
      kind: 'projects_proto_sync_commit', label: '提交同步分支', group: '项目', color: '#5f3dc4',
      desc: '把同步分支 worktree 里没提交的改动提交到 proto-sync/ 分支；当前分支不是同步分支时拒绝。不推送、不合并。输出 sync.proto_commit',
      fields: [syncField],
      summary: () => '只提交到 proto-sync/ 分支',
    })
    api.sopNodes.register({
      kind: 'projects_proto_sync_record', label: '记同步点', group: '项目', color: '#5f3dc4',
      desc: '把这次的代码 HEAD 记成同步点，和同步分支的提交对应起来；删掉 worktree，分支保留。输出 sync.text（给通知用的一句话）',
      fields: [syncField, { key: 'outcome', label: '结果', type: 'text', hint: '写 no_change 记成「没有涉及界面或接口的改动」；留空按有没有改动定' }],
      summary: (c) => (c.outcome === 'no_change' ? '只前移同步点' : '记同步点'),
    })
    // 项目资料同步到知识库（TSK-0721）：内置流程「每周一 10:00 整理项目知识库」用它；增量、只动同步加进来的由后端管
    api.sopNodes.register({
      kind: 'projects_kb_sync', label: '项目资料同步到知识库', group: '项目', color: '#1c7ed6',
      desc: '把项目资料（本机文件和文件夹、笔记、链接的标题和备注、关联的文档、文档目录）同步进项目知识库：新增的加，变了的重新索引，删了的移出，只动同步加进来的；没有知识库的新建并绑定。输出 kb_sync',
      fields: [
        { key: 'project', label: '项目', type: 'text', default: '全部', hint: '项目 id、编号或名字，支持 {{字段}}；留空或「全部」是所有没归档的项目' },
        { key: 'files', label: '收本机文件和文件夹', type: 'select', default: 'yes', hint: '只收 md、markdown、txt、text，单个超过 1MB 跳过', options: () => [{ value: 'yes', label: '收' }, { value: 'no', label: '不收' }] },
        { key: 'notes', label: '收笔记', type: 'select', default: 'yes', hint: '项目资料里的笔记', options: () => [{ value: 'yes', label: '收' }, { value: 'no', label: '不收' }] },
        { key: 'links', label: '收链接', type: 'select', default: 'yes', hint: '只收标题和备注，不抓网页正文', options: () => [{ value: 'yes', label: '收' }, { value: 'no', label: '不收' }] },
        { key: 'docs', label: '收关联的文档', type: 'select', default: 'yes', hint: '挂在项目下的工作台文档', options: () => [{ value: 'yes', label: '收' }, { value: 'no', label: '不收' }] },
        { key: 'docs_dir', label: '收文档目录', type: 'select', default: 'yes', hint: '项目设置里的文档目录', options: () => [{ value: 'yes', label: '收' }, { value: 'no', label: '不收' }] },
        { key: 'notify', label: '通知我', type: 'select', options: () => [
          { value: '', label: '不通知' }, { value: 'changed', label: '有变化或失败时' }, { value: 'always', label: '每次都通知' }] },
      ],
      summary: (c) => (!c.project || c.project === '全部' || c.project === 'all' ? '所有项目' : c.project),
    })
    offWorktree = onServerEvent('projects.worktree_changed', () => void queryClient.invalidateQueries({ queryKey: worktreeKeys.all }))
    offTests = onServerEvent('projects.test_changed', () => void queryClient.invalidateQueries({ queryKey: testRunKeys.all }))
    offReleases = onServerEvent('projects.release_changed', () => void queryClient.invalidateQueries({ queryKey: releaseKeys.all }))
    offProtoSync = onServerEvent('projects.proto_sync_changed', () => void queryClient.invalidateQueries({ queryKey: protoSyncKeys.all }))
  },
  deactivate() {
    offWorktree?.()
    offWorktree = undefined
    offTests?.()
    offTests = undefined
    offReleases?.()
    offReleases = undefined
    offProtoSync?.()
    offProtoSync = undefined
  },
})
