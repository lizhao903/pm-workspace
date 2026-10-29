package main

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultSearchLimit = 30
	maxSearchLimit     = 200
	defaultRevLimit    = 50
	maxRevLimit        = 500
	// maxTitleLookups 限制补标题的并发请求量：变更流可能有几百条，
	// 全查一遍既慢又没必要，日报关心的是最近这批。
	maxTitleLookups  = 40
	titleConcurrency = 8
)

// refPattern 匹配 REQ-0001 这种人读的编号。模型经常拿它当 id 用，
// 这里做一次兜底查询，省得回一个「not found」把对话卡住。
var refPattern = regexp.MustCompile(`^[A-Za-z]{2,8}-\d{1,8}$`)

func ptr[T any](v T) *T { return &v }

func textResult(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

// readOnly / writes 是给客户端看的行为提示，同时也写进了每个工具的 description 开头。
func readOnly(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{Title: title, ReadOnlyHint: true, OpenWorldHint: ptr(false)}
}

func writes(title string, destructive bool) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{Title: title, DestructiveHint: ptr(destructive), OpenWorldHint: ptr(false)}
}

func registerTools(s *mcp.Server, c *client) {
	addSearch(s, c)
	addGetObject(s, c)
	addCreateObject(s, c)
	addUpdateObject(s, c)
	addListTypes(s, c)
	addListStakeholders(s, c)
	addListCategories(s, c)
	addLinkObjects(s, c)
	addRecentChanges(s, c)
	addCounts(s, c)
	addRecordArtifact(s, c)
	addListArtifacts(s, c)
	registerDevTools(s, c)
}

// --- pmw_search ---

type searchArgs struct {
	Query           string   `json:"query,omitempty" jsonschema:"关键词，对标题、正文、ref 做子串匹配（不分词、不是全文检索），越短命中率越高。留空表示只按其它条件筛"`
	Type            []string `json:"type,omitempty" jsonschema:"工作对象类型 id，如 [\"requirement\",\"task\"]，多个之间是或。合法值用 pmw_list_types 查"`
	Status          []string `json:"status,omitempty" jsonschema:"状态 key，如 [\"doing\",\"blocked\"]。状态按类型隔离，跨类型筛选时不要混用；合法值用 pmw_list_types 查"`
	Priority        []string `json:"priority,omitempty" jsonschema:"优先级 key，如 [\"P0\",\"P1\"]"`
	Tag             []string `json:"tag,omitempty" jsonschema:"标签名，多个标签是「同时具备」不是「任一」"`
	Owner           string   `json:"owner,omitempty" jsonschema:"负责人姓名，完全匹配（不模糊）。合法值用 pmw_list_stakeholders 查"`
	Category        string   `json:"category,omitempty" jsonschema:"分类 id，用 pmw_list_categories 查。默认只匹配挂在该分类下的对象"`
	Subtree         bool     `json:"subtree,omitempty" jsonschema:"配合 category 使用：连同子分类下的对象一起返回"`
	Uncategorized   bool     `json:"uncategorized,omitempty" jsonschema:"只要还没归到任何分类的对象，与 category 互斥"`
	Inbox           bool     `json:"inbox,omitempty" jsonschema:"只要收件箱里的（来源是 inbox 或尚未分类），即待整理的新东西"`
	Source          []string `json:"source,omitempty" jsonschema:"来源，如 [\"webhook\",\"im\"]，多个之间是或。任务来源取值 manual、im、webhook、schedule、incident"`
	Overdue         bool     `json:"overdue,omitempty" jsonschema:"只要已过到期日且还没进终态的"`
	Stalled         bool     `json:"stalled,omitempty" jsonschema:"只要停滞的：14 天没更新且还没进终态"`
	NotTerminal     bool     `json:"not_terminal,omitempty" jsonschema:"排除处于终态的对象（已完成、已废弃等）。做「还剩哪些没做」这类统计时应当带上"`
	DueAfter        string   `json:"due_after,omitempty" jsonschema:"到期时间下界，YYYY-MM-DD 或 RFC3339。与 due_before 传同一天可圈出「当天到期」"`
	DueBefore       string   `json:"due_before,omitempty" jsonschema:"到期时间上界，YYYY-MM-DD 或 RFC3339"`
	IncludeArchived bool     `json:"include_archived,omitempty" jsonschema:"把已归档的也带上，默认不带"`
	Sort            string   `json:"sort,omitempty" jsonschema:"排序字段，可选 updated_at、created_at、due_at、priority、title，前缀 - 表示倒序，如 -updated_at"`
	Limit           int      `json:"limit,omitempty" jsonschema:"返回条数，1-200，默认 30"`
	Offset          int      `json:"offset,omitempty" jsonschema:"跳过前 N 条，翻页用"`
}

const searchDesc = `【只读】在产品工作台里检索工作对象（需求 / 任务 / 项目 / 文档 / 资源 / 笔记，具体有哪些类型看 pmw_list_types）。

什么时候用：回答「有哪些…」「XX 相关的需求是哪些」「谁手上还有什么没做完」「哪些逾期了」这类问题；或者在读全文、改字段之前，先把目标对象找出来拿到它的 id。

注意：type / status / priority 传的都是 key 不是中文标签（例如 doing 而不是「进行中」），拿不准就先调 pmw_list_types。默认不返回已归档和已删除的对象。

返回：一行一条，格式为「id  ref  标题 | 状态 | 优先级 | 到期 | 负责人 | 标签」，末尾附命中总数。行首那个 obj_ 开头的才是 id，REQ-0001 这类是给人看的 ref。`

