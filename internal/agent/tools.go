package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// agentActor 标记这次写入来自 Agent。revisions 里据此区分是人改的还是 Agent 改的，
// 事后追查「这条状态怎么变的」时，这一个字段就是全部线索。
var agentActor = store.Actor{Name: "agent", Source: "agent"}

// get_object 的几个截断上限。本地小模型的上下文只有几千 token，
// 一条正文几万字的需求全量灌进去，挤掉的是系统提示词——
// 模型会连「该用英文 key」这条都忘了。截断比撑爆好，而且截断是看得见的（会写一行提示）。
const (
	maxBodyRunes     = 4000
	maxRevisions     = 10
	maxRevValueRunes = 60
	// maxOptions 是 ask_user 的选项数上限。超过五个的选择题，用户读完就已经忘了第一个。
	maxOptions = 5
)

// ToolResult 是一次工具调用的结果。三个去向各不相同，不能混：
//   - Content 回给模型，要结构化、信息密度高；
//   - Summary 给用户看，是界面上那一行「已创建 TSK-0009 …」；
//   - ObjectID 给前端做跳转链接，必须是内部 id 不是 ref——前端拿它直接 select()，
//     而 TSK-0001 这种人读编号查不到对象；人读编号已经在 Summary 里了。
type ToolResult struct {
	Summary  string
	ObjectID string
	Content  string
	Artifact *domain.Artifact
	// Question 只有 ask_user 会填。Runner 见到它就发一条 question 事件并结束本轮——
	// 答案走用户的下一条消息，流不挂在这里等。
	Question *Question
}

// Toolbox 持有一次会话的工具执行上下文。工具直接调 store，不绕回 HTTP：
// 多一跳没有任何收益，却要重新处理一遍鉴权、序列化和错误映射。
type Toolbox struct {
	st      store.Store
	session *domain.AgentSession
	// asked 是本次 Run 里已经发出的提问数。计数放在这里而不是 Runner：
	// 「还能不能再问」是 ask_user 自己的前置条件，拒绝的话要以工具结果的形式
	// 回给模型，让它改用「在方案里标成待确认」的方式收场。
	asked int
	// kbs 是会话所挂 Agent 的知识库，kb_search 只能搜这些，见 kbsearch.go
	kbs []string
	// sopAgent 是会话挂的 Agent，非 nil 时给 run_sop，见 runsop.go
	sopAgent *domain.Agent
}

func NewToolbox(st store.Store, session *domain.AgentSession) *Toolbox {
	return &Toolbox{st: st, session: session}
}

