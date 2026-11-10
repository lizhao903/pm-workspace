// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

// 开发任务闭环的工具：领任务、记进展、提交验收、取下一个任务、拆子任务、看执行记录。
//
// 这些工具和 tools.go 里的通用工具分开放，是因为它们表达的是一条固定流程
// （领 → 做 → 记 → 交），描述里互相引用，放在一处读起来才连贯。
// 流程本身写在 .claude/commands/task.md，这里的描述只讲单个工具的契约。

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultNextLimit  = 5
	maxNextLimit      = 20
	defaultRunsLimit  = 10
	maxRunsLimit      = 100
	defaultRunOutput  = 8000
	maxRunOutput      = 200000
	maxSubtasks       = 30
	progressInGetObj  = 10
	nextTaskCandidate = 200
)

// reviewStatusKeys 是「待验收」类状态的候选 key，按优先级排。
//
// 只认 key 不认中文标签：标签是用户随手能改的显示名，key 一经创建不再变。
// 内置的 task / requirement 类型都没有这类状态（见 0002），所以默认情况下
// pmw_submit_review 会走「状态不变、只记一条验收申请」的兜底，见 resolveReviewStatus。
var reviewStatusKeys = []string{"review", "in_review", "reviewing", "verify", "verifying", "acceptance", "qa", "testing"}

func registerDevTools(s *mcp.Server, c *client) {
	addClaimTask(s, c)
	addAppendProgress(s, c)
	addSubmitReview(s, c)
	addNextTask(s, c)
	addCreateSubtasks(s, c)
	addListRuns(s, c)
	addGetRun(s, c)
	addFinishRun(s, c)
}

// resolveObject 接受 id 或 ref，返回对象本身。所有开发工具都先走这里，
// 后面拿到的一定是 id——写接口拿 ref 会直接 404。
func (c *client) resolveObject(ctx context.Context, idOrRef string) (*domain.Object, error) {
	id := strings.TrimSpace(idOrRef)
	if id == "" {
		return nil, fmt.Errorf("id 不能为空，传 obj_ 开头的 id 或 TSK-0001 这样的 ref")
	}
	if refPattern.MatchString(id) {
		if o, ok := c.resolveRef(ctx, id); ok {
			return o, nil
		}
	}
	return c.getObject(ctx, id)
}

// progressLine 是进展在 MCP 输出里的一行。
func progressLine(p *domain.Progress) string {
	head := formatDateTime(p.CreatedAt) + "  [" + p.Kind + "]"
	who := p.ActorName
	if p.SessionID != "" {
		who += " 会话 " + shortSession(p.SessionID)
	}
	parts := []string{head, truncate(p.Text, 200)}
	if len(p.Commits) > 0 {
		parts = append(parts, "commit "+strings.Join(p.Commits, ","))
	}
	if len(p.Files) > 0 {
		parts = append(parts, fmt.Sprintf("文件 %d 个", len(p.Files)))
	}
	if who != "" {
		parts = append(parts, "("+who+")")
	}
	return "  " + strings.Join(parts, "  ")
}

func shortSession(s string) string {
	if len(s) > 12 {
		return s[:12] + "…"
	}
	return s
}

// --- pmw_claim_task ---

type claimTaskArgs struct {
	ID       string `json:"id" jsonschema:"要领的任务，obj_ 开头的 id 或 TSK-0001 这样的 ref"`
	Status   string `json:"status,omitempty" jsonschema:"领取后切到的状态 key。不传取该类型的 doing；类型里没有 doing 时必须显式传，合法值用 pmw_list_types 查"`
	Note     string `json:"note,omitempty" jsonschema:"领取时记的一句话，比如打算怎么做。不传默认记「领取了任务」"`
	Takeover bool   `json:"takeover,omitempty" jsonschema:"接手别人或别的会话正在做的任务。只有用户明确说「你接手它」时才传 true，默认 false"`
}