func addSearch(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_search",
		Description: searchDesc,
		Annotations: readOnly("检索工作对象"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchArgs) (*mcp.CallToolResult, any, error) {
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}

		q := url.Values{}
		setStr(q, "q", in.Query)
		setCSV(q, "type", in.Type)
		setCSV(q, "status", in.Status)
		setCSV(q, "priority", in.Priority)
		setCSV(q, "source", in.Source)
		for _, t := range in.Tag {
			if t = strings.TrimSpace(t); t != "" {
				q.Add("tag", t)
			}
		}
		if in.Owner != "" {
			ownerID, err := c.resolveStakeholder(ctx, in.Owner)
			if err != nil {
				return nil, nil, err
			}
			setStr(q, "owner_id", ownerID)
		}
		setStr(q, "category", in.Category)
		setStr(q, "due_after", in.DueAfter)
		setStr(q, "due_before", in.DueBefore)
		setStr(q, "sort", in.Sort)
		setBool(q, "subtree", in.Subtree)
		setBool(q, "uncategorized", in.Uncategorized)
		setBool(q, "inbox", in.Inbox)
		setBool(q, "overdue", in.Overdue)
		setBool(q, "stalled", in.Stalled)
		setBool(q, "not_terminal", in.NotTerminal)
		setBool(q, "archived", in.IncludeArchived)

		limit := clamp(in.Limit, defaultSearchLimit, 1, maxSearchLimit)
		q.Set("limit", fmt.Sprint(limit))
		if in.Offset > 0 {
			q.Set("offset", fmt.Sprint(in.Offset))
		}

		items, m, err := c.listObjects(ctx, q)
		if err != nil {
			return nil, nil, err
		}
		if len(items) == 0 {
			return textResult("没有匹配的工作对象。可以放宽 query、去掉 status/type 过滤，或用 pmw_list_types 确认筛选值写对了。"), nil, nil
		}

		var b strings.Builder
		for _, o := range items {
			b.WriteString(objectLine(cat, o) + "\n")
		}
		total, offset := len(items), in.Offset
		if m != nil {
			total = m.Total
		}
		fmt.Fprintf(&b, "\n共命中 %d 条，本次返回 %d 条（offset=%d）。", total, len(items), offset)
		if offset+len(items) < total {
			fmt.Fprintf(&b, "还有 %d 条，把 offset 调到 %d 继续翻。", total-offset-len(items), offset+len(items))
		}
		return textResult(b.String()), nil, nil
	})
}

// --- pmw_get_object ---

type getObjectArgs struct {
	ID string `json:"id" jsonschema:"工作对象 id，形如 obj_0abc…，从 pmw_search 的结果里取。也接受 REQ-0001 这样的 ref，会自动换算成 id"`
}

const getObjectDesc = `【只读】取单个工作对象的全文：结构化摘要（类型、状态、优先级、负责人、分类、所属项目、到期、标签、关联数、时间戳、工作目录、关联仓库）、验收标准、完整正文，以及最近 10 条进展。

什么时候用：pmw_search 只给出一行摘要，要读需求描述、验收标准这些正文内容，或者在改动前确认当前值，就调这个。

id 从 pmw_search 的行首取。传 REQ-0001 这种 ref 也能用，会自动查一次换成 id。`

func addGetObject(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_get_object",
		Description: getObjectDesc,
		Annotations: readOnly("读取工作对象全文"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getObjectArgs) (*mcp.CallToolResult, any, error) {
		id := strings.TrimSpace(in.ID)
		if id == "" {
			return nil, nil, fmt.Errorf("id 不能为空")
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		o, err := c.getObject(ctx, id)
		if err != nil {
			// 传的可能是 ref 而不是 id，换一条路再找一次。
			if o2, ok := c.resolveRef(ctx, id); ok {
				o = o2
			} else {
				return nil, nil, err
			}
		}
		out := objectDetail(cat, o)
		// 任务自己没设工作目录时向上取所属项目的，和后端 ResolveWorkdir 同一个规则。
		// 不补这一句的话，模型看到「没有工作目录」会去猜一个，而那个目录多半是错的。
		if o.Workdir == "" && o.ProjectID != nil && *o.ProjectID != "" {
			if p, perr := c.getObject(ctx, *o.ProjectID); perr == nil && p.Workdir != "" {
				out += "\n工作目录（继承自所属项目 " + joinNonEmpty(" ", p.Ref, p.Title) + "）：" + p.Workdir + "\n"
			}
		}
		// 进展是锦上添花：老版本工作台没有这个接口，取不到就不显示，不让整个工具失败。
		if items, perr := c.listProgress(ctx, o.ID, progressInGetObj); perr == nil && len(items) > 0 {
			out += fmt.Sprintf("\n--- 最近 %d 条进展（新→旧）---\n", len(items))
			for _, p := range items {
				out += progressLine(p) + "\n"
			}
		}
		return textResult(out), nil, nil
	})
}

// resolveRef 把 REQ-0001 这样的 ref 换成对象。查不到就放弃，让调用方报原始错误。
func (c *client) resolveRef(ctx context.Context, ref string) (*domain.Object, bool) {
	if !refPattern.MatchString(ref) {
		return nil, false
	}
	q := url.Values{"q": {ref}, "limit": {"20"}, "archived": {"true"}}
	items, _, err := c.listObjects(ctx, q)
	if err != nil {
		return nil, false
	}
	for _, o := range items {
		if strings.EqualFold(o.Ref, ref) {
			return o, true
		}
	}
	return nil, false
}

// --- pmw_create_object ---