// Defs 返回给模型的工具声明。描述里写清「什么时候用」而不只是「这是什么」——
// 小模型选错工具，多半是因为描述只讲了功能没讲场景。
func (tb *Toolbox) Defs() []ToolDef {
	return append([]ToolDef{
		{
			Name: "search_objects",
			Description: "按关键词搜索已有的工作对象。创建任何新对象之前都应该先用它查重，" +
				"避免把同一件事记两遍。",
			Parameters: obj(props{
				"query":   str("搜索关键词，匹配标题和正文"),
				"type_id": str("限定类型，如 task / requirement；留空表示全部类型"),
				"limit":   num("最多返回几条，默认 10"),
			}, nil),
		},
		{
			Name: "list_types",
			Description: "列出所有可用的工作对象类型，以及每种类型下合法的状态 key。" +
				"不确定 type_id 或 status 该填什么时调用它。",
			Parameters: obj(props{}, nil),
		},
		{
			Name: "create_object",
			Description: "创建一个新的工作对象（待办、需求、项目、文档、资源或笔记）。" +
				"用户说「记一下」「明天要」「有个需求」时用它。",
			Parameters: obj(props{
				"type_id":  str("类型，如 task（待办）、requirement（需求）、note（笔记）"),
				"title":    str("一句话标题，把用户的口语整理清楚"),
				"body":     str("补充说明，可留空"),
				"status":   str("状态 key，如 todo；留空则用该类型的默认状态"),
				"priority": str("优先级 P0/P1/P2/P3，留空表示未定"),
				"due_at":   str("到期时间。" + dueHint + "。用户说了具体时刻就带上时刻，不要只给日期"),
				"tags":     arr("标签名列表"),
			}, []string{"type_id", "title"}),
		},
		{
			Name: "update_object",
			Description: "修改已有对象的状态、优先级、到期时间、分类或标签。" +
				"用户说「那条改成进行中」「延到下周」时用它。",
			Parameters: obj(props{
				"ref":         str("对象编号，如 TSK-0009；也接受对象 id"),
				"title":       str("新标题"),
				"body":        str("新正文"),
				"status":      str("新状态 key"),
				"priority":    str("新优先级 P0/P1/P2/P3"),
				"due_at":      str("新到期时间。" + dueHint + "；传空字符串表示清除"),
				"category_id": str("新分类 id"),
				"tags":        arr("整套标签，会覆盖原有标签"),
			}, []string{"ref"}),
		},
		{
			Name: "get_object",
			Description: "读取一个对象的完整内容：正文全文、关联的其它对象、最近的修改记录。" +
				"要为某条需求/待办出处理方案、写分析文档之前，先用它把这条读全——" +
				"search_objects 只给标题，照着标题写出来的方案放在哪条需求上都成立，等于没写。",
			Parameters: obj(props{
				"ref": str("对象编号，如 REQ-0012；也接受对象 id"),
			}, []string{"ref"}),
		},
		{
			Name: "ask_user",
			Description: "把一个你拿不准的问题抛回给用户，让他在你给的选项里选。" +
				"只在答案取决于用户意图或库里根本没有的外部信息时才用；" +
				"优先级、状态、负责人、关联了哪些任务这类库里查得到的，自己去查，不要问。" +
				"调用之后本轮对话就结束了，用户的回答会作为下一条消息发给你。",
			Parameters: obj(props{
				"question": str("一句话问题，问到点子上；不要问「你觉得呢」这种没有信息量的问题"),
				"options": optArr("这个问题的备选答案，2 到 5 个。每项 label 是一个具体答案，" +
					"detail 说明选它意味着什么。不要往这里塞并列的话题——" +
					"那说明你有好几个问题，该分开多次调用"),
				"multi": boolean("用户能不能多选，默认 false"),
			}, []string{"question", "options"}),
		},
		{
			Name: "write_file",
			Description: "把内容写入本次会话的产物目录。用户要一份文档、表格、清单时用它，" +
				"不要把长内容直接铺在回复里。路径必须是相对当前目录的写法。",
			Parameters: obj(props{
				"path":    str("相对路径，如 角色权限矩阵.md 或 docs/方案.md；不能用绝对路径或 .."),
				"content": str("文件的完整内容"),
			}, []string{"path", "content"}),
		},
	}, append(tb.kbDefs(), tb.sopDefs()...)...)
}

// Invoke 执行一次工具调用。
//
// 错误一律作为**正常返回值**回给模型（Content 里写明失败原因），而不是中断整轮对话：
// 参数填错是模型最常见的失误，把原因告诉它，它下一轮通常能自己改对；
// 直接报错终止的话，用户看到的就只是一句没头没尾的失败。
func (tb *Toolbox) Invoke(ctx context.Context, call ToolCall) ToolResult {
	args := map[string]any{}
	if err := json.Unmarshal([]byte(defaultArgs(call.Args)), &args); err != nil {
		return failed(call.Name, "参数不是合法的 JSON，请重新生成这次调用")
	}

	switch call.Name {
	case "search_objects":
		return tb.searchObjects(ctx, args)
	case "list_types":
		return tb.listTypes(ctx)
	case "create_object":
		return tb.createObject(ctx, args)
	case "update_object":
		return tb.updateObject(ctx, args)
	case "get_object":
		return tb.getObject(ctx, args)
	case "ask_user":
		return tb.askUser(args)
	case "write_file":
		return tb.writeFile(ctx, args)
	case toolKbSearch:
		return tb.kbSearch(ctx, args)
	case toolRunSOP:
		return tb.runSOP(ctx, args)
	default:
		return failed(call.Name, fmt.Sprintf("没有名为 %s 的工具", call.Name))
	}
}

// --- 各工具实现 ---