const claimTaskDesc = `【会写入数据】领取一条开发任务：把状态切到进行中（默认该类型的 doing）、负责人设为「Claude Code」、记一条 kind=claim 的进展。三件事在工作台的一个事务里完成。

什么时候用：/task 流程的第二步。读完任务和验收标准、确认要动手了，就先领，再改代码。领取会让用户在任务页上看到「这条已经有人在做了」，也让别的会话不会重复领。

会被拒绝的情况（工作台返回 conflict，原因写在错误里）：
- 负责人已经是别人；
- 另一个 Claude Code 会话已经领了它、并且还在进行中；
- 任务已是终态（已完成、已取消等）或已归档。
被拒时不要换个参数硬领。把原因告诉用户；只有用户明确让你接手时，才带 takeover=true 重试。

同一个会话重复领同一条任务是幂等的，不会多写记录。

返回：领取后的任务摘要和这条领取进展。`

func addClaimTask(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_claim_task",
		Description: claimTaskDesc,
		Annotations: writes("领取任务", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in claimTaskArgs) (*mcp.CallToolResult, any, error) {
		o, err := c.resolveObject(ctx, in.ID)
		if err != nil {
			return nil, nil, err
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		ownerID, created, err := c.agentOwnerID(ctx)
		if err != nil {
			return nil, nil, err
		}
		body := map[string]any{"owner_id": ownerID}
		putStr(body, "status", in.Status)
		putStr(body, "text", in.Note)
		if in.Takeover {
			body["takeover"] = true
		}
		res, err := c.claimObject(ctx, o.ID, body)
		if err != nil {
			return nil, nil, err
		}

		var b strings.Builder
		if created {
			fmt.Fprintf(&b, "（干系人名册里原来没有「%s」，已自动建了一个。）\n", c.agentOwner)
		}
		if res.Already {
			b.WriteString("这条任务本来就是当前会话领的，没有重复写入：\n")
		} else {
			b.WriteString("已领取：\n")
		}
		b.WriteString(objectLine(cat, res.Object) + "\n")
		if res.Progress != nil {
			b.WriteString(progressLine(res.Progress) + "\n")
		}
		fmt.Fprintf(&b, "\n会话标识：%s。之后的进展、产物、提交验收都会记在这个会话名下。", c.session)
		return textResult(b.String()), nil, nil
	})
}

// --- pmw_append_progress ---

type appendProgressArgs struct {
	ID      string   `json:"id" jsonschema:"任务 id 或 ref"`
	Text    string   `json:"text" jsonschema:"这一步做了什么、遇到了什么，支持 Markdown。写给用户看的：结论在前，细节在后"`
	Commits []string `json:"commits,omitempty" jsonschema:"这一步相关的 commit sha（短 sha 也行）"`
	Files   []string `json:"files,omitempty" jsonschema:"这一步改动的文件路径，相对仓库根目录"`
}

const appendProgressDesc = `【会写入数据】给任务追加一条进展（kind=note）。工作台在服务端追加，不会覆盖别人同时写的进展，也不会动任务正文。

什么时候用：做完一个有意义的步骤就记一条——定位到原因、改完一块、测试跑过或没跑过、遇到拿不准的地方。一条任务通常记三到十条。遇到需求不清楚时，把问题写成一条进展问用户，而不是自己猜一个答案继续做。

不要用它：改任务正文或验收标准（用 pmw_update_object）；登记提交、分支、PR（用 pmw_record_artifact）；提交验收（用 pmw_submit_review）。

返回：刚写入的这条进展。`

func addAppendProgress(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_append_progress",
		Description: appendProgressDesc,
		Annotations: writes("追加进展", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in appendProgressArgs) (*mcp.CallToolResult, any, error) {
		if strings.TrimSpace(in.Text) == "" {
			return nil, nil, fmt.Errorf("text 不能为空")
		}
		o, err := c.resolveObject(ctx, in.ID)
		if err != nil {
			return nil, nil, err
		}
		p, err := c.appendProgress(ctx, o.ID, domain.ProgressInput{
			Kind: domain.ProgressNote, Text: in.Text, Commits: in.Commits, Files: in.Files,
		})
		if err != nil {
			return nil, nil, err
		}
		return textResult(fmt.Sprintf("已记进展（%s %s）：\n%s", o.Ref, o.Title, progressLine(p))), nil, nil
	})
}

