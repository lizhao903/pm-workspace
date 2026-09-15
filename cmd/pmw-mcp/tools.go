package main

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
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

const searchDesc = `【只读】在产品工作台里检索工作对象（需求 / 待办 / 项目 / 文档 / 资源 / 笔记，具体有哪些类型看 pmw_list_types）。

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

const getObjectDesc = `【只读】取单个工作对象的全文：结构化摘要（类型、状态、优先级、负责人、分类、所属项目、到期、标签、关联数、时间戳）加上完整正文。

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
		return textResult(objectDetail(cat, o)), nil, nil
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
	Source     string   `json:"source,omitempty" jsonschema:"来源标记，不传默认按普通新建处理；传 inbox 表示丢进收件箱待整理"`
}

const createObjectDesc = `【会写入数据】在产品工作台里新建一个工作对象（需求、待办、项目、文档等）。

什么时候用：用户说「记一下」「建个需求」「加个待办」，或者你在对话里整理出了需要落库跟踪的事项。

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
}

const updateObjectDesc = `【会写入数据】修改一个已有的工作对象：状态、优先级、负责人、到期日、分类、标签、正文都走这个工具。

关于 status：它必须是该对象所属类型状态集里的 key，不是中文标签。不同类型的状态集不一样（需求有 backlog/planned/doing/done，待办是 todo/doing/blocked/done），改之前先用 pmw_list_types 查该类型合法的 key，传错会被工作台直接拒绝。

语义说明：
- 只传你要改的字段，没传的字段保持原值。
- body 和 tags 都是整体替换不是追加。要在原有基础上增补，先用 pmw_get_object 读回来，拼好完整内容再传。
- owner、category_id、project_id、due_at 传空串表示清空该字段。
- archived=true 是归档不是删除；本工具不提供删除能力。

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

要点：状态集是按类型隔离的——需求的 doing 和待办的 doing 是两回事，不同类型的状态 key 不能互相套用。

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

要点：分类隶属于具体类型，需求的分类不能挂到待办上。

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

const linkObjectsDesc = `【会写入数据】在两个工作对象之间建立关联，比如「这个待办阻塞了那个需求」「这两条需求重复了」。

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
