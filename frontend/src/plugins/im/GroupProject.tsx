// 群组默认归属的项目：选了某个群组标签时在列表上方显示，能设、改、清除。
// 存在 IM 插件里（GET/PUT /api/im/conversation-projects），一个群最多一个默认项目；
// 群里没单独归项目的消息都算到这个项目（项目「沟通」里能看到），消息上单独设的优先。
import { errorText, useImConversationProjects, useProjects, useSetImConversationProject } from '../../core/data'
import { SearchSelect } from '../../core/ui'

export function GroupProject({ conversationId }: { conversationId: string }) {
  const defaults = useImConversationProjects()
  const projects = useProjects()
  const set = useSetImConversationProject()
  const cur = defaults.data?.get(conversationId)
  const options = (projects.data?.data ?? []).filter((p) => !p.deleted_at).map((p) => ({ value: p.id, label: p.title }))
  const change = (v: string | null) => set.mutate({ conversationId, projectId: v })
  return (
    <div className="im-group-project">
      <span className="im-muted">默认归属</span>
      <SearchSelect value={cur?.project_id ?? ''} options={options} noneLabel="不归项目" placeholder="设为项目" searchPlaceholder="搜项目"
        aria-label="群组默认归属的项目" missingLabel={() => cur?.project_name || '已删除的项目'} disabled={set.isPending || defaults.isPending}
        title="这个群里没单独归项目的消息都算到这个项目，项目「沟通」里能看到；单条消息在抽屉里另设的优先"
        emptyText={projects.isError ? '项目没加载出来' : projects.isPending ? '加载中' : '还没有项目'}
        onChange={(v) => change(v || null)} />
      {set.isError && <span className="im-err" role="alert">没改成：{errorText(set.error)}</span>}
      {defaults.isError && !set.isError && <span className="im-err" role="alert">默认项目没加载出来：{errorText(defaults.error)}</span>}
    </div>
  )
}
