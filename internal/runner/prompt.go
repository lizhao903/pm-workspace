package runner

import (
	"strings"
	"text/template"
)

// Task 是要交给 claude 的工作对象快照。字段留空就会从提示词里整行消失——
// 空着的「优先级：」只会让模型去猜一个并不存在的约束。
type Task struct {
	Ref      string   // TSK-0042
	TypeName string   // 待办 / 需求 …
	Title    string   // 必填
	Body     string   // 正文，可能是一大段 Markdown
	Status   string   // 状态标签（不是 key）
	Priority string   // 优先级标签
	DueAt    string   // 已格式化的日期，空表示没有到期日
	Links    []string // 关联对象的标题，给模型一点上下文
	Workdir  string   // 它将要工作的目录
	Extra    string   // 用户在发起时补的一句话，优先级最高
	// Acceptance 是验收标准（props.acceptance），Repo 是关联仓库（props.repo）。
	// 验收标准单独成节而不是混进正文：它是「做到什么程度算完」，模型要逐条对照。
	Acceptance string
	Repo       string
	// Project 是任务所属的项目（任务挂在项目下才有）：告诉模型文档、原型各在哪里操作。
	Project *Project
	// WriteBack 不为 nil 表示这次是在终端里交互执行，要模型经工作台 MCP 自己回写（0048）。
	WriteBack *WriteBack
}

// Project 是所属项目的上下文。DocsDir 取项目 props.related 的第一个关联目录，
// Prototypes 是项目「原型」里登记的目录；都没有时提示词写明可在项目设置里补，
// 不让模型自己猜一个位置。
type Project struct {
	Name       string
	Ref        string
	Workdir    string // 项目的工作目录，没设为空
	DocsDir    string
	DocsLabel  string
	Prototypes []PrototypeDir
}

// PrototypeDir 是项目登记的一个原型。
type PrototypeDir struct {
	Name string
	Dir  string
}

// WriteBack 是终端执行的回写信息。RunID 在预览时还没有，用占位文字。
type WriteBack struct {
	RunID    string
	ObjectID string
}

// promptTemplate 是喂给 claude 的任务描述。
//
// 单独抽成常量而不是在函数里拼字符串：这段文字是这个功能的实际行为定义，
// 改一个词就会改变 claude 做什么。它需要能被一眼读完、被 diff 看清。
//
// 几条刻意的取舍：
//   - 先说「你在哪、做什么」，再给正文。模型的注意力在开头最集中。
//   - 只描述任务，不塞「你是一位资深工程师」这类角色扮演。用户自己的
//     ~/.claude/CLAUDE.md 才是他想要的行为基线，我们不该在上面盖一层。
//   - 明确「不要改工作区以外的文件」。claude 用的是它自己的权限策略，
//     这句是提示而非强制，但便宜且有用。
//   - 结尾要求它讲清做了什么。这次执行的价值在过程，用户事后要能复查。
const promptTemplate = `你正在协助处理一个来自「产品工作台」的工作对象。请在当前目录（{{.Workdir}}）内完成它。

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
{{if .Workdir}}项目工作目录：{{.Workdir}}
{{end}}{{if .DocsDir}}文档在哪里操作：{{.DocsDir}}{{if .DocsLabel}}（项目关联目录「{{.DocsLabel}}」）{{end}}
{{else}}文档在哪里操作：这个项目没有关联文档目录，可在项目设置里补；需要写文档时先问用户放哪里。
{{end}}{{if .Prototypes}}原型在哪里操作：
{{range .Prototypes}}  - {{if .Name}}{{.Name}}：{{end}}{{.Dir}}
{{end}}{{else}}原型在哪里操作：这个项目没有登记原型目录，可在项目设置里补；需要改原型时先问用户在哪里改。
{{end}}
{{end}}{{if .Extra}}## 本次执行的补充要求
{{.Extra}}

{{end}}{{with .WriteBack}}## 回写到工作台
这次是从「产品工作台」交给你、在终端里交互执行的（执行记录 {{.RunID}}）。工作台的 MCP（server 名 pm-workspace）已经接上，进展和结果请用它写回这条任务，不要只在终端里说：
1. 开始时：用 pmw_update_object（id={{.ObjectID}}）把任务状态改成进行中（状态 key 用 pmw_list_types 查，任务一般是 doing；已经是进行中就不用改），再用 pmw_append_progress 记一句你打算怎么做。
2. 每产出一件交付物（文档、原型、代码提交等）：调 pmw_record_artifact，带 object_id={{.ObjectID}}、run_id={{.RunID}}。
3. 过程中做完一个关键步骤，用 pmw_append_progress 记一条。
4. 结束时（做完、做不下去、或用户让你停下）：调 pmw_finish_run，run_id={{.RunID}}，status 填 done 或 failed，summary 写结论摘要：做了什么、产出在哪、还剩什么没做。任务做完了再用 pmw_update_object 改状态。

{{end}}## 约束
{{if .Project}}- 所有产出只写在当前目录、以及上面「所属项目」里写明的文档目录和原型目录里，不要改动其他位置的文件。
{{else}}- 所有产出只写在当前目录内，不要改动工作区之外的任何文件。
{{end}}- 完成后用一段话说明你做了什么、改了哪些文件，以及还剩什么没做。
`

var promptTmpl = template.Must(template.New("run-prompt").Parse(promptTemplate))

// BuildPrompt 把工作对象渲染成提示词。模板是静态的、字段来自库里的数据，
// 渲染不会失败；真出错也不能让整次执行卡住，退回一段最小可用的描述。
func BuildPrompt(t Task) string {
	t.Title = strings.TrimSpace(t.Title)
	t.Body = strings.TrimSpace(t.Body)
	t.Extra = strings.TrimSpace(t.Extra)
	t.Acceptance = strings.TrimSpace(t.Acceptance)
	t.Repo = strings.TrimSpace(t.Repo)

	var sb strings.Builder
	if err := promptTmpl.Execute(&sb, t); err != nil {
		return "请完成以下任务：" + t.Title
	}
	return sb.String()
}