type createObjectArgs struct {
	TypeID     string   `json:"type_id" jsonschema:"工作对象类型 id，如 requirement、task、project。合法值用 pmw_list_types 查"`
	Title      string   `json:"title" jsonschema:"标题，一句话说清是什么"`
	Body       string   `json:"body,omitempty" jsonschema:"正文，支持 Markdown。需求的背景、方案、验收标准都写这里"`
	Status     string   `json:"status,omitempty" jsonschema:"状态 key，必须属于该类型的状态集。不传则由工作台取该类型的默认首状态"`
	Priority   string   `json:"priority,omitempty" jsonschema:"优先级 key，如 P0、P1"`
	Owner      string   `json:"owner,omitempty" jsonschema:"负责人姓名，必须是名册里已有的人。合法值用 pmw_list_stakeholders 查"`
	CategoryID string   `json:"category_id,omitempty" jsonschema:"分类 id，必须属于同一个 type_id，用 pmw_list_categories 查"`
	ProjectID  string   `json:"project_id,omitempty" jsonschema:"所属项目对象的 id"`
	DueAt      string   `json:"due_at,omitempty" jsonschema:"到期时间，YYYY-MM-DD 或 RFC3339"`
	Tags       []string `json:"tags,omitempty" jsonschema:"标签名列表，不存在的标签会自动创建"`
	Source     string   `json:"source,omitempty" jsonschema:"来源标记，不传默认按普通新建处理；传 inbox 表示丢进收件箱待整理。任务来源用 manual、im、webhook、schedule、incident"`
	Acceptance string   `json:"acceptance,omitempty" jsonschema:"验收标准，Markdown，建议写成「- [ ] ...」清单。开发任务应当写"`
	Repo       string   `json:"repo,omitempty" jsonschema:"关联仓库：远端地址或本机绝对路径。开发任务用"`
	Workdir    string   `json:"workdir,omitempty" jsonschema:"工作目录，本机绝对路径。不传时执行和开发会继承所属项目的工作目录"`
}

const createObjectDesc = `【会写入数据】在产品工作台里新建一个工作对象（需求、任务、项目、文档等）。

什么时候用：用户说「记一下」「建个需求」「加个任务」，或者你在对话里整理出了需要落库跟踪的事项。

必填 type_id 和 title。其余不传就留空，不要为了填满字段而编造负责人或到期日。status 必须是该类型状态集里的 key（用 pmw_list_types 查），不传则走该类型的默认首状态，通常这样更稳妥。

返回：新建对象的 id、ref 和摘要。`

func addCreateObject(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_create_object",
		Description: createObjectDesc,
		Annotations: writes("新建工作对象", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createObjectArgs) (*mcp.CallToolResult, any, error) {
		if strings.TrimSpace(in.TypeID) == "" {
			return nil, nil, fmt.Errorf("type_id 是必填的，用 pmw_list_types 查有哪些类型")
		}
		if strings.TrimSpace(in.Title) == "" {
			return nil, nil, fmt.Errorf("title 是必填的")
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}

		body := map[string]any{
			"type_id": strings.TrimSpace(in.TypeID),
			"title":   strings.TrimSpace(in.Title),
		}
		putStr(body, "body", in.Body)
		putStr(body, "status", in.Status)
		putStr(body, "priority", in.Priority)
		if in.Owner != "" {
			ownerID, err := c.resolveStakeholder(ctx, in.Owner)
			if err != nil {
				return nil, nil, err
			}
			putStr(body, "owner_id", ownerID)
		}
		putStr(body, "source", in.Source)
		putStr(body, "due_at", in.DueAt)
		if v := strings.TrimSpace(in.CategoryID); v != "" {
			body["category_id"] = v
		}
		if v := strings.TrimSpace(in.ProjectID); v != "" {
			body["project_id"] = v
		}
		if len(in.Tags) > 0 {
			body["tags"] = in.Tags
		}
		putStr(body, "workdir", in.Workdir)
		props := map[string]any{}
		if v := strings.TrimSpace(in.Acceptance); v != "" {
			props[domain.PropAcceptance] = v
		}
		if v := strings.TrimSpace(in.Repo); v != "" {
			props[domain.PropRepo] = v
		}
		if len(props) > 0 {
			body["props"] = props
		}

		o, err := c.createObject(ctx, body)
		if err != nil {
			return nil, nil, err
		}
		return textResult("已创建：\n" + objectLine(cat, o)), nil, nil
	})
}

// --- pmw_update_object ---

// updateObjectArgs 用指针区分「不改」和「改成空」：字段缺省 = 保持原值，
// 传空串 = 清空（仅 category_id / due_at 支持清空，它们在库里可为 NULL）。
type updateObjectArgs struct {
	ID         string   `json:"id" jsonschema:"要修改的工作对象 id，从 pmw_search 取。也接受 REQ-0001 这样的 ref"`
	Title      *string  `json:"title,omitempty" jsonschema:"新标题"`
	Body       *string  `json:"body,omitempty" jsonschema:"新正文，整体替换而不是追加。要在原文上补充，先用 pmw_get_object 读回来再拼好传完整内容"`
	Status     *string  `json:"status,omitempty" jsonschema:"新状态，必须是该对象所属类型状态集里的 key（不是中文标签）。先用 pmw_list_types 查清楚该类型有哪些状态"`
	Priority   *string  `json:"priority,omitempty" jsonschema:"新优先级 key，如 P0"`
	Owner      *string  `json:"owner,omitempty" jsonschema:"新负责人姓名，必须是名册里已有的人（用 pmw_list_stakeholders 查）；传空串表示清空负责人"`
	CategoryID *string  `json:"category_id,omitempty" jsonschema:"新分类 id，必须与该对象同类型；传空串表示移出分类变成未分类"`
	ProjectID  *string  `json:"project_id,omitempty" jsonschema:"新的所属项目 id，传空串表示解除归属"`
	DueAt      *string  `json:"due_at,omitempty" jsonschema:"新到期时间，YYYY-MM-DD 或 RFC3339；传空串表示去掉到期日"`
	Tags       []string `json:"tags,omitempty" jsonschema:"标签整体替换（不是追加）。要加标签，先 pmw_get_object 读到现有标签再传合并后的完整列表；传空数组表示清空所有标签"`
	Archived   *bool    `json:"archived,omitempty" jsonschema:"true 归档、false 取消归档。归档不是删除，对象仍可检索到"`
	Acceptance *string  `json:"acceptance,omitempty" jsonschema:"新的验收标准（整体替换），传空串表示清掉"`
	Repo       *string  `json:"repo,omitempty" jsonschema:"新的关联仓库，传空串表示清掉"`
	Workdir    *string  `json:"workdir,omitempty" jsonschema:"新的工作目录（本机绝对路径），传空串表示清掉、改为继承所属项目"`
}