// --- pmw_submit_review ---

type submitReviewArgs struct {
	ID           string   `json:"id" jsonschema:"任务 id 或 ref"`
	Summary      string   `json:"summary" jsonschema:"做了什么、怎么验证的、还有什么没做或有风险，Markdown。对着验收标准逐条说明"`
	ChangedFiles []string `json:"changed_files,omitempty" jsonschema:"改动的文件路径，相对仓库根目录"`
	TestResults  string   `json:"test_results,omitempty" jsonschema:"跑了哪些测试、结果如何。没跑测试就写没跑以及原因，不要省略"`
	Commits      []string `json:"commits,omitempty" jsonschema:"本次交付涉及的 commit sha"`
	Status       string   `json:"status,omitempty" jsonschema:"提交后切到的状态 key。一般不传：工具会在该类型的状态集里找待验收类状态（review 等）；找不到就保持当前状态不变"`
}

const submitReviewDesc = `【会写入数据】把任务提交给用户验收：记一条 kind=review 的进展（总结、改动文件、测试结果），并把状态切到待验收类状态。状态和这条进展在一个事务里落库。

什么时候用：/task 流程的最后一步。代码改完、测试跑过、提交和 PR 已经用 pmw_record_artifact 登记之后调用。

关于状态：不传 status 时它在该类型的状态集里按 key 找待验收类状态（review、in_review、verify、acceptance、qa、testing 等）；内置的任务和需求类型都没有这类状态，这时状态保持不变，只记验收申请，返回里会写明。也可以用 status 显式指定；/task 流程在验收标准全部做到、测试通过时传 status=done 直接完成（用户 2026-10-31 定的规矩）。

summary 要对着验收标准逐条说：哪条做到了、怎么验证的、哪条没做到或有风险。test_results 不能省略，没跑测试就写没跑及原因。

返回：提交后的任务摘要、状态是否切换、这条验收进展。`

// resolveReviewStatus 决定提交验收要切到哪个状态。返回空串表示不切换。
func resolveReviewStatus(t *domain.ObjectType, explicit string) (string, string) {
	if v := strings.TrimSpace(explicit); v != "" {
		return v, ""
	}
	if t == nil {
		return "", "拿不到类型定义，状态保持不变"
	}
	has := map[string]bool{}
	for _, st := range t.Statuses {
		has[st.Key] = true
	}
	for _, k := range reviewStatusKeys {
		if has[k] {
			return k, ""
		}
	}
	return "", fmt.Sprintf("类型 %s 的状态集里没有待验收类状态（找过 %s），状态保持不变，只记了验收申请。"+
		"想要独立的待验收状态，可以在工作台「设置」里给该类型加一个 key 为 review 的非终态状态。",
		t.ID, strings.Join(reviewStatusKeys, "、"))
}

func reviewText(in submitReviewArgs) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(in.Summary))
	if len(in.ChangedFiles) > 0 {
		b.WriteString("\n\n### 改动文件\n")
		for _, f := range in.ChangedFiles {
			if f = strings.TrimSpace(f); f != "" {
				b.WriteString("- " + f + "\n")
			}
		}
	}
	b.WriteString("\n\n### 测试结果\n")
	if t := strings.TrimSpace(in.TestResults); t != "" {
		b.WriteString(t)
	} else {
		b.WriteString("（未提供）")
	}
	return strings.TrimSpace(b.String())
}

