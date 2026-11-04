import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { applyChange, invalidationsFor, type Change } from './invalidate'
import { dataKeys, normFilter } from './keys'
import { agentKeys } from './agentKeys'
import { todayKeys } from './today'

// 各页面会用到的缓存，挨个种进一个空缓存，看一次改动把哪些标成过期
const seeded = {
  taskList: dataKeys.objects.listAll({ type: ['task'], q: '', overdue: false }),
  overdueList: dataKeys.objects.listAll({ type: ['task'], overdue: true }),
  todayList: dataKeys.objects.list({ type: ['task'], due_before: '2026-10-29', not_terminal: true }),
  projectTab: dataKeys.objects.listAll({ type: ['task'], project: 'obj_p1' }),
  projectOptions: dataKeys.objects.listAll({ type: ['project'], sort: 'title' }),
  detail: dataKeys.objects.detail('obj_a'),
  otherDetail: dataKeys.objects.detail('obj_b'),
  progress: dataKeys.objects.progress('obj_a'),
  otherProgress: dataKeys.objects.progress('obj_b'),
  revisions: dataKeys.objects.revisions('obj_a'),
  taskCounts: dataKeys.counts.of('task'),
  menuCounts: dataKeys.counts.of(),
  stakeholders: dataKeys.stakeholders.list(),
  types: dataKeys.objectTypes,
  dictItems: dataKeys.dictionaries.items('priority'),
  artifacts: dataKeys.artifacts.list({ object_id: 'obj_a', limit: 500 }),
  artifactStats: dataKeys.artifacts.stats({ object_id: 'obj_a' }),
  runs: dataKeys.runs.list('obj_a'),
  otherRuns: dataKeys.runs.list('obj_b'),
  run: dataKeys.runs.detail('run_1'),
  workdir: dataKeys.workdir('/tmp'),
  plugins: dataKeys.plugins.list,
  agentSessions: agentKeys.sessions.unscoped,
  agentMessages: agentKeys.sessions.messages('ags_a'),
  otherMessages: agentKeys.sessions.messages('ags_b'),
  agentProviders: agentKeys.providers,
} satisfies Record<string, QueryKey>

type Name = keyof typeof seeded

async function stale(c: Change): Promise<Name[]> {
  const qc = new QueryClient()
  for (const k of Object.values(seeded)) qc.setQueryData(k, {})
  await applyChange(qc, c)
  return (Object.keys(seeded) as Name[]).filter((n) => qc.getQueryState(seeded[n])?.isInvalidated)
}