const updateObjectDesc = `【会写入数据】修改一个已有的工作对象：状态、优先级、负责人、到期日、分类、标签、正文都走这个工具。

关于 status：它必须是该对象所属类型状态集里的 key，不是中文标签。不同类型的状态集不一样（需求有 backlog/planned/doing/done，任务是 todo/doing/blocked/done），改之前先用 pmw_list_types 查该类型合法的 key，传错会被工作台直接拒绝。

语义说明：
- 只传你要改的字段，没传的字段保持原值。
- body 和 tags 都是整体替换不是追加。要在原有基础上增补，先用 pmw_get_object 读回来，拼好完整内容再传。
- owner、category_id、project_id、due_at 传空串表示清空该字段。
- archived=true 是归档不是删除；本工具不提供删除能力。
- acceptance / repo 只改这两项，其它自定义属性保持不变。

返回：更新后的对象摘要。`

func addUpdateObject(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_update_object",
		Description: updateObjectDesc,
		Annotations: writes("修改工作对象", true),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateObjectArgs) (*mcp.CallToolResult, any, error) {
		id := strings.TrimSpace(in.ID)
		if id == "" {
			return nil, nil, fmt.Errorf("id 不能为空")
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}

		patch := map[string]any{}
		putPtr(patch, "title", in.Title)
		putPtr(patch, "body", in.Body)
		putPtr(patch, "status", in.Status)
		putPtr(patch, "priority", in.Priority)
		if in.Owner != nil {
			ownerID, err := c.resolveStakeholder(ctx, *in.Owner)
			if err != nil {
				return nil, nil, err
			}
			patch["owner_id"] = ownerID // 空串即清空，resolveStakeholder 对空串返回空串
		}
		// 这三个字段库里可为 NULL：空串映射成 JSON null，工作台才认得是「置空」。
		putNullable(patch, "category_id", in.CategoryID)
		putNullable(patch, "project_id", in.ProjectID)
		putNullable(patch, "due_at", in.DueAt)
		if in.Tags != nil {
			patch["tags"] = in.Tags
		}
		if in.Archived != nil {
			patch["archived"] = *in.Archived
		}
		if in.Workdir != nil {
			patch["workdir"] = strings.TrimSpace(*in.Workdir)
		}
		if in.Acceptance != nil || in.Repo != nil {
			// props 在后端是整体替换。这里先读回当前值，只改这两个 key，
			// 别的自定义属性原样带回去——否则改一下验收标准就把其它属性全清了。
			cur, err := c.resolveObject(ctx, id)
			if err != nil {
				return nil, nil, err
			}
			props := map[string]any{}
			for k, v := range cur.Props {
				props[k] = v
			}
			setProp := func(k string, v *string) {
				if v == nil {
					return
				}
				if t := strings.TrimSpace(*v); t != "" {
					props[k] = t
				} else {
					delete(props, k)
				}
			}
			setProp(domain.PropAcceptance, in.Acceptance)
			setProp(domain.PropRepo, in.Repo)
			patch["props"] = props
		}
		if len(patch) == 0 {
			return nil, nil, fmt.Errorf("没有给出任何要修改的字段，至少传一个（如 status、priority、owner、due_at、tags、body）")
		}

		// ref 要先换成 id，否则 PATCH 会 404。
		if refPattern.MatchString(id) {
			if o, ok := c.resolveRef(ctx, id); ok {
				id = o.ID
			}
		}

		o, err := c.updateObject(ctx, id, patch)
		if err != nil {
			return nil, nil, err
		}
		changed := make([]string, 0, len(patch))
		for k := range patch {
			changed = append(changed, k)
		}
		return textResult(fmt.Sprintf("已更新 %s：\n%s", strings.Join(changed, ", "), objectLine(cat, o))), nil, nil
	})
}

// --- pmw_list_types ---

type listTypesArgs struct{}

const listTypesDesc = `【只读】列出工作台里所有工作对象类型，以及每个类型各自的状态集、优先级枚举和关联关系枚举。

什么时候用：这是其它工具的前置查询。在 pmw_create_object 选 type_id、在 pmw_update_object 传 status、在 pmw_search 按 type/status 筛、在 pmw_link_objects 选 relation 之前，只要拿不准合法取值就先调这个。不确定的时候宁可多调一次，也别猜一个 key 传过去被拒。

要点：状态集是按类型隔离的——需求的 doing 和任务的 doing 是两回事，不同类型的状态 key 不能互相套用。

返回：每个类型的 id、名称、ref 前缀，以及它的状态 key 列表（含中文标签、哪些是终态）；再附上全局的优先级与关联关系取值。`

func addListTypes(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_list_types",
		Description: listTypesDesc,
		Annotations: readOnly("列出类型与合法状态"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ listTypesArgs) (*mcp.CallToolResult, any, error) {
		types, err := c.listObjectTypes(ctx)
		if err != nil {
			return nil, nil, err
		}
		// 字典是锦上添花：拿不到也要把类型和状态集给出去，那才是这个工具的主干。
		dicts, derr := c.listDictionaries(ctx)
		if derr != nil {
			dicts = nil
		}
		return textResult(renderTypes(types, dicts)), nil, nil
	})
}

// --- pmw_list_stakeholders ---