func addSubmitReview(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_submit_review",
		Description: submitReviewDesc,
		Annotations: writes("提交验收", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in submitReviewArgs) (*mcp.CallToolResult, any, error) {
		if strings.TrimSpace(in.Summary) == "" {
			return nil, nil, fmt.Errorf("summary 不能为空：对着验收标准逐条说明做了什么")
		}
		o, err := c.resolveObject(ctx, in.ID)
		if err != nil {
			return nil, nil, err
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		target, why := resolveReviewStatus(cat.byID[o.TypeID], in.Status)
		p, err := c.appendProgress(ctx, o.ID, domain.ProgressInput{
			Kind: domain.ProgressReview, Text: reviewText(in),
			Commits: in.Commits, Files: in.ChangedFiles, Status: target,
		})
		if err != nil {
			return nil, nil, err
		}
		after, err := c.getObject(ctx, o.ID)
		if err != nil {
			after = o
		}

		var b strings.Builder
		b.WriteString("已提交验收：\n" + objectLine(cat, after) + "\n")
		switch {
		case why != "":
			b.WriteString(why + "\n")
		case target == o.Status:
			fmt.Fprintf(&b, "状态本来就是 %s，未变。\n", cat.statusText(o.TypeID, target))
		default:
			fmt.Fprintf(&b, "状态：%s → %s\n", cat.statusText(o.TypeID, o.Status), cat.statusText(o.TypeID, target))
		}
		b.WriteString(progressLine(p))
		return textResult(b.String()), nil, nil
	})
}

// --- pmw_next_task ---

type nextTaskArgs struct {
	Type    string   `json:"type,omitempty" jsonschema:"类型 id，默认 task"`
	Project string   `json:"project,omitempty" jsonschema:"只看某个项目下的，传项目的 id 或 ref"`
	Tags    []string `json:"tags,omitempty" jsonschema:"标签名，多个是「同时具备」"`
	Status  []string `json:"status,omitempty" jsonschema:"候选状态 key。默认只取该类型的初始状态（任务是 todo），即还没人动过的"`
	Limit   int      `json:"limit,omitempty" jsonschema:"返回几条候选，1-20，默认 5"`
}

const nextTaskDesc = `【只读】按优先级和到期日挑下一个可以做的开发任务。

什么时候用：用户说「找个任务做」「下一个做什么」，或者 /task 没带编号时。

挑选规则：
- 默认类型 task，默认只看该类型的初始状态（任务是 todo），排除终态、已归档；
- 负责人为空、或已经是「Claude Code」的才算可做——派给别人的不碰；
- 排序：优先级（P0 在前，没设优先级的排最后）→ 到期日（早的在前，没到期日的排后）→ 创建时间（早的在前）。

只是挑，不会领取。挑好之后用 pmw_get_object 读验收标准，再用 pmw_claim_task 领。

返回：候选列表，第一条是建议下一个做的，每条带工作目录和是否写了验收标准。`