describe('失效规则', () => {
  it('任务改了状态：所有对象列表（任务、逾期、今日、项目的任务标签页）、对象本身、计数（逾期徽标、侧栏红点）都刷新', async () => {
    const s = await stale({ kind: 'object', id: 'obj_a' })
    expect(s).toEqual(expect.arrayContaining([
      'taskList', 'overdueList', 'todayList', 'projectTab', 'projectOptions',
      'detail', 'progress', 'revisions', 'taskCounts', 'menuCounts', 'stakeholders',
    ]))
    // 和对象无关的不动
    for (const n of ['types', 'dictItems', 'artifacts', 'artifactStats', 'runs', 'run', 'workdir', 'plugins'] as Name[]) expect(s).not.toContain(n)
  })

  it('只记进展：刷这个对象的进展、修订和对象本身，不刷列表和计数', async () => {
    expect(await stale({ kind: 'progress', id: 'obj_a' })).toEqual(['detail', 'progress', 'revisions'])
  })

  it('登记产出物：列表和统计一起刷（删除确认里的产出物数）', async () => {
    expect(await stale({ kind: 'artifact', objectId: 'obj_a' })).toEqual(['artifacts', 'artifactStats'])
  })

  it('执行开始：这个对象的执行列表，加上对象和计数（交出去的任务改成了进行中）', async () => {
    const s = await stale({ kind: 'run-started', objectId: 'obj_a' })
    expect(s).toEqual(expect.arrayContaining(['runs', 'taskList', 'detail', 'taskCounts']))
    for (const n of ['otherRuns', 'run', 'artifacts', 'types'] as Name[]) expect(s).not.toContain(n)
  })

  it('执行收尾：执行记录、产出物、对象和计数都刷（执行里可能改了状态、登记了产出物）', async () => {
    const s = await stale({ kind: 'run-settled', objectId: 'obj_a' })
    expect(s).toEqual(expect.arrayContaining(['runs', 'otherRuns', 'run', 'artifacts', 'artifactStats', 'taskList', 'todayList', 'detail', 'taskCounts']))
    expect(s).not.toContain('types')
    expect(s).not.toContain('workdir')
  })

  it('取消执行只刷执行记录', async () => {
    expect(await stale({ kind: 'run-canceled' })).toEqual(['runs', 'otherRuns', 'run'])
  })

  it('干系人、字典、类型各刷各的', async () => {
    const st = await stale({ kind: 'stakeholder' })
    expect(st).toContain('stakeholders')
    expect(st).toContain('taskList')
    expect(st).not.toContain('taskCounts')
    expect(await stale({ kind: 'dictionary' })).toEqual(['dictItems'])
    expect(await stale({ kind: 'object-type' })).toEqual(['taskCounts', 'menuCounts', 'types'])
  })

  it('插件装卸、启停：刷插件列表和对象类型，不动对象和计数', async () => {
    expect(await stale({ kind: 'plugin' })).toEqual(['types', 'plugins'])
  })

  it('会话新建、改名、删除：刷会话列表和产出物（删除后产出物的 session_id 置空），不动消息、对象和服务商', async () => {
    expect(await stale({ kind: 'agent-session' })).toEqual(['artifacts', 'artifactStats', 'agentSessions'])
  })

  it('一轮对话收尾：刷这个会话的消息、会话列表、产出物，以及对象和计数（工具可能建了任务）', async () => {
    const s = await stale({ kind: 'agent-chat', sessionId: 'ags_a' })
    expect(s).toEqual(expect.arrayContaining(['agentMessages', 'agentSessions', 'artifacts', 'artifactStats', 'taskList', 'detail', 'taskCounts']))
    for (const n of ['otherMessages', 'agentProviders', 'types', 'workdir', 'plugins'] as Name[]) expect(s).not.toContain(n)
  })

  it('每种改动都有规则', () => {
    const all: Change[] = [
      { kind: 'object' }, { kind: 'progress', id: 'x' }, { kind: 'artifact' }, { kind: 'run-started', objectId: 'x' },
      { kind: 'run-settled', objectId: 'x' }, { kind: 'run-canceled' }, { kind: 'stakeholder' }, { kind: 'dictionary' },
      { kind: 'object-type' }, { kind: 'plugin' }, { kind: 'agent-session' }, { kind: 'agent-chat', sessionId: 'x' },
    ]
    for (const c of all) expect(invalidationsFor(c).length).toBeGreaterThan(0)
  })
})

describe('缓存键', () => {
  it('过滤条件归一：字段顺序、空值不影响键', () => {
    expect(dataKeys.objects.list({ q: '', type: ['task'], overdue: false, tag: [] }))
      .toEqual(dataKeys.objects.list({ type: ['task'] }))
    expect(normFilter({ b: 1, a: 'x', c: undefined })).toEqual({ a: 'x', b: 1 })
    expect(Object.keys(normFilter({ b: 1, a: 'x' }))).toEqual(['a', 'b'])
  })

  it('整份和单页分开缓存，都在对象列表前缀下', () => {
    const page = dataKeys.objects.list({ type: ['task'] })
    const all = dataKeys.objects.listAll({ type: ['task'] })
    expect(page).not.toEqual(all)
    expect(page.slice(0, 2)).toEqual(dataKeys.objects.lists)
    expect(all.slice(0, 2)).toEqual(dataKeys.objects.lists)
  })

  it('计数：全局和收窄到类型的分开，都在 counts 前缀下', () => {
    expect(dataKeys.counts.of()).not.toEqual(dataKeys.counts.of('task'))
    expect(dataKeys.counts.of('task')[0]).toBe(dataKeys.counts.all[0])
  })
})