func (tb *Toolbox) listTypes(ctx context.Context) ToolResult {
	types, err := tb.st.ListObjectTypes(ctx)
	if err != nil {
		return failed("list_types", "读取类型失败")
	}
	var b strings.Builder
	for _, t := range types {
		keys := make([]string, 0, len(t.Statuses))
		for _, st := range t.Statuses {
			keys = append(keys, st.Key)
		}
		fmt.Fprintf(&b, "type_id=%s 名称=%s 状态=[%s]\n", t.ID, t.Name, strings.Join(keys, ","))
	}
	return ToolResult{
		Summary: fmt.Sprintf("查看了 %d 种对象类型", len(types)),
		Content: b.String(),
	}
}

func (tb *Toolbox) searchObjects(ctx context.Context, args map[string]any) ToolResult {
	q := argStr(args, "query")
	limit := argInt(args, "limit", 10)
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	f := domain.ObjectFilter{Query: q, Limit: limit, Sort: "-updated_at"}
	if t := argStr(args, "type_id"); t != "" {
		f.TypeIDs = []string{t}
	}

	items, total, err := tb.st.ListObjects(ctx, f)
	if err != nil {
		return failed("search_objects", "搜索失败")
	}
	if len(items) == 0 {
		return ToolResult{
			Summary: fmt.Sprintf("搜索「%s」没有找到已有对象", q),
			Content: "没有匹配的对象，可以放心创建新的。",
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "共 %d 条，列出前 %d 条：\n", total, len(items))
	for _, o := range items {
		fmt.Fprintf(&b, "- %s [%s/%s] %s\n", o.Ref, o.TypeID, o.Status, o.Title)
	}
	return ToolResult{
		Summary: fmt.Sprintf("搜索「%s」找到 %d 条已有对象", q, total),
		Content: b.String(),
	}
}

func (tb *Toolbox) createObject(ctx context.Context, args map[string]any) ToolResult {
	typeID := argStr(args, "type_id")
	title := argStr(args, "title")
	if typeID == "" || title == "" {
		return failed("create_object", "type_id 和 title 都是必填的")
	}

	o := &domain.Object{
		TypeID:   typeID,
		Title:    title,
		Body:     argStr(args, "body"),
		Status:   argStr(args, "status"),
		Priority: strings.ToUpper(argStr(args, "priority")),
		Source:   "agent", // 与 revisions 的 source 呼应：这条是 Agent 建的
		Tags:     argStrs(args, "tags"),
	}
	if due := argStr(args, "due_at"); due != "" {
		t, err := parseDue(due)
		if err != nil {
			return failed("create_object", fmt.Sprintf(
				"due_at 解析不了「%s」。%s。请用修正后的参数重新调用 create_object", due, dueHint))
		}
		o.DueAt = t
	}

	tb.applySource(ctx, o)

	out, err := tb.st.CreateObject(ctx, o, agentActor)
	if err != nil {
		// store 的校验错误（类型不存在、状态非法）原样告诉模型，它据此改参数重试。
		return failed("create_object", "创建失败："+err.Error())
	}
	return ToolResult{
		Summary:  fmt.Sprintf("已创建 %s %s", out.Ref, out.Title),
		ObjectID: out.ID,
		Content: fmt.Sprintf("创建成功：ref=%s id=%s type=%s status=%s title=%s",
			out.Ref, out.ID, out.TypeID, out.Status, out.Title),
	}
}

// applySource 把会话的来源（0047，会话从哪条记录发起的）记到新建对象的 props.source_ref，
// 来源里有 project_id、对象自己没挂项目时缺省挂到这个项目（项目删了、不是项目就不挂）。
// 这样从 IM 消息发起的会话里拆出来的任务，和「转任务」建的一样能追回消息、落在消息归属的项目下，
// 不靠模型照抄一段 JSON。建的是项目本身时不挂项目。
func (tb *Toolbox) applySource(ctx context.Context, o *domain.Object) {
	if tb.session == nil || len(tb.session.SourceRef) == 0 {
		return
	}
	ref := make(map[string]any, len(tb.session.SourceRef))
	for k, v := range tb.session.SourceRef {
		ref[k] = v
	}
	if o.Props == nil {
		o.Props = map[string]any{}
	}
	if _, ok := o.Props[domain.PropSourceRef]; !ok {
		o.Props[domain.PropSourceRef] = ref
	}
	pid, _ := ref["project_id"].(string)
	if pid = strings.TrimSpace(pid); pid == "" || o.ProjectID != nil || o.TypeID == "project" {
		return
	}
	if p, err := tb.st.GetObject(ctx, pid); err == nil && p.TypeID == "project" && p.DeletedAt == nil {
		o.ProjectID = &pid
	}
}

func (tb *Toolbox) updateObject(ctx context.Context, args map[string]any) ToolResult {
	ref := argStr(args, "ref")
	if ref == "" {
		return failed("update_object", "ref 是必填的，请先用 search_objects 找到对象编号")
	}
	target, err := tb.resolveRef(ctx, ref)
	if err != nil {
		return failed("update_object", fmt.Sprintf("找不到编号为 %s 的对象", ref))
	}

	var p domain.ObjectPatch
	changed := []string{}
	if v, ok := argStrOK(args, "title"); ok {
		p.Title, changed = &v, append(changed, "标题")
	}
	if v, ok := argStrOK(args, "body"); ok {
		p.Body, changed = &v, append(changed, "正文")
	}
	if v, ok := argStrOK(args, "status"); ok {
		p.Status, changed = &v, append(changed, "状态")
	}
	if v, ok := argStrOK(args, "priority"); ok {
		u := strings.ToUpper(v)
		p.Priority, changed = &u, append(changed, "优先级")
	}
	if v, ok := argStrOK(args, "category_id"); ok {
		// 同样是双指针：内层 nil（对应传空串）表示移出分类，变成未分类。
		var cat *string
		if v != "" {
			cat = &v
		}
		p.CategoryID, changed = &cat, append(changed, "分类")
	}
	if v, ok := args["tags"]; ok && v != nil {
		tags := argStrs(args, "tags")
		p.Tags, changed = &tags, append(changed, "标签")
	}
	if v, ok := argStrOK(args, "due_at"); ok {
		changed = append(changed, "到期时间")
		if v == "" {
			// 双指针的意义就在这：内层 nil 表示「清除」，整个字段为 nil 才是「不改」。
			var none *time.Time
			p.DueAt = &none
		} else {
			t, err := parseDue(v)
			if err != nil {
				return failed("update_object", fmt.Sprintf(
					"due_at 解析不了「%s」。%s。请用修正后的参数重新调用 update_object", v, dueHint))
			}
			p.DueAt = &t
		}
	}
	if len(changed) == 0 {
		return failed("update_object", "没有给出任何要修改的字段")
	}

	out, err := tb.st.UpdateObject(ctx, target.ID, p, agentActor)
	if err != nil {
		return failed("update_object", "修改失败："+err.Error())
	}
	return ToolResult{
		Summary:  fmt.Sprintf("已更新 %s 的%s", out.Ref, strings.Join(changed, "、")),
		ObjectID: out.ID,
		Content: fmt.Sprintf("更新成功：ref=%s status=%s priority=%s title=%s",
			out.Ref, out.Status, out.Priority, out.Title),
	}
}

// resolveRef 同时认对象编号（TSK-0009）和内部 id。模型两种都可能给出来，
// 强行只认一种只会换来一轮无谓的重试。
func (tb *Toolbox) resolveRef(ctx context.Context, ref string) (*domain.Object, error) {
	ref = strings.TrimSpace(ref)
	if o, err := tb.st.GetObject(ctx, ref); err == nil {
		return o, nil
	}
	items, _, err := tb.st.ListObjects(ctx, domain.ObjectFilter{Query: ref, Limit: 20})
	if err != nil {
		return nil, err
	}
	for _, o := range items {
		if strings.EqualFold(o.Ref, ref) {
			return o, nil
		}
	}
	return nil, fmt.Errorf("object not found")
}

// maxQuestions 是一次 Run 里最多能问的问题数。
//
// 不设上限的话失败模式很具体：模型问一个、用户答一个、它接着又冒出一个，
// 一件事问到第五轮用户已经自己做完了。三个是「真的有几处拿不准」的上限，
// 再多说明它没在查库，只是在拿提问代替工作。
const maxQuestions = 3

// getObject 把一条对象读全：正文、关联对象、最近修订。
//
// 三样一次给齐而不是拆成三个工具：本地小模型每多一次工具往返就多一次跑偏的机会，
// 而「写一份需求分析」这件事本来就要这三样凑齐才动得了笔。
func (tb *Toolbox) getObject(ctx context.Context, args map[string]any) ToolResult {
	ref := argStr(args, "ref")
	if ref == "" {
		return failed("get_object", "ref 是必填的，先用 search_objects 找到对象编号")
	}
	o, err := tb.resolveRef(ctx, ref)
	if err != nil {
		return failed("get_object", fmt.Sprintf("找不到编号为 %s 的对象", ref))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s 「%s」\n", o.Ref, o.Title)
	fmt.Fprintf(&b, "type=%s status=%s priority=%s\n", o.TypeID, o.Status, dash(o.Priority))
	fmt.Fprintf(&b, "负责人=%s 到期=%s\n", dash(ownerName(o)), dash(fmtTime(o.DueAt)))
	if o.ProjectTitle != "" {
		fmt.Fprintf(&b, "所属项目=%s\n", o.ProjectTitle)
	}
	if o.CategoryPath != "" {
		fmt.Fprintf(&b, "分类=%s\n", o.CategoryPath)
	}
	if len(o.Tags) > 0 {
		fmt.Fprintf(&b, "标签=%s\n", strings.Join(o.Tags, "、"))
	}
	if len(o.Participants) > 0 {
		names := make([]string, 0, len(o.Participants))
		for _, p := range o.Participants {
			names = append(names, p.Name)
		}
		fmt.Fprintf(&b, "参与人=%s\n", strings.Join(names, "、"))
	}

	b.WriteString("\n## 正文\n")
	if strings.TrimSpace(o.Body) == "" {
		b.WriteString("（这条对象没有正文。这本身就是一条信息：需求只有一个标题，" +
			"说明细节还在用户脑子里，方案里要么问清楚要么把假设写明。）\n")
	} else {
		b.WriteString(clip(o.Body, maxBodyRunes))
		b.WriteString("\n")
	}

	b.WriteString("\n## 关联对象\n")
	links, err := tb.st.ListLinks(ctx, o.ID)
	switch {
	case err != nil:
		b.WriteString("（读取关联失败）\n")
	case len(links) == 0:
		b.WriteString("（没有关联对象）\n")
	default:
		for _, l := range links {
			peer := l.Peer
			if peer == nil {
				continue
			}
			// 方向要写出来：A blocks B 和 B blocks A 是两件相反的事，
			// 只给关系名会让模型把「我在等别人」写成「别人在等我」。
			arrow := "→"
			if l.Direction == "in" {
				arrow = "←"
			}
			fmt.Fprintf(&b, "- %s %s %s [%s/%s] %s\n",
				l.Relation, arrow, peer.Ref, peer.TypeID, peer.Status, peer.Title)
		}
	}

	b.WriteString("\n## 最近修订\n")
	revs, err := tb.st.ListRevisions(ctx, o.ID, maxRevisions)
	switch {
	case err != nil:
		b.WriteString("（读取修订失败）\n")
	case len(revs) == 0:
		b.WriteString("（还没有改动记录）\n")
	default:
		for _, r := range revs {
			fmt.Fprintf(&b, "- %s %s(%s) %s：%s → %s\n",
				r.CreatedAt.Local().Format("2006-01-02 15:04"),
				dash(r.Actor), dash(r.Source), r.Field,
				clip(oneLine(r.OldValue), maxRevValueRunes),
				clip(oneLine(r.NewValue), maxRevValueRunes))
		}
	}

	return ToolResult{
		Summary:  fmt.Sprintf("读取了 %s %s", o.Ref, o.Title),
		ObjectID: o.ID,
		Content:  b.String(),
	}
}

// askUser 把模型的一次提问整理成 Question。
//
// 校验故意严格：选项少于两个的「提问」其实是通知，只有 label 没有 detail 的选项
// 等于在逼用户猜「选这个会怎样」。不合格一律以工具结果的形式退回，模型下一轮能自己改对；
// 放行的话，代价要用户来付。
func (tb *Toolbox) askUser(args map[string]any) ToolResult {
	if tb.asked >= maxQuestions {
		return failed("ask_user", fmt.Sprintf(
			"本轮已经问了 %d 个问题，不能再问了。用现在手上的信息把方案写完，"+
				"仍然拿不准的地方在方案里写成「待确认：…」，不要再调 ask_user", maxQuestions))
	}

	q := strings.TrimSpace(argStr(args, "question"))
	if q == "" {
		return failed("ask_user", "question 是必填的")
	}
	// 以冒号收尾的不是问题，是开场白——真机上见过「这条需求的推进方案需要先厘清两个问题：」
	// 后面跟着一组分属两个不同问题的选项，用户只能挑一个，另一个就永远没人答。
	// 这一条卡得住那个形状，而且几乎不会误伤：没有哪个真问题是以冒号结尾的。
	if strings.HasSuffix(q, "：") || strings.HasSuffix(q, ":") {
		return failed("ask_user", fmt.Sprintf(
			"「%s」以冒号结尾，这是开场白不是问题。question 要写成一个能被一个选项答掉的问句；"+
				"你要是有好几个问题，就分几次调用 ask_user，每次问一个", q))
	}
	opts, err := parseOptions(args["options"])
	if err != nil {
		return failed("ask_user", err.Error())
	}

	tb.asked++
	out := &Question{
		ID:       idgen.Prefixed("q"),
		Question: q,
		Options:  opts,
		Multi:    argBool(args, "multi"),
	}
	return ToolResult{
		Summary:  "向用户提了一个问题：" + q,
		Question: out,
		// 回给模型的内容要说清「本轮到此为止」，否则它会接着往下写，
		// 把刚问出口的问题当成已经有答案了。
		Content: "问题已经抛给用户了。本轮到此为止，不要再调用任何工具，" +
			"也不要替用户回答或者往下推进——用户的选择会作为下一条消息发给你。",
	}
}

// parseOptions 解析 ask_user 的 options。除了标准的对象数组，还认
// "选项名|说明" 这种字符串写法：4B 级别的模型时不时会把嵌套对象拍平成字符串，
// 为此白白浪费一轮重试不值得。
func parseOptions(raw any) ([]QuestionOption, error) {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil, fmt.Errorf("options 必须是数组，给 2 到 5 个备选答案")
	}
	if len(list) < 2 {
		return nil, fmt.Errorf("只给一个选项不算提问。要么给至少两个真正不同的选项，要么别问")
	}
	if len(list) > maxOptions {
		return nil, fmt.Errorf("选项最多 %d 个，超过这个数用户读都读不完，先合并再问", maxOptions)
	}

	out := make([]QuestionOption, 0, len(list))
	for i, it := range list {
		var label, detail string
		switch v := it.(type) {
		case map[string]any:
			label = strings.TrimSpace(argStr(v, "label"))
			detail = strings.TrimSpace(argStr(v, "detail"))
		case string:
			label, detail, _ = strings.Cut(v, "|")
			label, detail = strings.TrimSpace(label), strings.TrimSpace(detail)
		default:
			return nil, fmt.Errorf("第 %d 个选项既不是对象也不是字符串", i+1)
		}
		if label == "" {
			return nil, fmt.Errorf("第 %d 个选项没有 label", i+1)
		}
		if detail == "" {
			return nil, fmt.Errorf(
				"第 %d 个选项「%s」没有写 detail。detail 要说清选它意味着什么、"+
					"有什么代价；写不出来说明这个选项你自己也没想清楚，那就别给它", i+1, label)
		}
		out = append(out, QuestionOption{Label: label, Detail: detail})
	}
	return out, nil
}

// writeFile 是 Agent 唯一的写盘出口，路径安全全靠 ResolveInWorkdir 把关。
func (tb *Toolbox) writeFile(ctx context.Context, args map[string]any) ToolResult {
	rel := argStr(args, "path")
	content := argStr(args, "content")

	abs, err := ResolveInWorkdir(tb.session.Workdir, rel)
	if err != nil {
		// 越界原因原样告诉模型，让它改用合法的相对路径重试。
		return failed("write_file", err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return failed("write_file", "创建目录失败，请检查产物目录权限")
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return failed("write_file", "写入文件失败，请检查产物目录权限")
	}

	// 库里存相对 workdir 的路径：换目录时只要改会话一行，产物索引整体跟着搬。
	// 这里重新从解析后的绝对路径倒推，而不是直接用模型给的 rel——
	// rel 可能是 ./a/../b.md 这种没折平的写法，存进去会让同一个文件出现两条记录。
	root, rerr := filepath.EvalSymlinks(tb.session.Workdir)
	if rerr != nil {
		root = tb.session.Workdir
	}
	stored, rerr := filepath.Rel(root, abs)
	if rerr != nil {
		stored = filepath.Clean(rel)
	}

	size := int64(len(content))
	// 调试对话没有会话（AG-02c），产物不挂会话
	var sid *string
	if tb.session.ID != "" {
		sid = &tb.session.ID
	}
	// 产物登记走通用的 artifacts 表：一条产物同时带上会话（出处）和对象（归属）。
	// 只挂会话的话，用户在任务详情里看「这件事产出了什么」会是空的——
	// 对话在对象里，产物却记在会话上，两者对不上。
	art, err := tb.st.RecordArtifact(ctx, domain.ArtifactInput{
		ObjectID:  tb.session.ObjectID,
		SessionID: sid,
		Path:      stored,
		BaseDir:   tb.session.Workdir,
		Platform:  "local",
		Size:      size,
		Source:    domain.ArtifactSourceAgent,
	})
	if err != nil {
		// 文件已经落盘了，索引没记上不该让用户以为写失败——降级成一条没有 id 的记录。
		art = &domain.Artifact{
			SessionID: sid,
			Path:      filepath.Join(tb.session.Workdir, stored),
			BaseDir:   tb.session.Workdir,
			RelPath:   stored,
			Size:      size,
			Source:    domain.ArtifactSourceAgent,
		}
	}

	return ToolResult{
		Summary:  fmt.Sprintf("已写入 %s（%d 字节）", stored, size),
		Content:  fmt.Sprintf("写入成功：%s，共 %d 字节", stored, size),
		Artifact: art,
	}
}

// --- 参数读取 ---
//
// 模型给出的参数类型经常飘（数字给成字符串、单值给成数组），
// 这几个 helper 统一做宽松解析，省得每个工具各写一遍。

func argStr(args map[string]any, key string) string {
	v, _ := argStrOK(args, key)
	return v
}

// argStrOK 的第二个返回值区分「没给这个字段」和「给了空字符串」。
// update_object 的 due_at 靠它表达「清除到期时间」。
func argStrOK(args map[string]any, key string) (string, bool) {
	raw, ok := args[key]
	if !ok || raw == nil {
		return "", false
	}
	switch v := raw.(type) {
	case string:
		return strings.TrimSpace(v), true
	case float64:
		return strings.TrimSuffix(fmt.Sprintf("%.0f", v), ".0"), true
	case bool:
		return fmt.Sprintf("%t", v), true
	default:
		return "", false
	}
}

func argInt(args map[string]any, key string, def int) int {
	raw, ok := args[key]
	if !ok || raw == nil {
		return def
	}
	switch v := raw.(type) {
	case float64:
		return int(v)
	case string:
		var n int
		if _, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &n); err == nil {
			return n
		}
	}
	return def
}

// argBool 接受 true/false，也接受模型偶尔给出的 "true" / 1 这类写法。
func argBool(args map[string]any, key string) bool {
	raw, ok := args[key]
	if !ok || raw == nil {
		return false
	}
	switch v := raw.(type) {
	case bool:
		return v
	case string:
		s := strings.ToLower(strings.TrimSpace(v))
		return s == "true" || s == "yes" || s == "1"
	case float64:
		return v != 0
	}
	return false
}

// argStrs 额外接受单个字符串：模型常把只有一个标签的情况写成裸字符串而不是数组。
func argStrs(args map[string]any, key string) []string {
	raw, ok := args[key]
	if !ok || raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, it := range v {
			if s, ok := it.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
		return out
	case string:
		if s := strings.TrimSpace(v); s != "" {
			return []string{s}
		}
	}
	return nil
}

// dueLayouts 是 due_at 接受的时间格式，按「信息量从多到少」排列。
//
// 中间那四个不带时区的格式是真机跑出来才补上的：用户说「明天下午」「上午十点」时，
// 模型给的是 2026-09-16T14:00:00 这种本地时间——它不知道用户在哪个时区，所以不带偏移。
// 而这个串**既不是合法 RFC3339**（RFC3339 强制要求 Z 或 +08:00 这样的偏移），
// **也不是纯日期**，恰好卡在两个标准之间的缝里，两边都不认。
// 只要用户说的话里带时刻，就必然撞上，不是小概率。
//
// 不带时区的一律按 time.Local 解析：这是个单机本地工具，用户嘴里的「下午两点」
// 就是他自己电脑上的两点，按 UTC 解析会平移出时差。
var dueLayouts = []string{
	time.RFC3339,          // 2026-09-16T14:00:00+08:00 / …Z，带时区，信息最全
	"2006-01-02T15:04:05", // 模型最常给的那种
	"2006-01-02 15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04",
}

// dueHint 同时用于工具 schema 的字段说明和解析失败的报错。
// 两处共用一份，避免「描述说支持、报错说不支持」这种自相矛盾把模型带偏。
const dueHint = "可用格式：2026-09-16、2026-09-16 14:00、2026-09-16T14:00:00、或带时区的 RFC3339"

// parseDue 解析到期时间。带时刻的按时刻走；纯日期落在当天 23:59:59 本地时间——
// 「明天到期」指的是明天结束前，落在 00:00 会让它当天一开始就算逾期。
func parseDue(s string) (*time.Time, error) {
	s = strings.TrimSpace(s)
	for _, layout := range dueLayouts {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return &t, nil
		}
	}
	// 纯日期没有时刻信息，补到当天最后一秒。
	if d, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		t := d.Add(23*time.Hour + 59*time.Minute + 59*time.Second)
		return &t, nil
	}
	return nil, fmt.Errorf("unrecognized date %q", s)
}