func addNextTask(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_next_task",
		Description: nextTaskDesc,
		Annotations: readOnly("挑下一个任务"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in nextTaskArgs) (*mcp.CallToolResult, any, error) {
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		typeID := strings.TrimSpace(in.Type)
		if typeID == "" {
			typeID = "task"
		}
		t, ok := cat.byID[typeID]
		if !ok {
			return nil, nil, fmt.Errorf("没有类型 %q，用 pmw_list_types 查", typeID)
		}
		statuses := in.Status
		if len(statuses) == 0 && len(t.Statuses) > 0 {
			statuses = []string{t.Statuses[0].Key}
		}

		q := url.Values{"type": {typeID}, "not_terminal": {"true"}, "limit": {fmt.Sprint(nextTaskCandidate)}}
		setCSV(q, "status", statuses)
		for _, tag := range in.Tags {
			if tag = strings.TrimSpace(tag); tag != "" {
				q.Add("tag", tag)
			}
		}
		if p := strings.TrimSpace(in.Project); p != "" {
			po, err := c.resolveObject(ctx, p)
			if err != nil {
				return nil, nil, err
			}
			q.Set("project", po.ID)
		}
		items, _, err := c.listObjects(ctx, q)
		if err != nil {
			return nil, nil, err
		}

		// 可做 = 没人负责，或者负责人就是 Agent 自己。派给别人的不碰。
		cands := items[:0]
		for _, o := range items {
			mine := o.OwnerName == c.agentOwner ||
				(c.agentOwner == defaultAgentOwner && o.OwnerAIKind == domain.AIKindCLI && o.OwnerAIRef == domain.RunHarnessClaude)
			if o.OwnerID == nil || *o.OwnerID == "" || mine {
				cands = append(cands, o)
			}
		}
		prio := c.priorityRank(ctx)
		sort.SliceStable(cands, func(i, j int) bool {
			a, b := cands[i], cands[j]
			if ra, rb := prio(a.Priority), prio(b.Priority); ra != rb {
				return ra < rb
			}
			if (a.DueAt == nil) != (b.DueAt == nil) {
				return a.DueAt != nil
			}
			if a.DueAt != nil && !a.DueAt.Equal(*b.DueAt) {
				return a.DueAt.Before(*b.DueAt)
			}
			return a.CreatedAt.Before(b.CreatedAt)
		})
		if len(cands) == 0 {
			return textResult(fmt.Sprintf("没有可做的 %s：状态限定 %s、负责人为空或是「%s」的一条都没有。可以放宽 status 或 tags 再试。",
				typeID, strings.Join(statuses, ","), c.agentOwner)), nil, nil
		}
		limit := clamp(in.Limit, defaultNextLimit, 1, maxNextLimit)
		if len(cands) > limit {
			cands = cands[:limit]
		}
		var b strings.Builder
		fmt.Fprintf(&b, "可做的 %s 共 %d 条候选，第一条是建议下一个做的：\n", typeID, len(cands))
		for i, o := range cands {
			extra := []string{}
			if o.Workdir != "" {
				extra = append(extra, "工作目录 "+o.Workdir)
			} else if o.ProjectTitle != "" {
				extra = append(extra, "工作目录继承项目「"+o.ProjectTitle+"」")
			}
			if propStr(o, domain.PropAcceptance) == "" {
				extra = append(extra, "未写验收标准")
			}
			line := objectLine(cat, o)
			if len(extra) > 0 {
				line += " | " + strings.Join(extra, " | ")
			}
			fmt.Fprintf(&b, "%d. %s\n", i+1, line)
		}
		return textResult(b.String()), nil, nil
	})
}

// priorityRank 返回优先级 key 的排序名次：按字典 priority 的顺序，越靠前越小；
// 没设或不认识的排最后。字典取不到时退回按 key 的字典序（P0 < P1 < …）。
func (c *client) priorityRank(ctx context.Context) func(string) int {
	order := map[string]int{}
	if dicts, err := c.listDictionaries(ctx); err == nil {
		for _, d := range dicts {
			if d.ID != domain.DictPriority {
				continue
			}
			items := append([]*domain.DictItem{}, d.Items...)
			sort.SliceStable(items, func(i, j int) bool { return items[i].SortOrder < items[j].SortOrder })
			for i, it := range items {
				order[it.Key] = i
			}
		}
	}
	return func(key string) int {
		if key == "" {
			return 1 << 20
		}
		if r, ok := order[key]; ok {
			return r
		}
		if len(order) == 0 {
			// 没有字典时 P0..P9 按数字排，别的排在它们后面。
			if len(key) == 2 && key[0] == 'P' && key[1] >= '0' && key[1] <= '9' {
				return int(key[1] - '0')
			}
		}
		return 1 << 19
	}
}

// --- pmw_create_subtasks ---

