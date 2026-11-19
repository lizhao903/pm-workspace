// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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
	// Preset 是发起时选的预置提示词（SPEC-tasks-6.18），按角色场景录在设置里；没选为 nil。
	Preset *Preset
	// Source 是任务来自哪条 IM 消息（IM 转任务时有）：模型要知道是谁、为什么提的，结论会回复给对方。
	Source *Source
	// Acceptance 是验收标准（props.acceptance），Repo 是关联仓库（props.repo）。
	// 验收标准单独成节而不是混进正文：它是「做到什么程度算完」，模型要逐条对照。
	Acceptance string
	Repo       string
	// Project 是任务所属的项目（任务挂在项目下，或没挂但工作目录在某个项目的目录里）：告诉模型文档、原型各在哪里操作。
	Project *Project
	// WriteBack 不为 nil 表示要模型经工作台 MCP 自己回写：终端交互执行（0048），
	// 以及后台执行（TSK-0499，Stream 为真）。
	WriteBack *WriteBack
}

// Preset 是一个角色（SPEC-settings-24）：场景名、执行要求、权限和输出要求。
// ReadOnly 为真时提示词写明不改文件，流式执行也不放开文件编辑（api 层据此改 AllowWrites）；
// Output 是对输出的要求（如结束时用 pmw_finish_run 回报的 result 结构），拼在执行要求后面。
// DirKind 是默认在项目档案的哪个目录跑（code / prototype / prd / any），AUTO-04 落地前只存不用。
type Preset struct {
	Scene    string
	Content  string
	ReadOnly bool
	Output   string
	DirKind  string
}

// Source 是任务的来源 IM 消息。Reply 为真表示执行完成后工作台会回复原消息（IM 转任务时建的回执 SOP）。
type Source struct {
	Channel      string
	Conversation string
	Sender       string
	Text         string
	Reply        bool
	// ThreadParent 是这条消息是消息列（串）里的回复时，串的父消息（IM 0.32.0 转任务时写进 source_ref.thread_parent）；
	// 不是回复为 nil。提示词把它写在回复前面，执行方才知道原始诉求
	ThreadParent *SourceParent
}

// SourceParent 是串的父消息：Partial 为真时 Text 只是 80 字摘要。
type SourceParent struct {
	Sender  string
	Text    string
	Partial bool
}

// Project 是所属项目的上下文。DocsDir 取项目设置里的文档目录（DocsSetting 为 true，TSK-0718），
// 没设时取 props.related 的第一个关联目录（DocsLabel 是它的名称），
// Prototypes 是项目档案的原型库和项目「原型」里登记的目录（各带规则）；都没有时提示词写明可在项目设置里补，
// 不让模型自己猜一个位置。
type Project struct {
	Name      string
	Ref       string
	Workdir   string // 项目的工作目录，没设为空
	DocsDir   string
	DocsLabel string
	// DocsSetting 为 true 表示 DocsDir 来自项目设置里的文档目录
	DocsSetting bool
	Prototypes  []PrototypeDir
	// ByWorkdir 为真表示任务本身没挂项目，是按这次的工作目录认定的（TSK-0841 复盘）：
	// 工作目录等于或位于 MatchedDir（MatchedLabel 说是项目的哪种目录）之下。提示词里写明，免得模型以为任务挂在这个项目下。
	ByWorkdir    bool
	MatchedDir   string
	MatchedLabel string
}

// PrototypeDir 是项目的一个原型（档案的原型库或「原型」里登记的）。
// Rules 是在它上面改时要守的规则（多行，可空），渲染在这个原型下面、缩进成「规则：」块。
type PrototypeDir struct {
	Name  string
	Dir   string
	Rules string
}

// RuleLines 是规则按行拆开、去掉首尾空行后的结果，给模板逐行缩进用；没有规则回 nil。
func (p PrototypeDir) RuleLines() []string {
	r := strings.TrimSpace(strings.ReplaceAll(p.Rules, "\r\n", "\n"))
	if r == "" {
		return nil
	}
	lines := strings.Split(r, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r")
	}
	return lines
}

// HasProtoRules：有任何一个原型写了规则。约束里据此加一句「改原型必须遵守原型的规则」。
func (p *Project) HasProtoRules() bool {
	if p == nil {
		return false
	}
	for _, x := range p.Prototypes {
		if x.RuleLines() != nil {
			return true
		}
	}
	return false
}