describe('今日聚合的失效（TODAY-02）', () => {
  const keys = {
    today: todayKeys.of(),
    todayTask: todayKeys.of('task'),
    schedules: todayKeys.schedules,
  } satisfies Record<string, QueryKey>
  async function staleToday(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('对象一改（含改状态、验收通过、执行收尾、对话收尾）：今日整体刷新，点完成后该行直接消失', async () => {
    for (const c of [{ kind: 'object', id: 'obj_a' }, { kind: 'run-settled', objectId: 'obj_a' }, { kind: 'agent-chat', sessionId: 'ags_a' }] as Change[]) {
      expect(await staleToday(c)).toEqual(['today', 'todayTask', 'schedules'])
    }
  })

  it('执行开始：「正在运行」要多一行，刷两份聚合，不刷定时任务', async () => {
    expect(await staleToday({ kind: 'run-started', objectId: 'obj_a' })).toEqual(['today', 'todayTask'])
  })

  it('插件启停：插件贡献的卡片跟着出现或消失', async () => {
    expect(await staleToday({ kind: 'plugin' })).toEqual(['today', 'todayTask', 'schedules'])
  })

  it('只记进展、产出物、字典不动今日', async () => {
    for (const c of [{ kind: 'progress', id: 'obj_a' }, { kind: 'artifact' }, { kind: 'dictionary' }] as Change[]) {
      expect(await staleToday(c)).toEqual([])
    }
  })
})

describe('定时任务的失效（TASK-04a）', () => {
  const keys = {
    schedules: todayKeys.schedules,
    today: todayKeys.of(),
    runs: dataKeys.schedules.runs('sch_a', 50),
    lastRun: dataKeys.schedules.runs('sch_a', 1),
    otherRuns: dataKeys.schedules.runs('sch_b', 50),
    preview: dataKeys.schedules.preview({ freq: 'daily', time: '09:00' }, 3),
    taskList: dataKeys.objects.listAll({ type: ['task'] }),
    taskCounts: dataKeys.counts.of('task'),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('新建、编辑、启停、删除：刷列表（今日同一份）和它自己的执行记录，不动任务和预览', async () => {
    expect(await stale({ kind: 'schedule', id: 'sch_a' })).toEqual(['schedules', 'runs', 'lastRun'])
  })

  it('不知道是哪一个时刷全部定时任务的缓存', async () => {
    expect(await stale({ kind: 'schedule' })).toEqual(['schedules', 'runs', 'lastRun', 'otherRuns', 'preview'])
  })

  it('立即执行：它的执行记录和「上次」多一条，建出的任务进任务列表、计数和今日', async () => {
    expect(await stale({ kind: 'schedule-run', id: 'sch_a' })).toEqual(['schedules', 'today', 'runs', 'lastRun', 'taskList', 'taskCounts'])
  })

  it('对象改动不动定时任务的执行记录', async () => {
    expect(await stale({ kind: 'object', id: 'obj_a' })).toEqual(['schedules', 'today', 'taskList', 'taskCounts'])
  })
})

describe('工作台的失效（CORE-10b）', () => {
  const keys = {
    workspaces: dataKeys.workspaces.list,
    templates: dataKeys.workspaces.templates,
    taskList: dataKeys.objects.listAll({ type: ['task'] }),
    taskCounts: dataKeys.counts.of('task'),
    today: todayKeys.of(),
    plugins: dataKeys.plugins.list,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('新建、修改、删除工作台只刷工作台列表：切工作台只换菜单，任务列表、计数、今日都不动', async () => {
    expect(await stale({ kind: 'workspace' })).toEqual(['workspaces'])
  })

  it('对象、插件改动不动工作台', async () => {
    for (const c of [{ kind: 'object', id: 'obj_a' }, { kind: 'plugin' }] as Change[]) {
      const s = await stale(c)
      expect(s).not.toContain('workspaces')
      expect(s).not.toContain('templates')
    }
  })
})

describe('文档页的失效（DOC-01b）', () => {
  const keys = {
    docs: dataKeys.objects.listAll({ type: ['doc'] }),
    categories: dataKeys.categories.tree('doc'),
    tags: dataKeys.tags.list,
    dirs: dataKeys.localDirs.list,
    files: dataKeys.localDirs.files('dir_a'),
    read: dataKeys.localDirs.read('/tmp/a/x.md'),
    taskList: dataKeys.objects.listAll({ type: ['task'] }),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('对象改动（含星标）：文档列表、分类树数量、标签引用数都刷，挂载目录不动', async () => {
    expect(await stale({ kind: 'object', id: 'obj_a' })).toEqual(['docs', 'categories', 'tags', 'taskList'])
  })

  it('挂载、移除、刷新本地目录：只刷挂载列表、文件清单和读过的文件', async () => {
    expect(await stale({ kind: 'local-dir' })).toEqual(['dirs', 'files', 'read'])
  })
})

describe('额外可浏览目录的失效（FS-01）', () => {
  it('加、删额外根：起跳点、目录列表和根清单都刷，挂载目录不动', async () => {
    const keys = { roots: dataKeys.fs.roots, shortcuts: dataKeys.fs.shortcuts, browse: dataKeys.fs.browse('/opt'), dirs: dataKeys.localDirs.all }
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, { kind: 'fs-root' })
    expect(Object.entries(keys).filter(([, k]) => qc.getQueryState(k)?.isInvalidated).map(([n]) => n)).toEqual(['roots', 'shortcuts', 'browse'])
  })
})

describe('Webhook 的失效（TASK-04b）', () => {
  const keys = {
    hooks: dataKeys.webhooks.list,
    deliveries: dataKeys.webhooks.deliveries('wh_a', 200),
    lastDelivery: dataKeys.webhooks.deliveries('wh_a', 1),
    usage: dataKeys.webhooks.usage('wh_a'),
    otherDeliveries: dataKeys.webhooks.deliveries('wh_b', 1),
    sourceList: dataKeys.objects.listAll({ type: ['task'], source: ['webhook'] }),
    sourceCount: dataKeys.objects.list({ type: ['task'], source: ['webhook'], limit: 1 }),
    taskCounts: dataKeys.counts.of('task'),
    today: todayKeys.of(),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('新建、编辑、启停、轮换、删除：刷列表和它自己的投递记录、影响，不动任务', async () => {
    expect(await stale({ kind: 'webhook', id: 'wh_a' })).toEqual(['hooks', 'deliveries', 'lastDelivery', 'usage'])
  })

  it('不知道是哪一个时刷全部 Webhook 的缓存', async () => {
    expect(await stale({ kind: 'webhook' })).toEqual(['hooks', 'deliveries', 'lastDelivery', 'usage', 'otherDeliveries'])
  })

  it('推了一次：它的投递记录和「建了任务」变，建出的任务进来源视图、计数和今日', async () => {
    expect(await stale({ kind: 'webhook-delivery', id: 'wh_a' }))
      .toEqual(['deliveries', 'lastDelivery', 'usage', 'sourceList', 'sourceCount', 'taskCounts', 'today'])
  })

  it('对象改动不动 Webhook 的缓存', async () => {
    expect(await stale({ kind: 'object', id: 'obj_a' })).toEqual(['sourceList', 'sourceCount', 'taskCounts', 'today'])
  })
})

describe('模型服务商的失效（MP-01b）', () => {
  const keys = {
    providers: agentKeys.providers,
    models: agentKeys.models('apv_a'),
    sessions: agentKeys.sessions.unscoped,
    taskList: dataKeys.objects.listAll({ type: ['task'] }),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('新建、编辑、设默认、删除：刷服务商列表和各自的模型列表，不动会话和对象', async () => {
    expect(await stale({ kind: 'agent-provider' })).toEqual(['providers', 'models'])
  })

  it('会话改动不动服务商', async () => {
    expect(await stale({ kind: 'agent-session' })).toEqual(['sessions'])
  })
})

describe('联系人的失效（CT-03a）', () => {
  const keys = {
    contacts: dataKeys.contacts.list,
    stakeholders: dataKeys.stakeholders.list(),
    types: dataKeys.objectTypes,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('联系人和干系人是同一张名册：改星标、改资料一起刷', async () => {
    expect(await stale({ kind: 'stakeholder' })).toEqual(['contacts', 'stakeholders'])
  })

  it('对象改动带来任务数变化，联系人列表也跟着刷', async () => {
    expect(await stale({ kind: 'object', id: 'obj_a' })).toEqual(['contacts', 'stakeholders'])
  })
})

describe('IM 身份的失效（CT-03b）', () => {
  const keys = {
    identities: dataKeys.identities.list,
    contacts: dataKeys.contacts.list,
    types: dataKeys.objectTypes,
    msgs: dataKeys.im.list,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('身份增删改刷身份列表和 IM 消息（发信人按身份认），联系人资料不动', async () => {
    expect(await stale({ kind: 'im-identity' })).toEqual(['identities', 'msgs'])
  })

  it('改联系人资料不动身份', async () => {
    expect(await stale({ kind: 'stakeholder' })).toEqual(['contacts'])
  })
})

describe('项目干系人的失效（PJ-01d）', () => {
  const keys = {
    mine: dataKeys.projectStakeholders('obj_p1'),
    other: dataKeys.projectStakeholders('obj_p2'),
    contacts: dataKeys.contacts.list,
    tasks: dataKeys.objects.listAll({ type: ['task'], project: 'obj_p1' }),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('加人、移除只刷这个项目的干系人', async () => {
    expect(await stale({ kind: 'project-stakeholder', projectId: 'obj_p1' })).toEqual(['mine'])
  })

  it('改联系人资料、删联系人时各项目的干系人一起刷', async () => {
    expect(await stale({ kind: 'stakeholder' })).toEqual(['mine', 'other', 'contacts', 'tasks'])
  })
})

describe('连接器的失效（CONN-01d）', () => {
  const keys = {
    list: dataKeys.connectors.list,
    defs: dataKeys.connectors.defs,
    providers: agentKeys.providers,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('实例的增删改只刷实例列表，定义不动', async () => {
    expect(await stale({ kind: 'connector' })).toEqual(['list'])
  })

  it('改模型服务商不动连接器', async () => {
    expect(await stale({ kind: 'agent-provider' })).toEqual(['providers'])
  })
})

describe('项目资料的失效（PJ-03b）', () => {
  const keys = {
    mine: dataKeys.projectMaterials('obj_p1'),
    other: dataKeys.projectMaterials('obj_p2'),
    stakes: dataKeys.projectStakeholders('obj_p1'),
    objects: dataKeys.objects.detail('obj_p1'),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('加、改、移除只刷这个项目的资料', async () => {
    expect(await stale({ kind: 'project-material', projectId: 'obj_p1' })).toEqual(['mine'])
  })

  it('改对象、干系人不动资料', async () => {
    expect(await stale({ kind: 'object' })).toEqual(['stakes', 'objects'])
    expect(await stale({ kind: 'stakeholder' })).toEqual(['stakes', 'objects'])
  })
})

describe('IM 消息的失效（IM-02b）', () => {
  const keys = {
    list: dataKeys.im.list,
    one: dataKeys.im.detail('msg_1'),
    objects: dataKeys.objects.detail('obj_t1'),
    contacts: dataKeys.contacts.list,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('处理动作刷消息列表和单条，不动对象和联系人', async () => {
    expect(await stale({ kind: 'im-message', id: 'msg_1' })).toEqual(['list', 'one'])
  })

  it('改对象不动消息', async () => {
    expect(await stale({ kind: 'object' })).toEqual(['objects', 'contacts'])
  })
})

describe('项目会话绑定的失效（PJ-02b）', () => {
  const keys = {
    mine: dataKeys.projectConversations('obj_p1'),
    other: dataKeys.projectConversations('obj_p2'),
    msgs: dataKeys.im.conversation('cv_1'),
    convs: dataKeys.conversations.list,
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('绑定、解绑只刷这个项目的绑定和会话表（绑私聊可能新建会话），不动消息', async () => {
    expect(await stale({ kind: 'project-conversation', projectId: 'obj_p1' })).toEqual(['mine', 'convs'])
  })

  it('消息一变，按会话取的消息和会话表也刷（收消息会登记新会话）', async () => {
    expect(await stale({ kind: 'im-message' })).toEqual(['msgs', 'convs'])
  })
})

describe('项目原型的失效（PJ-04b）', () => {
  const keys = {
    list: dataKeys.projectPrototypes.list('obj_p1'),
    logs: dataKeys.projectPrototypes.logs('obj_p1', 'pt_1'),
    other: dataKeys.projectPrototypes.list('obj_p2'),
    mats: dataKeys.projectMaterials('obj_p1'),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('启停、增删改刷这个项目的原型列表和日志', async () => {
    expect(await stale({ kind: 'project-prototype', projectId: 'obj_p1' })).toEqual(['list', 'logs'])
  })

  it('改对象、资料不动原型', async () => {
    expect(await stale({ kind: 'object' })).toEqual([])
    expect(await stale({ kind: 'project-material', projectId: 'obj_p1' })).toEqual(['mats'])
  })
})

describe('运行异常的失效（INC-01b）', () => {
  it('改状态只刷异常列表；转任务连任务列表、计数、今日一起刷', () => {
    expect(invalidationsFor({ kind: 'incident', id: 'inc_1' })).toEqual([dataKeys.incidents.all])
    const t = invalidationsFor({ kind: 'incident-task', id: 'inc_1' })
    expect(t).toContainEqual(dataKeys.incidents.all)
    expect(t).toContainEqual(dataKeys.objects.all)
    expect(t).toContainEqual(dataKeys.counts.all)
    expect(t).toContainEqual(todayKeys.all)
  })
})