type subtaskArg struct {
	Title      string   `json:"title" jsonschema:"子任务标题"`
	Body       string   `json:"body,omitempty" jsonschema:"子任务说明，Markdown"`
	Acceptance string   `json:"acceptance,omitempty" jsonschema:"子任务的验收标准，Markdown，建议写成「- [ ] ...」清单"`
	Priority   string   `json:"priority,omitempty" jsonschema:"优先级 key，不传继承父任务"`
	DueAt      string   `json:"due_at,omitempty" jsonschema:"到期时间，YYYY-MM-DD"`
	Tags       []string `json:"tags,omitempty" jsonschema:"标签，不传继承父任务的标签"`
}

type createSubtasksArgs struct {
	ParentID string       `json:"parent_id" jsonschema:"父任务 id 或 ref"`
	Subtasks []subtaskArg `json:"subtasks" jsonschema:"要建的子任务，1-30 条"`
	TypeID   string       `json:"type_id,omitempty" jsonschema:"子任务类型，默认 task"`
}

const createSubtasksDesc = `【会写入数据】把一条任务拆成若干子任务：逐条新建，并在父任务和每条子任务之间建 parent 关联（父 --parent--> 子）。

什么时候用：任务太大、一次提交做不完，或者验收标准里有几块互相独立的工作。拆之前先和用户确认拆法；拆完在父任务上记一条进展说明拆成了哪几条。

继承规则：子任务默认继承父任务的所属项目、工作目录、关联仓库、优先级和标签；状态取类型的初始状态；负责人留空（领的时候再设）。

逐条建，某条失败不会回滚已建好的，返回里会列出哪些成功、哪些失败。

返回：每条子任务的 id、ref 和结果。`

func addCreateSubtasks(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_create_subtasks",
		Description: createSubtasksDesc,
		Annotations: writes("拆子任务", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createSubtasksArgs) (*mcp.CallToolResult, any, error) {
		if len(in.Subtasks) == 0 {
			return nil, nil, fmt.Errorf("subtasks 不能为空")
		}
		if len(in.Subtasks) > maxSubtasks {
			return nil, nil, fmt.Errorf("一次最多拆 %d 条，现在是 %d 条", maxSubtasks, len(in.Subtasks))
		}
		for i, st := range in.Subtasks {
			if strings.TrimSpace(st.Title) == "" {
				return nil, nil, fmt.Errorf("第 %d 条子任务没有标题", i+1)
			}
		}
		parent, err := c.resolveObject(ctx, in.ParentID)
		if err != nil {
			return nil, nil, err
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		typeID := strings.TrimSpace(in.TypeID)
		if typeID == "" {
			typeID = "task"
		}

		var b strings.Builder
		fmt.Fprintf(&b, "父任务：%s\n", objectLine(cat, parent))
		ok, failed := 0, 0
		for i, st := range in.Subtasks {
			body := map[string]any{"type_id": typeID, "title": strings.TrimSpace(st.Title)}
			putStr(body, "body", st.Body)
			putStr(body, "due_at", st.DueAt)
			prio := strings.TrimSpace(st.Priority)
			if prio == "" {
				prio = parent.Priority
			}
			putStr(body, "priority", prio)
			tags := st.Tags
			if tags == nil {
				tags = parent.Tags
			}
			if len(tags) > 0 {
				body["tags"] = tags
			}
			if parent.ProjectID != nil && *parent.ProjectID != "" {
				body["project_id"] = *parent.ProjectID
			}
			putStr(body, "workdir", parent.Workdir)
			props := map[string]any{}
			if v := strings.TrimSpace(st.Acceptance); v != "" {
				props[domain.PropAcceptance] = v
			}
			if v := propStr(parent, domain.PropRepo); v != "" {
				props[domain.PropRepo] = v
			}
			if len(props) > 0 {
				body["props"] = props
			}

			child, err := c.createObject(ctx, body)
			if err != nil {
				failed++
				fmt.Fprintf(&b, "%d. 失败：%s —— %v\n", i+1, st.Title, err)
				continue
			}
			_, lerr := c.createLink(ctx, parent.ID, map[string]any{"to_id": child.ID, "relation": domain.RelParent})
			ok++
			fmt.Fprintf(&b, "%d. %s\n", i+1, objectLine(cat, child))
			if lerr != nil {
				fmt.Fprintf(&b, "   已建好，但和父任务的关联没建上：%v\n", lerr)
			}
		}
		fmt.Fprintf(&b, "\n成功 %d 条，失败 %d 条。", ok, failed)
		return textResult(b.String()), nil, nil
	})
}