type listStakeholdersArgs struct {
	IncludeArchived bool `json:"include_archived,omitempty" jsonschema:"把已归档（离职/不再参与）的人也带上，默认不带。派活时不要带"`
}

const listStakeholdersDesc = `【只读】列出干系人名册（可以被指派为负责人或参与人的那些人）。

什么时候用：在 pmw_search 按负责人筛选之前、或者建/改对象要指定负责人之前，先确认这个人在不在名册里、名字怎么写。

要点：负责人是对名册的引用，不是自由文本。传的姓名必须与名册**完全一致**，不做模糊匹配——匹配错人意味着任务派给了别人。名册里没有的人要先在工作台的「设置 → 干系人」里建出来。

返回：一行一人，格式为「姓名 | 角色 | 负责 N 件 / 参与 M 件」，已归档的标注「已归档」。`

func addListStakeholders(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_list_stakeholders",
		Description: listStakeholdersDesc,
		Annotations: readOnly("列出干系人名册"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listStakeholdersArgs) (*mcp.CallToolResult, any, error) {
		people, err := c.listStakeholders(ctx)
		if err != nil {
			return nil, nil, err
		}
		var b strings.Builder
		n := 0
		for _, p := range people {
			if p.ArchivedAt != nil && !in.IncludeArchived {
				continue
			}
			n++
			b.WriteString(p.Name)
			if p.Role != "" {
				b.WriteString(" | " + p.Role)
			}
			fmt.Fprintf(&b, " | 负责 %d 件 / 参与 %d 件", p.OwnedCount, p.ParticipatingCount)
			if p.ArchivedAt != nil {
				b.WriteString(" | 已归档")
			}
			b.WriteString("\n")
		}
		if n == 0 {
			return textResult("干系人名册是空的。要指派负责人，先在工作台的「设置 → 干系人」里把人建出来。"), nil, nil
		}
		return textResult(b.String()), nil, nil
	})
}

// --- pmw_list_categories ---

type listCategoriesArgs struct {
	Type string `json:"type,omitempty" jsonschema:"工作对象类型 id，如 requirement。不传则返回所有类型的分类"`
}

const listCategoriesDesc = `【只读】列出某个工作对象类型下的分类树（分类是类型内部的归属维度，单选，可多层嵌套）。

什么时候用：要按分类检索（pmw_search 的 category 参数）、或者新建/修改对象时要指定 category_id，先用这个把分类 id 查出来。

要点：分类隶属于具体类型，需求的分类不能挂到任务上。

返回：缩进表示层级的树，每行是「分类名 (id) 对象数」，子树数量也会一并标出。`

func addListCategories(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_list_categories",
		Description: listCategoriesDesc,
		Annotations: readOnly("列出分类树"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listCategoriesArgs) (*mcp.CallToolResult, any, error) {
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		typeID := strings.TrimSpace(in.Type)
		roots, err := c.categoryTree(ctx, typeID)
		if err != nil {
			return nil, nil, err
		}
		return textResult(renderCategories(cat, typeID, roots)), nil, nil
	})
}

// --- pmw_link_objects ---

type linkObjectsArgs struct {
	FromID   string `json:"from_id" jsonschema:"关联起点的对象 id，也接受 REQ-0001 这样的 ref"`
	ToID     string `json:"to_id" jsonschema:"关联终点的对象 id，也接受 ref"`
	Relation string `json:"relation" jsonschema:"关联关系 key，如 relates（相关）、blocks（阻塞）、duplicates（重复）、parent（父子）、references（引用）。合法值用 pmw_list_types 查"`
	Note     string `json:"note,omitempty" jsonschema:"备注，说明这两个对象为什么关联"`
}

const linkObjectsDesc = `【会写入数据】在两个工作对象之间建立关联，比如「这个任务阻塞了那个需求」「这两条需求重复了」。

关联是有方向的：from_id 是起点，to_id 是终点。relation=blocks 表示「from 阻塞 to」，relation=parent 表示「from 是 to 的父级」，方向搞反了含义就反了。

relation 必须是工作台里配置的关联关系 key，用 pmw_list_types 查（它会一并列出关联关系枚举）。

返回：建立好的关联及对端对象摘要。`

func addLinkObjects(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_link_objects",
		Description: linkObjectsDesc,
		Annotations: writes("建立对象关联", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in linkObjectsArgs) (*mcp.CallToolResult, any, error) {
		from, to := strings.TrimSpace(in.FromID), strings.TrimSpace(in.ToID)
		rel := strings.TrimSpace(in.Relation)
		if from == "" || to == "" {
			return nil, nil, fmt.Errorf("from_id 和 to_id 都是必填的")
		}
		if rel == "" {
			return nil, nil, fmt.Errorf("relation 是必填的，合法取值用 pmw_list_types 查")
		}
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		if o, ok := c.resolveRef(ctx, from); ok {
			from = o.ID
		}
		if o, ok := c.resolveRef(ctx, to); ok {
			to = o.ID
		}

		body := map[string]any{"to_id": to, "relation": rel}
		putStr(body, "note", in.Note)
		lv, err := c.createLink(ctx, from, body)
		if err != nil {
			return nil, nil, err
		}
		out := fmt.Sprintf("已建立关联：%s --%s--> %s", lv.FromID, lv.Relation, lv.ToID)
		if lv.Note != "" {
			out += "\n备注：" + lv.Note
		}
		if lv.Peer != nil {
			out += "\n对端：" + objectLine(cat, lv.Peer)
		}
		return textResult(out), nil, nil
	})
}

// --- pmw_recent_changes ---

type recentChangesArgs struct {
	ObjectID string `json:"object_id,omitempty" jsonschema:"只看某一个对象的变更历史，传它的 id 或 ref。不传则看全局最近变更"`
	Limit    int    `json:"limit,omitempty" jsonschema:"返回条数，1-500，默认 50"`
}

