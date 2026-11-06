// 编排页的取数（SPEC-sop-8）：节点目录、要编辑的流程、子流程 / Agent / 知识库 / 文档分类 / 模型服务商 / 项目的下拉选项、触发方式，都回来了才渲染编辑器。
// 触发方式：字典里有 sop_trigger 就用，没有就用内置的三种（手动、IM 消息、定时），都存 key；旧流程存的文字照原样列出（NodePanel）。
// 定时只有一项（TSK-0463）：字典里旧的 daily、weekly、cron 不列，没有 schedule 时补一项「定时」，不会出现两个定时；时间规则在开始节点里配。
// 字典列表带条目一起取，不直接取 sop_trigger 的条目，免得没有这本字典时控制台报 404
import { useMemo } from 'react'
import {
  QueryState, isApiError, useAgentProviders, useAgents, useCategoryTree, useDictionaries, useKnowledgeBases, useProjects, useRunPresets, useSopFlow, useSopNodeTypes, type Category,
  type SopFlow, type SopRunBrief,
} from '../../core/data'
import { useSopNodeViews } from '../../core/plugin'
import { Button, EmptyState, LoadingState } from '../../core/ui'
import { catalogOf, newDraft } from './edit'
import { draftScheduleOf, triggerOptionsOf } from './schedule'
import { emptyIM, imDraftOf, imFlowsOf, imOf } from './imtrigger'
import { Editor } from './Editor'
import type { TriggerOption } from './NodePanel'
import type { FieldCtx } from './nodes'

const flat = (list: readonly Category[] | undefined, depth = 0): { id: string; name: string }[] =>
  (list ?? []).flatMap((c) => [{ id: c.id, name: `${'　'.repeat(depth)}${c.name}` }, ...flat(c.children, depth + 1)])

export function EditPage({ id, flows, runs, onCancel, onSaved }: {
  /** 编辑已有流程时有 */
  id?: string
  flows: readonly SopFlow[]
  runs: readonly SopRunBrief[]
  onCancel: () => void
  onSaved: (f: SopFlow, thenRun: boolean) => void
}) {
  const types = useSopNodeTypes()
  const flow = useSopFlow(id ?? null)
  const dicts = useDictionaries({ withItems: true })
  const agents = useAgents()
  const providers = useAgentProviders()
  const kbs = useKnowledgeBases()
  const cats = useCategoryTree('doc')
  // 建任务、写进项目目录的项目下拉
  const projects = useProjects()
  // Claude Code 节点选角色（AUTO-01）
  const presets = useRunPresets()

  // 插件登记、撤掉节点展示时目录换新，节点选择器和画布跟着重画（SOP-03b）
  const views = useSopNodeViews()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const catalog = useMemo(() => catalogOf(types.data), [types.data, views])
  const ctx = useMemo<FieldCtx>(() => ({
    flows: flows.map((f) => ({ id: f.id, name: f.name })),
    agents: (agents.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    kbs: (kbs.data ?? []).map((k) => ({ id: k.id, name: k.name })),
    docCats: flat(cats.data),
    providers: providers.data ?? [],
    projects: (projects.data?.data ?? []).filter((p) => !p.deleted_at).map((p) => ({ id: p.id, name: p.title })),
    presets: (presets.data ?? []).map((p) => ({ id: p.id, scene: p.scene, permission: p.permission })),
    imFlows: imFlowsOf(flows).map((f) => ({ id: f.id, name: f.name, order: imOf(f).order, stop: imOf(f).stop })),
  }), [flows, agents.data, kbs.data, cats.data, providers.data, projects.data, presets.data])
  const triggers = useMemo<TriggerOption[]>(() => {
    const items = dicts.data?.find((d) => d.id === 'sop_trigger')?.items ?? []
    const live = items.filter((x) => !x.archived_at || x.key === flow.data?.trigger)
    return triggerOptionsOf(live)
  }, [dicts.data, flow.data?.trigger])

  if (id && flow.isError && isApiError(flow.error, 'not_found')) {
    return (
      <div className="sop-page">
        <EmptyState title="这个 SOP 已经删除" action={<Button onClick={onCancel}>返回</Button>} />
      </div>
    )
  }
  // 等字典有结果（成功或失败）再定新建草稿的触发方式
  if (dicts.isPending) return <LoadingState />
  return (
    <QueryState query={types} errorTitle="节点类型没取到">
      {() => id ? (
        <QueryState query={flow} errorTitle="流程没取到">
          {(f) => (
            <Editor key={f.id} initial={{ id: f.id, name: f.name, desc: f.desc, ...draftScheduleOf(f), im: imDraftOf(f), fields: f.fields, steps: f.steps, layout: f.layout }}
              flowId={f.id} version={f.version} hasSchedule={!!f.schedule} catalog={catalog} ctx={ctx} triggers={triggers} runs={runs} onCancel={onCancel} onSaved={onSaved} />
          )}
        </QueryState>
      ) : (
        <Editor initial={{ ...newDraft(triggers[0].value), im: emptyIM() }} catalog={catalog} ctx={ctx} triggers={triggers} runs={runs} onCancel={onCancel} onSaved={onSaved} />
      )}
    </QueryState>
  )
}