// --- pmw_list_runs / pmw_get_run ---

type listRunsArgs struct {
	ID    string `json:"id" jsonschema:"任务 id 或 ref"`
	Limit int    `json:"limit,omitempty" jsonschema:"返回条数，1-100，默认 10"`
}

const listRunsDesc = `【只读】列出某条任务在工作台后端的执行记录：用户在任务页点「交给 Claude Code」后，后端起的那些 claude 进程。

什么时候用：接手一条任务前，看看之前有没有跑过、跑到哪一步、为什么失败；或者用户问「上次执行怎么样了」。

注意这里只有后端发起的执行。你在当前 Claude Code 会话里做的事不在这里，在进展（pmw_get_object 末尾）和变更记录（pmw_recent_changes）里。

返回：每行「run id  状态  方式（流式 / 终端）  开始时间  耗时  工作目录  错误摘要」，最近的在前。要看完整输出用 pmw_get_run。`

// runModeText 是执行方式的中文名；老记录没有 mode 按流式算。
func runModeText(mode string) string {
	if mode == domain.RunModeTerminal {
		return "终端"
	}
	return "流式"
}

func runLine(r *domain.TaskRun) string {
	parts := []string{r.ID, r.Status, runModeText(r.Mode), formatDateTime(r.StartedAt)}
	if r.FinishedAt != nil {
		parts = append(parts, "耗时 "+r.FinishedAt.Sub(r.StartedAt).Round(time.Second).String())
	} else {
		parts = append(parts, "仍在运行")
	}
	if r.Workdir != "" {
		parts = append(parts, r.Workdir)
	}
	if r.Error != "" {
		parts = append(parts, "错误："+truncate(r.Error, 80))
	}
	return "  " + strings.Join(parts, "  ")
}

func addListRuns(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_list_runs",
		Description: listRunsDesc,
		Annotations: readOnly("查看执行记录"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listRunsArgs) (*mcp.CallToolResult, any, error) {
		o, err := c.resolveObject(ctx, in.ID)
		if err != nil {
			return nil, nil, err
		}
		runs, err := c.listRuns(ctx, o.ID, clamp(in.Limit, defaultRunsLimit, 1, maxRunsLimit))
		if err != nil {
			return nil, nil, err
		}
		if len(runs) == 0 {
			return textResult(fmt.Sprintf("%s 还没有后端执行记录。", o.Ref)), nil, nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%s %s 的执行记录 %d 条（新→旧）：\n", o.Ref, o.Title, len(runs))
		for _, r := range runs {
			b.WriteString(runLine(r) + "\n")
		}
		return textResult(b.String()), nil, nil
	})
}

type getRunArgs struct {
	RunID          string `json:"run_id" jsonschema:"执行记录 id，从 pmw_list_runs 取"`
	MaxOutputChars int    `json:"max_output_chars,omitempty" jsonschema:"输出最多返回多少字符，取末尾部分，默认 8000，上限 200000"`
}

const getRunDesc = `【只读】取一次后端执行的详情：状态、退出码、工作目录、喂给 claude 的提示词、过程输出。

输出可能很长，默认只返回末尾 8000 个字符（结论通常在最后），需要更多就调大 max_output_chars。`