const recentChangesDesc = `【只读】按时间倒序列出工作台里的变更记录（谁、什么时候、把哪个对象的哪个字段从什么改成了什么）。

什么时候用：这是写日报、周报、复盘的数据源——「今天都干了什么」「这周推进了哪些需求」先拿这个。也可以传 object_id 只看某一个对象的演进过程。

要点：返回的是字段级变更流水，不是对象列表。同一个对象改了三个字段就会出现三行。要看对象当前状态，用 pmw_search 或 pmw_get_object。

返回：每行「时间  对象id 标题  字段: 旧值 → 新值  (操作者/来源)」。`

func addRecentChanges(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_recent_changes",
		Description: recentChangesDesc,
		Annotations: readOnly("查看最近变更"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in recentChangesArgs) (*mcp.CallToolResult, any, error) {
		limit := clamp(in.Limit, defaultRevLimit, 1, maxRevLimit)

		if id := strings.TrimSpace(in.ObjectID); id != "" {
			cat, err := c.loadCatalog(ctx)
			if err != nil {
				return nil, nil, err
			}
			o, err := c.getObject(ctx, id)
			if err != nil {
				o2, ok := c.resolveRef(ctx, id)
				if !ok {
					return nil, nil, err
				}
				o = o2
			}
			revs, err := c.objectRevisions(ctx, o.ID, limit)
			if err != nil {
				return nil, nil, err
			}
			scope := joinNonEmpty(" ", o.Ref, o.Title)
			return textResult(renderRevisions(revs, nil, scope) + "\n当前状态：" + objectLine(cat, o)), nil, nil
		}

		revs, err := c.recentRevisions(ctx, limit)
		if err != nil {
			return nil, nil, err
		}
		return textResult(renderRevisions(revs, c.fetchTitles(ctx, revs), "")), nil, nil
	})
}

// fetchTitles 并发把变更流里的 object_id 补成标题。工作台在本机，这点请求很快；
// 单个查不到就退回裸 id——不能因为一个已删对象让整份日报失败。
func (c *client) fetchTitles(ctx context.Context, revs []*domain.Revision) map[string]string {
	ids := make([]string, 0, maxTitleLookups)
	seen := make(map[string]bool, maxTitleLookups)
	for _, r := range revs {
		if seen[r.ObjectID] {
			continue
		}
		seen[r.ObjectID] = true
		ids = append(ids, r.ObjectID)
		if len(ids) >= maxTitleLookups {
			break
		}
	}

	out := make(map[string]string, len(ids))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, titleConcurrency)
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			o, err := c.getObject(ctx, id)
			if err != nil || o == nil {
				return
			}
			mu.Lock()
			out[id] = joinNonEmpty(" ", o.Ref, o.Title)
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}

// --- pmw_counts ---

type countsArgs struct {
	Type string `json:"type,omitempty" jsonschema:"把收件箱/今日/本周/逾期/停滞这几个聚焦类计数收窄到某个类型，如 task。按类型和按状态的分布始终是全局的"`
}

const countsDesc = `【只读】工作台的待办概览：收件箱、今日到期、本周到期、已逾期、停滞（14 天没更新且未进终态）各有多少，外加按类型和按状态的数量分布。

什么时候用：回答「现在手上积了多少事」「有没有逾期的」「哪类东西堆积了」，或者在开始一段工作前先看全局盘子。它一次请求就给出全貌，比用 pmw_search 反复试各种过滤条件省得多。

要点：这里只给数字。要看具体是哪些对象，再用 pmw_search 配合 overdue=true / stalled=true / inbox=true 去捞。

返回：一段概览数字 + 按类型分布 + 按状态分布。`

func addCounts(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_counts",
		Description: countsDesc,
		Annotations: readOnly("待办概览"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in countsArgs) (*mcp.CallToolResult, any, error) {
		cat, err := c.loadCatalog(ctx)
		if err != nil {
			return nil, nil, err
		}
		typeID := strings.TrimSpace(in.Type)
		cnt, err := c.counts(ctx, typeID)
		if err != nil {
			return nil, nil, err
		}
		return textResult(renderCounts(cat, typeID, cnt)), nil, nil
	})
}

// --- 小工具 ---

func setStr(q url.Values, k, v string) {
	if v = strings.TrimSpace(v); v != "" {
		q.Set(k, v)
	}
}

func setCSV(q url.Values, k string, vs []string) {
	parts := make([]string, 0, len(vs))
	for _, v := range vs {
		if v = strings.TrimSpace(v); v != "" {
			parts = append(parts, v)
		}
	}
	if len(parts) > 0 {
		q.Set(k, strings.Join(parts, ","))
	}
}

func setBool(q url.Values, k string, v bool) {
	if v {
		q.Set(k, "true")
	}
}

func putStr(m map[string]any, k, v string) {
	if v = strings.TrimSpace(v); v != "" {
		m[k] = v
	}
}

func putPtr(m map[string]any, k string, v *string) {
	if v != nil {
		m[k] = *v
	}
}

// putNullable 把空串翻成 JSON null——工作台的 PATCH 用 null 表达「置空」，
// 空串会被当成一个合法的普通值写进去。
func putNullable(m map[string]any, k string, v *string) {
	if v == nil {
		return
	}
	if strings.TrimSpace(*v) == "" {
		m[k] = nil
		return
	}
	m[k] = strings.TrimSpace(*v)
}