// WriteBack 是回写信息。RunID 在预览时还没有，用占位文字。
//
// Stream 为真是后台执行（claude -p，没人值守）：工作台已把状态改成进行中、进程结束时自己收尾，
// pmw_finish_run 只是把结论交给工作台放在执行记录最前面。NoMCP 非空表示这次没接上工作台 MCP
// （没配 MCP 程序或地址），写明原因、让模型把结论写在回复里，不去调一个不存在的工具。
type WriteBack struct {
	RunID    string
	ObjectID string
	Stream   bool
	NoMCP    string
	// DSH 为真是交给 DeepSeek（dsh）的后台执行（TSK-0722）：没有命令白名单，命令都在 dsh 的沙箱里跑，
	// 最后那段权限说明换成沙箱的说法。
	DSH bool
	// ProjectAllow 是这次合进 --allowedTools 的项目执行白名单（项目档案 run_allow，TSK-0837，ProjectAllowFor 之后的），
	// 提示词里列出来：模型知道哪些项目脚本能直接跑，用户在预览里也看得到规则从哪来。只有交给 Claude Code 的后台执行有。
	ProjectAllow []string
}

// MCPServerName 给模板用：工作台注入的 MCP server 名。
func (WriteBack) MCPServerName() string { return MCPServer }

// ProjectAllowText 给模板用：项目执行白名单逐条加反引号、顿号连起来。
func (w WriteBack) ProjectAllowText() string {
	q := make([]string, len(w.ProjectAllow))
	for i, r := range w.ProjectAllow {
		q[i] = "`" + r + "`"
	}
	return strings.Join(q, "、")
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
{{if .ByWorkdir}}按工作目录认定为项目「{{.Name}}」（任务本身没挂项目）：工作目录在{{if .MatchedLabel}}{{.MatchedLabel}} {{end}}{{.MatchedDir}} 下。
{{end}}{{if .Workdir}}项目工作目录：{{.Workdir}}
{{end}}{{if .DocsDir}}文档在哪里操作：{{.DocsDir}}{{if .DocsSetting}}（项目设置里的文档目录）{{else if .DocsLabel}}（项目关联目录「{{.DocsLabel}}」）{{end}}
{{else}}文档在哪里操作：这个项目没有设文档目录，可在项目设置里补；需要写文档时先问用户放哪里。
{{end}}{{if .Prototypes}}原型在哪里操作：
{{range .Prototypes}}  - {{if .Name}}{{.Name}}：{{end}}{{.Dir}}
{{with .RuleLines}}    规则：
{{range .}}{{if .}}      {{.}}{{end}}
{{end}}{{end}}{{end}}{{else}}原型在哪里操作：这个项目没有登记原型目录，可在项目设置里补；需要改原型时先问用户在哪里改。
{{end}}
{{end}}{{with .Source}}## 来源消息
{{with .ThreadParent}}这条任务来自消息列里的一条回复。消息列的原消息{{if .Sender}}（{{.Sender}}）{{end}}{{if .Partial}}（只有摘要，全文没取到）{{end}}：
{{.Text}}

回复：
{{end}}这条任务来自 {{if .Channel}}{{.Channel}} {{end}}{{if .Conversation}}「{{.Conversation}}」里{{end}}{{if .Sender}} {{.Sender}} {{end}}的消息：
{{.Text}}
{{if .Reply}}执行结束后，工作台会把这次执行的结论回复到这条消息里，结论请写成能直接发给对方看的话。
{{end}}
{{end}}{{with .Preset}}## 执行要求{{if .Scene}}（{{.Scene}}）{{end}}
{{.Content}}
{{if .ReadOnly}}
这个角色只读：不要创建、修改或删除任何文件，结论写在回复里。
{{end}}{{if .Output}}
输出要求：
{{.Output}}
{{end}}
{{end}}{{if .Extra}}## 本次执行的补充要求
{{.Extra}}

{{end}}{{with .WriteBack}}## 回写到工作台
{{if .Stream}}这次是从「产品工作台」交给你在后台执行的（执行记录 {{.RunID}}）：没有人在旁边确认，需要确认的操作会被直接拒绝，被拒了不要反复重试，换个办法或在结论里说明。
{{else}}这次是从「产品工作台」交给你、在终端里交互执行的（执行记录 {{.RunID}}）。
{{end}}{{if .NoMCP}}工作台的 MCP 这次没接上（{{.NoMCP}}），进展和结论直接写在最后的回复里，工作台会把它记进执行记录。
{{else}}工作台的 MCP（server 名 {{.MCPServerName}}，工具名形如 mcp__{{.MCPServerName}}__pmw_append_progress）已经接上{{if .Stream}}并放行{{end}}，进展和结果请用它写回这条任务{{if not .Stream}}，不要只在终端里说{{end}}。工作目录里如果另有名为 pm-workspace 的 MCP server，不要用它回写，它可能指向别的工作台：
{{if .Stream}}1. 开始时：工作台已经把任务改成进行中；用 pmw_get_object（id={{.ObjectID}}）读任务和验收标准，再用 pmw_append_progress 记一句你打算怎么做。
{{else}}1. 开始时：用 pmw_update_object（id={{.ObjectID}}）把任务状态改成进行中（状态 key 用 pmw_list_types 查，任务一般是 doing；已经是进行中就不用改），再用 pmw_append_progress 记一句你打算怎么做。
{{end}}2. 每产出一件交付物（文档、原型、代码提交等）：调 pmw_record_artifact，带 object_id={{.ObjectID}}、run_id={{.RunID}}。
3. 过程中做完一个关键步骤，用 pmw_append_progress 记一条。
{{if .Stream}}4. 结束前：调 pmw_finish_run，run_id={{.RunID}}，status 填 done 或 failed，summary 写结论摘要：做了什么、产出在哪、还剩什么没做。工作台在进程退出时收尾，这段结论放在执行记录最前面。
{{else}}4. 结束时（做完、做不下去、或用户让你停下）：调 pmw_finish_run，run_id={{.RunID}}，status 填 done 或 failed，summary 写结论摘要：做了什么、产出在哪、还剩什么没做。任务做完了再用 pmw_update_object 改状态。
{{end}}{{if $.Source}}读来源消息的原帖和整串回复用 pmw_get_source_message（object_id={{.ObjectID}}）{{if .Stream}}，不要用 Slack 等渠道自己的 MCP 工具（后台执行没放行，调了会被拒）{{end}}。
{{end}}{{end}}{{if .DSH}}
命令都在 dsh 的沙箱里跑：只读执行写不了任何文件；允许改文件时只能写当前目录（和软链接进来的目录）。写入被沙箱拒绝时不要反复重试，在结论里说明。
{{else if .Stream}}
只读命令（git status / log / diff、ls、cat、grep、wc、cd、echo 等，含管道组合）已放行；查 SQLite 库用 sqlite3 -readonly -safe（不带 -safe 的会被拒）。
{{if .ProjectAllow}}这个项目的执行白名单（项目档案）另放行：{{.ProjectAllowText}}。
{{end}}后台执行没人确认，命令这样写才不会被拒：路径一律写绝对路径，不用 shell 变量（C=…; cat "$C/x" 这种整条被拒）；一条命令只做一件事，不要 cd 到别处再跑 git；只读得到当前目录和软链接进来的目录。被拒了不要换个写法重试同一件事，在结论里说明缺什么权限。
{{end}}
{{end}}## 约束
{{if .Project}}- 所有产出只写在当前目录、以及上面「所属项目」里写明的文档目录和原型目录里，不要改动其他位置的文件。
{{else}}- 所有产出只写在当前目录内，不要改动工作区之外的任何文件。
{{end}}{{with .Project}}{{if .HasProtoRules}}- 改原型必须遵守上面「原型在哪里操作」里各原型的规则；规则和本任务的要求冲突时，先停下来说明冲突，不要自己挑一个做。
{{end}}{{end}}- 完成后用一段话说明你做了什么、改了哪些文件，以及还剩什么没做。
`

var promptTmpl = template.Must(template.New("run-prompt").Parse(promptTemplate))

// BuildPrompt 把工作对象渲染成提示词。模板是静态的、字段来自库里的数据，
// 渲染不会失败；真出错也不能让整次执行卡住，退回一段最小可用的描述。
func BuildPrompt(t Task) string {
	t.Title = strings.TrimSpace(t.Title)
	t.Body = strings.TrimSpace(t.Body)
	t.Extra = strings.TrimSpace(t.Extra)
	if t.Preset != nil {
		p := *t.Preset // 不改调用方传进来的那份
		t.Preset = &p
		p.Content = strings.TrimSpace(p.Content)
		p.Output = strings.TrimSpace(p.Output)
		if p.Content == "" {
			t.Preset = nil
		}
	}
	if t.Source != nil {
		t.Source.Text = strings.TrimSpace(t.Source.Text)
		if p := t.Source.ThreadParent; p != nil {
			if p.Text = strings.TrimSpace(p.Text); p.Text == "" {
				t.Source.ThreadParent = nil
			}
		}
		if t.Source.Text == "" {
			t.Source.Text = "（消息没有正文）"
		}
	}
	t.Acceptance = strings.TrimSpace(t.Acceptance)
	t.Repo = strings.TrimSpace(t.Repo)

	var sb strings.Builder
	if err := promptTmpl.Execute(&sb, t); err != nil {
		return "请完成以下任务：" + t.Title
	}
	return sb.String()
}
