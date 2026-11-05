package runner

import (
	"strings"
	"text/template"
)

// agentPromptTemplate 是交给工作台 Agent 执行（harness=agent，TSK-0460）时的第一条消息。
//
// 和 promptTemplate（交给 Claude Code）分开写：两边能用的手段完全不同。Claude Code 在工作目录里改文件、跑命令；
// 工作台 Agent 手里是工作台的工具（读对象、记进展、改状态、建子任务、按授权写文件），而且这次没人在旁边答问题。
// 任务内容（标题、验收标准、正文、所属项目、角色、补充说明）和 Claude Code 那份同源（Task），只是说法换成工具的说法。
//
// 几条刻意的取舍：
//   - 写明「不能向用户提问」：无人值守执行不给 ask_user，拿不准的写进结论，而不是停在半路等一个不会来的回答。
//   - 写明「要确认的写操作会停下」：模型知道它提出的调用可能被拒，拒了就换办法或收尾，不要反复提同一个。
//   - 结论放最后一段：执行结束时工作台把这段记成任务进展，所以要能脱离上下文单独读懂。
const agentPromptTemplate = `{{if .Resume}}接着上次的执行继续处理这条任务。先用 get_object 看看任务现在的状态和最近的进展，从没做完的地方接着做。
{{else}}这条任务从「产品工作台」交给你执行。你手里是工作台的工具：读任务和关联对象、搜知识库、记进展、改状态和字段、建子任务、按授权写文件、发起 SOP。
{{end}}
## 任务
{{if .Ref}}编号：{{.Ref}}
{{end}}{{if .TypeName}}类型：{{.TypeName}}
{{end}}标题：{{.Title}}
{{if .Status}}状态：{{.Status}}
{{end}}{{if .Priority}}优先级：{{.Priority}}
{{end}}{{if .DueAt}}到期：{{.DueAt}}
{{end}}{{if .Repo}}关联仓库：{{.Repo}}
{{end}}{{if .Links}}关联：
{{range .Links}}  - {{.}}
{{end}}{{end}}
{{if .Body}}## 任务描述
{{.Body}}

{{end}}{{if .Acceptance}}## 验收标准
{{.Acceptance}}

{{end}}{{with .Project}}## 所属项目
名称：{{.Name}}{{if .Ref}}（{{.Ref}}）{{end}}
{{if .DocsDir}}文档目录：{{.DocsDir}}
{{end}}
{{end}}{{with .Preset}}## 执行要求{{if .Scene}}（{{.Scene}}）{{end}}
{{.Content}}
{{if .ReadOnly}}
这个角色只读：这次只给你开了读的工具，不要尝试改任何东西，结论写在回复里。
{{end}}{{if .Output}}
输出要求：
{{.Output}}
{{end}}
{{end}}{{if .Extra}}## 本次执行的补充要求
{{.Extra}}

{{end}}## 怎么做
- 先用 get_object 读这条任务（{{if .Ref}}{{.Ref}}{{else}}按上面的标题{{end}}），关联的对象需要时也读一下，别只凭标题干活。
- 做完一个关键步骤用 append_progress 给这条任务记一句进展；需要拆子任务时用 create_object 并带 parent_ref={{if .Ref}}{{.Ref}}{{else}}这条任务的编号{{end}}。
- 任务真的做完了，用 update_object 把状态改成完成；没做完不要改。
- 这次没有人在旁边回答问题：不能向用户提问，拿不准的地方写进结论里。
- 有些写操作要用户确认，提出后会停下等；被拒绝了就不要再提同样的操作，换别的办法或者收尾。
{{if .Workdir}}- write_file 写进 {{.Workdir}}，只用相对路径。
{{end}}
## 结束时
最后用一段话写结论：做了什么、改了哪些对象、产出在哪、还剩什么没做。这段会原样记成这条任务的进展，要能单独读懂。
`

var agentPromptTmpl = template.Must(template.New("agent-run-prompt").Parse(agentPromptTemplate))

// AgentTask 是交给工作台 Agent 的任务快照：和交给 Claude Code 的同一份内容，多一个「是不是续跑」。
type AgentTask struct {
	Task
	Resume bool
}

// BuildAgentPrompt 把任务渲染成交给工作台 Agent 的第一条消息，清理规则同 BuildPrompt。
func BuildAgentPrompt(t AgentTask) string {
	t.Title = strings.TrimSpace(t.Title)
	t.Body = strings.TrimSpace(t.Body)
	t.Extra = strings.TrimSpace(t.Extra)
	if t.Preset != nil {
		p := *t.Preset
		p.Content = strings.TrimSpace(p.Content)
		p.Output = strings.TrimSpace(p.Output)
		t.Preset = &p
		if p.Content == "" && !p.ReadOnly {
			t.Preset = nil
		}
	}
	t.Acceptance = strings.TrimSpace(t.Acceptance)
	t.Repo = strings.TrimSpace(t.Repo)

	var sb strings.Builder
	if err := agentPromptTmpl.Execute(&sb, t); err != nil {
		return "请处理任务：" + t.Title
	}
	return sb.String()
}