func addGetRun(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_get_run",
		Description: getRunDesc,
		Annotations: readOnly("查看执行详情"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getRunArgs) (*mcp.CallToolResult, any, error) {
		id := strings.TrimSpace(in.RunID)
		if id == "" {
			return nil, nil, fmt.Errorf("run_id 不能为空，用 pmw_list_runs 查")
		}
		r, err := c.getRun(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		var b strings.Builder
		b.WriteString(runLine(r) + "\n")
		fmt.Fprintf(&b, "对象：%s  退出码：%d\n", r.ObjectID, r.ExitCode)
		fmt.Fprintf(&b, "\n--- 提示词 ---\n%s\n", clip(r.Prompt, 2000))
		max := clamp(in.MaxOutputChars, defaultRunOutput, 1, maxRunOutput)
		out := []rune(r.Output)
		b.WriteString("\n--- 输出 ---\n")
		if len(out) > max {
			fmt.Fprintf(&b, "（共 %d 字符，以下是末尾 %d 字符）\n", len(out), max)
			out = out[len(out)-max:]
		}
		b.WriteString(string(out))
		return textResult(b.String()), nil, nil
	})
}

// clip 按 rune 截断但保留换行，给多行文本（提示词）用；truncate 会把换行压成空格。
func clip(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n]) + "\n…（已截断）"
}

// --- pmw_finish_run ---

type finishRunArgs struct {
	RunID   string         `json:"run_id" jsonschema:"执行记录 id，交给你的提示词「回写到工作台」一节里写着，形如 run_…"`
	Status  string         `json:"status" jsonschema:"结果：done（做完了）、failed（做不下去）或 canceled（用户让你停下）"`
	Summary string         `json:"summary,omitempty" jsonschema:"结论摘要，Markdown：做了什么、产出在哪、还剩什么没做。failed 时写清卡在哪"`
	Result  map[string]any `json:"result,omitempty" jsonschema:"结构化结论，JSON 对象。SOP 自动交给你的执行要填：至少带 verdict（pass 通过 / reject 不通过要退回），不通过时 issues 逐条写要改什么，产出可列在 artifacts。下游步骤按它判断往哪走"`
}

const finishRunDesc = `【会写入数据】给一次「切换到终端」的执行收尾：记下结果和结论摘要，工作台任务抽屉的执行记录里这条从「进行中」变成完成 / 失败 / 取消，摘要显示为这次执行的输出。

什么时候用：用户在工作台把任务「交给 Claude Code」并选了「切换到终端」，你就在那个终端里。提示词的「回写到工作台」一节写了执行记录 id。做完、做不下去、或用户让你停下时调一次，只调一次。

也收 SOP 自动交给你的执行（提示词「回写到工作台」一节写着是 SOP 交的）：这时只记下结论，进程退出时工作台自己收尾，result 填结构化结论，后面的步骤按 result.verdict 往下走。

用户点「流式执行」起的那种由工作台自己收尾，调了会被拒绝（conflict）。已经收尾、已经回报过的也会被拒绝。

这个工具只管执行记录。任务本身的状态用 pmw_update_object 改，产出用 pmw_record_artifact（带 run_id）登记，过程用 pmw_append_progress 记。

返回：收尾后的执行记录一行。`

func addFinishRun(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_finish_run",
		Description: finishRunDesc,
		Annotations: writes("执行收尾", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in finishRunArgs) (*mcp.CallToolResult, any, error) {
		id := strings.TrimSpace(in.RunID)
		if id == "" {
			return nil, nil, fmt.Errorf("run_id 不能为空，提示词「回写到工作台」一节里有")
		}
		status := strings.ToLower(strings.TrimSpace(in.Status))
		switch status {
		case domain.RunDone, domain.RunFailed, domain.RunCanceled:
		default:
			return nil, nil, fmt.Errorf("status 只能是 done、failed 或 canceled")
		}
		r, err := c.finishRun(ctx, id, status, in.Summary, in.Result)
		if err != nil {
			return nil, nil, err
		}
		if r.FinishedAt == nil {
			// SOP 交给的执行：只记下了结论，进程退出后工作台自己收尾
			return textResult("已记下结论，这次执行结束后工作台会自己收尾，下游步骤按 result 往下走：\n" + runLine(r)), nil, nil
		}
		return textResult("已收尾：\n" + runLine(r)), nil, nil
	})
}