func clamp(v, def, min, max int) int {
	if v <= 0 {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// --- pmw_record_artifact ---

type recordArtifactArgs struct {
	Title    string `json:"title,omitempty" jsonschema:"产物标题，比如「角色权限矩阵 v2」。留空时用文件名或链接兜底；commit / branch / pr 留空时自动生成"`
	URL      string `json:"url,omitempty" jsonschema:"云端链接。发到 Confluence / Jira / 飞书 / 云盘之后把那个页面地址填这里"`
	Path     string `json:"path,omitempty" jsonschema:"本地文件的绝对路径。url 和 path 至少要给一个，两个都给表示同一份东西既在本地也发出去了"`
	ObjectID string `json:"object_id,omitempty" jsonschema:"这件产物属于哪个工作对象，传 id 或 ref（如 REQ-0012）。不传就是未归属"`
	Platform string `json:"platform,omitempty" jsonschema:"平台名，如 Confluence / Jira / 飞书 / Google Drive / Slack / Figma / GitHub。不传会按链接自动落到「其他」"`
	Note     string `json:"note,omitempty" jsonschema:"备注，比如「v2，已评审」"`
	Kind     string `json:"kind,omitempty" jsonschema:"产物种类：file（默认，不分类）、doc、prototype、code、data、other，代码交付用 commit、branch、pr"`
	SHA      string `json:"sha,omitempty" jsonschema:"提交的 sha（短 sha 也行），kind 为 commit 时必填"`
	Branch   string `json:"branch,omitempty" jsonschema:"分支名。kind 为 branch 时必填；commit / pr 时可选，写明在哪个分支上"`
	Repo     string `json:"repo,omitempty" jsonschema:"仓库在本机的绝对路径（一般就是任务的工作目录）。commit / branch 没有远端链接时必填，用作这条产物的本地位置"`

	ActorType  string `json:"actor_type,omitempty" jsonschema:"产出者类型：agent、skill、sop、mcp 等。不传记成 mcp。只用来展示和筛选，不影响统计里的来源"`
	ActorID    string `json:"actor_id,omitempty" jsonschema:"产出者 id，比如技能名或 Agent id"`
	ActorLabel string `json:"actor_label,omitempty" jsonschema:"产出者当时的显示名，比如「PRD 可视化」"`
}

// 代码类产物的种类。0031 起写进 artifacts.kind；note 开头的标记（[commit] / [branch] / [pr]）
// 再保留一个版本做兼容，前端改成读 kind 之后去掉。
// 位置照旧用 url / path——有远端链接就是 url，没有就把仓库目录当 path。
// 其余种类（doc、prototype……）原样交给后端按字典 artifact_kind 校验；file 表示不分类。
var codeArtifactKinds = map[string]bool{"commit": true, "branch": true, "pr": true}

const recordArtifactDesc = `【会写入数据】把一件已经产出的交付物登记进工作台的产物清单：本地写出来的文档、发到 Confluence 的页面、建好的 Jira 单、传到云盘的文件，以及代码交付——提交（commit）、分支（branch）、合并请求（pr）。

什么时候用：**每次你把东西发到工作台之外的地方，发完就调一次。**写完一份 PRD 发了 Confluence、建完一批 Jira 单、把原型传到云盘——这些产出散落在各个平台，工作台是唯一能把它们汇总起来的地方。不登记的话，用户在工作台里看到的产物清单就是残缺的，而残缺的清单和完整的清单长得一模一样。

要点：
- url 和 path 至少给一个。同一份东西既在本地也发出去了，就两个都给，登记成**一条**（拆成两条会让产物总数翻倍）。
- object_id 尽量给，这样它会出现在那个需求/任务的详情页里。传 ref（REQ-0012）就行，不用先查 id。
- 同一个文件发到两个平台，登记两条，各带各的链接。
- 代码交付：kind=commit 带 sha，kind=branch 带 branch，kind=pr 带 url。有远端链接（GitHub 上的 commit / 分支 / PR 页）就填 url；只在本地的提交填 repo（仓库绝对路径）。一次开发任务通常登记：每个关键 commit 一条、工作分支一条、PR 一条。
- 种类：文档填 kind=doc、原型 prototype、数据 data；不确定就不填。
- 是某个技能或 SOP 做出来的，填 actor_type（skill / sop / agent）和 actor_id、actor_label，用户能按产出者筛。

不要用它记：过程中间产物（草稿、临时文件）、你只是读过没有产出的东西。

返回：登记后的产物摘要。`

func addRecordArtifact(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_record_artifact",
		Description: recordArtifactDesc,
		Annotations: writes("登记产物", false),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in recordArtifactArgs) (*mcp.CallToolResult, any, error) {
		url, path := strings.TrimSpace(in.URL), strings.TrimSpace(in.Path)
		kind := strings.ToLower(strings.TrimSpace(in.Kind))
		if kind == "file" {
			kind = ""
		}
		title, note := strings.TrimSpace(in.Title), strings.TrimSpace(in.Note)
		if codeArtifactKinds[kind] {
			var err error
			title, note, path, err = codeArtifact(kind, in, title, note, url, path)
			if err != nil {
				return nil, nil, err
			}
		}
		if url == "" && path == "" {
			return nil, nil, fmt.Errorf("url 和 path 至少要给一个——两个都空的产物记录指不到任何东西")
		}

		// 不在请求体里填 source：后端按 X-Actor-Source 头判定（client.go 发的是
		// agent，对应产物来源 mcp）。请求体里的 source 会被无条件覆盖，
		// 填了只会让人以为这里能控制它。
		body := map[string]any{}
		putStr(body, "title", title)
		putStr(body, "url", url)
		putStr(body, "path", path)
		putStr(body, "note", note)
		putStr(body, "kind", kind)
		putStr(body, "actor_type", strings.ToLower(strings.TrimSpace(in.ActorType)))
		putStr(body, "actor_id", in.ActorID)
		putStr(body, "actor_label", in.ActorLabel)
		if p := c.resolvePlatform(ctx, in.Platform); p != "" {
			body["platform"] = p
		}
		if oid := strings.TrimSpace(in.ObjectID); oid != "" {
			// 模型手上是 REQ-0012 这种人读编号，先换成内部 id。
			// 换不出来时原样传下去，让后端的外键去报错——在这里静默丢掉
			// object_id 的话，产物会登记成「未归属」，而调用方以为挂上了。
			if o, ok := c.resolveRef(ctx, oid); ok {
				oid = o.ID
			}
			body["object_id"] = oid
		}

		a, err := c.createArtifact(ctx, body)
		if err != nil {
			return nil, nil, err
		}
		return textResult("已登记产物：" + artifactLine(a)), nil, nil
	})
}