func failed(tool, reason string) ToolResult {
	return ToolResult{
		Summary: fmt.Sprintf("%s 执行失败：%s", tool, reason),
		Content: "错误：" + reason,
	}
}

// --- 展示辅助 ---

// dash 把空字符串显示成一个短横。给模型看的文本里，"负责人=" 后面留白会被它读成
// 「这里有个东西但我没看清」，然后编一个出来；一个明确的「未设置」不会。
func dash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "未设置"
	}
	return s
}

func ownerName(o *domain.Object) string {
	if o.OwnerName != "" {
		return o.OwnerName
	}
	return o.Owner
}

func fmtTime(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Local().Format("2006-01-02 15:04")
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// clip 按 rune 截断并显式标注截掉了多少。不标注的话模型会把半句话当成全文，
// 在方案里引用一个根本不存在的结论。
func clip(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + fmt.Sprintf("\n…（正文过长，此处截断，还剩约 %d 字未显示）", len(r)-max)
}

// --- JSON Schema 构造 ---

type props = map[string]any

func obj(p props, required []string) map[string]any {
	out := map[string]any{"type": "object", "properties": p}
	// required 为空时也要给一个空数组：部分兼容端点对缺字段的 schema 会直接报错。
	if required == nil {
		required = []string{}
	}
	out["required"] = required
	return out
}

func str(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func num(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func boolean(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

// optArr 是 ask_user 的 options：一个对象数组，每项要 label 和 detail。
// detail 列进 required 是有意的——只给 label 的选项等于让用户猜选它会怎样。
func optArr(desc string) map[string]any {
	return map[string]any{
		"type":        "array",
		"description": desc,
		"items": obj(props{
			"label":  str("选项名，一句短话"),
			"detail": str("选这个意味着什么、有什么代价。必填"),
		}, []string{"label", "detail"}),
	}
}

func arr(desc string) map[string]any {
	return map[string]any{
		"type":        "array",
		"description": desc,
		"items":       map[string]any{"type": "string"},
	}
}
