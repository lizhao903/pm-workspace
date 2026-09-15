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
{{end}}{{if .Links}}关联：
{{range .Links}}  - {{.}}
{{end}}{{end}}
{{if .Body}}## 任务描述
{{.Body}}

{{end}}{{if .Extra}}## 本次执行的补充要求
{{.Extra}}

{{end}}## 约束
- 所有产出只写在当前目录内，不要改动工作区之外的任何文件。
- 完成后用一段话说明你做了什么、改了哪些文件，以及还剩什么没做。
`

var promptTmpl = template.Must(template.New("run-prompt").Parse(promptTemplate))

// BuildPrompt 把工作对象渲染成提示词。模板是静态的、字段来自库里的数据，
// 渲染不会失败；真出错也不能让整次执行卡住，退回一段最小可用的描述。
func BuildPrompt(t Task) string {
	t.Title = strings.TrimSpace(t.Title)
	t.Body = strings.TrimSpace(t.Body)
	t.Extra = strings.TrimSpace(t.Extra)

	var sb strings.Builder
	if err := promptTmpl.Execute(&sb, t); err != nil {
		return "请完成以下任务：" + t.Title
	}
	return sb.String()
}