// codeArtifact 补齐代码类产物的标题、备注标记和本地位置。
func codeArtifact(kind string, in recordArtifactArgs, title, note, url, path string) (string, string, string, error) {
	sha, branch, repo := strings.TrimSpace(in.SHA), strings.TrimSpace(in.Branch), strings.TrimSpace(in.Repo)
	switch kind {
	case "commit":
		if sha == "" {
			return "", "", "", fmt.Errorf("kind=commit 时 sha 必填")
		}
	case "branch":
		if branch == "" {
			return "", "", "", fmt.Errorf("kind=branch 时 branch 必填")
		}
	case "pr":
		if url == "" {
			return "", "", "", fmt.Errorf("kind=pr 时 url 必填，填 PR 页面地址")
		}
	}
	if path == "" && url == "" {
		if repo == "" {
			return "", "", "", fmt.Errorf("kind=%s 没有远端链接时 repo 必填，填仓库在本机的绝对路径", kind)
		}
		path = repo
	}
	if title == "" {
		switch kind {
		case "commit":
			title = "commit " + shortSHA(sha)
		case "branch":
			title = "branch " + branch
		case "pr":
			title = "PR " + url
		}
	}
	// 标记放在 note 最前面，格式固定为「[kind] key=value ...」，后面才是自由备注。
	// 前端和统计都按这个前缀认种类，别在这里换格式。
	tag := "[" + kind + "]"
	if sha != "" {
		tag += " sha=" + sha
	}
	if branch != "" {
		tag += " branch=" + branch
	}
	if repo != "" {
		tag += " repo=" + repo
	}
	note = strings.TrimSpace(tag + " " + note)
	return title, note, path, nil
}

func shortSHA(s string) string {
	if len(s) > 10 {
		return s[:10]
	}
	return s
}

// --- pmw_list_artifacts ---

type listArtifactsArgs struct {
	ObjectID string `json:"object_id,omitempty" jsonschema:"只看某个工作对象的产物，传 id 或 ref"`
	Platform string `json:"platform,omitempty" jsonschema:"只看某个平台的，如 Confluence / 飞书 / 本地文件"`
	Q        string `json:"q,omitempty" jsonschema:"关键词，同时匹配标题、路径、链接和备注"`
	Kind     string `json:"kind,omitempty" jsonschema:"只看某个种类的，如 doc、commit、branch、pr"`
	Limit    int    `json:"limit,omitempty" jsonschema:"返回条数，1-500，默认 50"`
}

const listArtifactsDesc = `【只读】列出工作台记下的输出产物：本地文件和发到各个平台的东西都在这里。

什么时候用：
- 查重——要写某份文档之前，先看这件事之前是不是已经产出过，别做第二遍。
- 找链接——「上次那份需求发哪儿了」，这里有地址。
- 交付盘点——某个需求/项目一共产出了什么，传 object_id。

返回：每行「标题  平台  链接或路径  (归属对象)」。`

func addListArtifacts(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_list_artifacts",
		Description: listArtifactsDesc,
		Annotations: readOnly("查看产物清单"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listArtifactsArgs) (*mcp.CallToolResult, any, error) {
		q := url.Values{"limit": {strconv.Itoa(clamp(in.Limit, 50, 1, 500))}}
		if oid := strings.TrimSpace(in.ObjectID); oid != "" {
			if o, ok := c.resolveRef(ctx, oid); ok {
				oid = o.ID
			}
			q.Set("object_id", oid)
		}
		if p := c.resolvePlatform(ctx, in.Platform); p != "" {
			q.Set("platform", p)
		}
		setStr(q, "q", in.Q)
		setStr(q, "kind", strings.ToLower(strings.TrimSpace(in.Kind)))

		items, m, err := c.listArtifacts(ctx, q)
		if err != nil {
			return nil, nil, err
		}
		if len(items) == 0 {
			return textResult("没有匹配的产物。"), nil, nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "共 %d 件产物", m.Total)
		if m.Total > len(items) {
			fmt.Fprintf(&b, "，以下是前 %d 件", len(items))
		}
		b.WriteString("：\n")
		for _, a := range items {
			b.WriteString(artifactLine(a) + "\n")
		}
		return textResult(b.String()), nil, nil
	})
}

// artifactLine 是产物在 MCP 输出里的一行。
//
// 链接放在最后而不是中间：模型要复述给用户的往往就是这个地址，
// 夹在一行中间的长 URL 会被后面的字段挤断行。
func artifactLine(a *domain.Artifact) string {
	parts := []string{a.Title}
	if a.Kind != "" {
		parts = append(parts, "<"+a.Kind+">")
	}
	if a.Platform != "" {
		parts = append(parts, "["+a.Platform+"]")
	}
	if a.ObjectRef != "" {
		parts = append(parts, "("+a.ObjectRef+" "+a.ObjectTitle+")")
	}
	if a.Note != "" {
		parts = append(parts, a.Note)
	}
	// 本地和云端都有时两个都列：这一行的用处就是让人能直接点过去或打开，
	// 只给其中一个等于替用户决定他现在想去哪边。
	if a.Path != "" {
		parts = append(parts, a.Path)
	}
	if a.URL != "" {
		parts = append(parts, a.URL)
	}
	return "  " + strings.Join(parts, "  ")
}
