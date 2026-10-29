package sop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 流程定义（SOP-01a）：表 sop_flows，接口 /api/sop/flows，契约见 docs/api-contract.md「SOP 编排插件 sop」。
// fields、steps、layout 校验后按原样存 JSON，取回来和存进去一致；没认的字段（如 rule、ms）也原样保留。

const (
	maxName    = 100
	maxDesc    = 1000
	maxTrigger = 200
	maxFields  = 50
	maxSteps   = 200
	startKey   = "__start" // 画布上开始节点在 layout 里的 key，步骤不能用
)

// ConfigField 是节点必填的一个配置项，label 用在校验信息里。
type ConfigField struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// Case 是分支节点的一个出口。
type Case struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// NodeType 是内置节点类型里后端要用的部分，对照原型 web-next/src/nodetypes.tsx 的 NODE_TYPES；
// 名字、说明、颜色、图标、配置项的其余信息在前端。
type NodeType struct {
	Kind         string        `json:"kind"`
	Group        string        `json:"group"`
	Branching    bool          `json:"branching"`
	DefaultCases []Case        `json:"default_cases,omitempty"`
	Required     []ConfigField `json:"required"`
	// Source 是 builtin 或提供节点的插件 id（SOP-03a），只在 GET /api/sop/node-types 里填
	Source string `json:"source,omitempty"`
}

// NodeTypes 和原型 NODE_TYPES 同序；加节点类型两边一起加。插件登记的节点在 nodes_plugin.go（SOP-03a）。
var NodeTypes = []NodeType{
	{Kind: "auto", Group: "基础"},
	{Kind: "ai", Group: "基础"},
	{Kind: "knowledge", Group: "知识与数据", Required: []ConfigField{{"query", "检索问题"}}},
	{Kind: "extract", Group: "知识与数据", Required: []ConfigField{{"fields", "要提取的字段"}}},
	{Kind: "template", Group: "知识与数据", Required: []ConfigField{{"template", "模板"}}},
	{Kind: "aggregate", Group: "知识与数据"},
	{Kind: "code", Group: "知识与数据", Required: []ConfigField{{"code", "代码"}}},
	{Kind: "decide", Group: "逻辑", Branching: true, DefaultCases: []Case{{"yes", "是"}, {"no", "否"}}},
	{Kind: "classifier", Group: "逻辑", Branching: true, DefaultCases: []Case{{"c1", "类别 1"}, {"c2", "类别 2"}}},
	{Kind: "iterate", Group: "逻辑", Required: []ConfigField{{"list", "列表字段"}, {"action", "每一项做什么"}}},
	{Kind: "wait", Group: "逻辑"},
	{Kind: "review", Group: "人工"},
	{Kind: "http", Group: "外部", Required: []ConfigField{{"url", "地址"}}},
	{Kind: "notify", Group: "外部", Required: []ConfigField{{"to", "发给"}, {"content", "内容"}}},
	{Kind: "task", Group: "外部", Required: []ConfigField{{"title", "标题"}}},
	// doc、contact 原型里没有（原型用 auto 模拟），SOP-02a 新加，排在 task 后面
	{Kind: "doc", Group: "外部"},
	{Kind: "contact", Group: "外部"},
	{Kind: "agent", Group: "外部", Required: []ConfigField{{"agent", "Agent"}}},
	{Kind: "subflow", Group: "外部", Required: []ConfigField{{"sop", "执行哪个 SOP"}}},
	{Kind: "end", Group: "输出"},
}

func nodeType(kind string) (NodeType, bool) {
	for _, t := range NodeTypes {
		if t.Kind == kind {
			return t, true
		}
	}
	return NodeType{}, false
}

// Flow 是一条流程定义，形状同原型 Sop，多 version 和时间。
type Flow struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Desc      string          `json:"desc"`
	Trigger   string          `json:"trigger"`
	Fields    json.RawMessage `json:"fields"`
	Steps     json.RawMessage `json:"steps"`
	Layout    json.RawMessage `json:"layout,omitempty"`
	Version   int             `json:"version"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// Issue 是一处校验问题，step 是步骤下标（原型 checkSop 的 Issue 去掉 level，这里只收拦保存的）。
type Issue struct {
	Text string `json:"text"`
	Step *int   `json:"step,omitempty"`
}

type flows struct {
	c plugin.Core
	// activeRuns 是这条流程进行中的运行数，删除前查；SOP-01b 接上运行表
	activeRuns func(ctx context.Context, id string) (int, error)
}

var flowIDRe = regexp.MustCompile(`^sop_[a-z0-9_]{1,60}$`)

const flowCols = `id, name, description, trigger_desc, fields, steps, layout, version, created_at, updated_at`

func (h *flows) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.c.Store().Query(r.Context(), `SELECT `+flowCols+` FROM sop_flows ORDER BY created_at, rowid`)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Flow{}
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *flows) show(w http.ResponseWriter, r *http.Request) {
	f, err := h.get(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": f})
}

func (h *flows) add(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	f := Flow{Fields: json.RawMessage(`[]`), Steps: json.RawMessage(`[]`), Version: 1}
	if v, ok := raw["id"]; ok && string(v) != "null" {
		// 带 id 是为了导入原型或别处导出的流程，id 照旧
		if err := json.Unmarshal(v, &f.ID); err != nil || !flowIDRe.MatchString(f.ID) {
			fail(w, r, h.c, apiErr(errValidation, "id 必须是 sop_ 开头，后面只能是小写字母、数字、下划线，最多 60 个"))
			return
		}
		if _, err := h.get(ctx, f.ID); err == nil {
			fail(w, r, h.c, apiErr(errConflict, "流程 %s 已经存在", f.ID))
			return
		} else if !errors.Is(err, errNotFound) {
			fail(w, r, h.c, err)
			return
		}
	} else {
		f.ID = idgen.Prefixed("sop")
	}
	if err := apply(&f, raw, kindsOf(h.c)); err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO sop_flows (`+flowCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		f.ID, f.Name, f.Desc, f.Trigger, string(f.Fields), string(f.Steps), layoutCol(f.Layout), now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.get(ctx, f.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *flows) update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	f, err := h.get(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if v, ok := raw["version"]; ok && string(v) != "null" {
		var want int
		if err := json.Unmarshal(v, &want); err != nil {
			fail(w, r, h.c, apiErr(errValidation, "version 必须是整数"))
			return
		}
		if want != f.Version {
			fail(w, r, h.c, apiErr(errConflict, "流程已经被改过（现在是第 %d 版），刷新后再改", f.Version))
			return
		}
	}
	base := f.Version
	if err := apply(&f, raw, kindsOf(h.c)); err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	// 按读到的版本号更新，中间有人改过就算冲突
	res, err := h.c.Store().Exec(ctx, `UPDATE sop_flows SET name = ?, description = ?, trigger_desc = ?, fields = ?, steps = ?,
		layout = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
		f.Name, f.Desc, f.Trigger, string(f.Fields), string(f.Steps), layoutCol(f.Layout), now, id, base)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, h.c, apiErr(errConflict, "流程刚被别处改过，刷新后再改"))
		return
	}
	out, err := h.get(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *flows) remove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.get(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	n, err := h.activeRuns(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	// 指向它的定时任务也拦（SOP-01d，规格 SPEC-sop-5.7），两条用「；」连
	refs, err := h.c.SOP().Schedules(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var why []string
	if n > 0 {
		why = append(why, fmt.Sprintf("这个流程有 %d 个进行中的执行，等它们结束或终止后再删", n))
	}
	if len(refs) > 0 {
		names := make([]string, len(refs))
		for i, x := range refs {
			names[i] = "「" + x.Name + "」"
		}
		why = append(why, fmt.Sprintf("定时任务%s会发起它，先改掉或删掉这些定时任务", strings.Join(names, "、")))
	}
	if len(why) > 0 {
		fail(w, r, h.c, &blockedError{msg: strings.Join(why, "；"), schedules: refs})
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM sop_flows WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// nodeTypes 先是内置的（source 为 builtin），后面接在跑的插件登记的（source 为插件 id），停用的插件不在里面。
func (h *flows) nodeTypes(w http.ResponseWriter, _ *http.Request) {
	out := make([]NodeType, 0, len(NodeTypes))
	for _, t := range NodeTypes {
		if t.Required == nil {
			t.Required = []ConfigField{}
		}
		t.Source = "builtin"
		out = append(out, t)
	}
	for _, n := range h.c.SOP().Nodes() {
		out = append(out, pluginNodeType(n))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *flows) get(ctx context.Context, id string) (Flow, error) {
	f, err := scanFlow(h.c.Store().QueryRow(ctx, `SELECT `+flowCols+` FROM sop_flows WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return Flow{}, apiErr(errNotFound, "流程 %s 不存在", id)
	}
	return f, err
}

func scanFlow(row plugin.Row) (Flow, error) {
	var f Flow
	var fields, steps, created, updated string
	var layout *string
	if err := row.Scan(&f.ID, &f.Name, &f.Desc, &f.Trigger, &fields, &steps, &layout, &f.Version, &created, &updated); err != nil {
		return Flow{}, err
	}
	f.Fields, f.Steps = json.RawMessage(fields), json.RawMessage(steps)
	if layout != nil {
		f.Layout = json.RawMessage(*layout)
	}
	f.CreatedAt, _ = time.Parse(time.RFC3339, created)
	f.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return f, nil
}

func layoutCol(l json.RawMessage) any {
	if len(l) == 0 {
		return nil
	}
	return string(l)
}

// apply 把 body 里传了的字段写进 f，再对整条定义做一遍校验；新建和修改同一套口径。
func apply(f *Flow, raw map[string]json.RawMessage, kinds kindLookup) error {
	strField := func(key string, dst *string, limit int) error {
		v, ok := raw[key]
		if !ok {
			return nil
		}
		if err := json.Unmarshal(v, dst); err != nil {
			return apiErr(errValidation, "%s 必须是字符串", key)
		}
		*dst = strings.TrimSpace(*dst)
		if utf8.RuneCountInString(*dst) > limit {
			return apiErr(errValidation, "%s 最多 %d 字", key, limit)
		}
		return nil
	}
	if err := strField("name", &f.Name, maxName); err != nil {
		return err
	}
	if err := strField("desc", &f.Desc, maxDesc); err != nil {
		return err
	}
	if err := strField("trigger", &f.Trigger, maxTrigger); err != nil {
		return err
	}
	for key, dst := range map[string]*json.RawMessage{"fields": &f.Fields, "steps": &f.Steps} {
		v, ok := raw[key]
		if !ok {
			continue
		}
		v = bytes.TrimSpace(v)
		if len(v) == 0 || v[0] != '[' {
			return apiErr(errValidation, "%s 必须是数组", key)
		}
		*dst = compact(v)
	}
	if v, ok := raw["layout"]; ok {
		v = bytes.TrimSpace(v)
		switch {
		case string(v) == "null":
			f.Layout = nil
		case len(v) > 0 && v[0] == '{':
			f.Layout = compact(v)
		default:
			return apiErr(errValidation, "layout 必须是对象或 null")
		}
	}
	if issues := CheckWith(f, kinds); len(issues) > 0 {
		return &checkError{issues}
	}
	return nil
}

func compact(v json.RawMessage) json.RawMessage {
	var b bytes.Buffer
	if err := json.Compact(&b, v); err != nil {
		return v
	}
	return b.Bytes()
}

type sopField struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"`
	// 其余字段（options、placeholder、required、default）只查类型
	Options []struct {
		Value string `json:"value"`
		Label string `json:"label"`
	} `json:"options"`
	Placeholder string `json:"placeholder"`
	Required    bool   `json:"required"`
	Default     string `json:"default"`
}

type stepDef struct {
	Key    string    `json:"key"`
	Name   string    `json:"name"`
	Kind   string    `json:"kind"`
	Desc   string    `json:"desc"`
	Ms     *float64  `json:"ms"`
	After  *[]string `json:"after"`
	Branch *struct {
		Of   string `json:"of"`
		Case string `json:"case"`
	} `json:"branch"`
	Cases  []Case            `json:"cases"`
	Rule   string            `json:"rule"`
	Config map[string]string `json:"config"`
}

var fieldTypes = []string{"text", "textarea", "select"}

// Check 是保存前的校验，口径同原型编辑器的「检查」（web-next/src/sopedit.tsx 的 checkSop）里拦保存的那几条，
// 另加原型靠编辑器保证、接口要自己查的：步骤 key 唯一、依赖无环、分支 case 存在、字段和配置的类型。
// 原型里只是提醒的（没有人工检查点、分支下没有步骤、多个起点）不拦。
func Check(f *Flow) []Issue { return CheckWith(f, nodeType) }

// CheckWith 同 Check，节点类型按 kinds 查，插件登记的节点也认（SOP-03a）。
func CheckWith(f *Flow, kinds kindLookup) []Issue {
	var out []Issue
	add := func(step int, format string, args ...any) {
		x := Issue{Text: fmt.Sprintf(format, args...)}
		if step >= 0 {
			s := step
			x.Step = &s
		}
		out = append(out, x)
	}
	if f.Name == "" {
		add(-1, "还没有名称")
	}

	var fields []json.RawMessage
	if err := json.Unmarshal(f.Fields, &fields); err != nil {
		add(-1, "fields 必须是数组")
	}
	if len(fields) > maxFields {
		add(-1, "输入字段最多 %d 个", maxFields)
	}
	fieldKeys := map[string]bool{}
	for i, raw := range fields {
		var fd sopField
		if err := json.Unmarshal(raw, &fd); err != nil {
			add(-1, "第 %d 个输入字段格式不对：%s", i+1, jsonReason(err))
			continue
		}
		if strings.TrimSpace(fd.Label) == "" {
			add(-1, "第 %d 个输入字段没有名称", i+1)
		}
		switch {
		case fd.Key == "":
			add(-1, "第 %d 个输入字段没有 key", i+1)
		case fieldKeys[fd.Key]:
			add(-1, "输入字段 key 重复：%s", fd.Key)
		}
		fieldKeys[fd.Key] = true
		if !slices.Contains(fieldTypes, fd.Type) {
			add(-1, "第 %d 个输入字段的类型只能是 text、textarea、select", i+1)
		}
	}

	var raws []json.RawMessage
	if err := json.Unmarshal(f.Steps, &raws); err != nil {
		add(-1, "steps 必须是数组")
	}
	if len(raws) == 0 {
		add(-1, "至少要有一个步骤")
	}
	if len(raws) > maxSteps {
		add(-1, "步骤最多 %d 个", maxSteps)
	}
	steps := make([]stepDef, len(raws))
	ok := make([]bool, len(raws))
	idx := map[string]int{}
	for i, raw := range raws {
		if err := json.Unmarshal(raw, &steps[i]); err != nil {
			// 格式不对的步骤也尽量认出 key，免得引用它的步骤再报一遍「不存在」
			var k struct {
				Key string `json:"key"`
			}
			_ = json.Unmarshal(raw, &k)
			steps[i] = stepDef{Key: k.Key}
			add(i, "步骤 %d 格式不对：%s", i+1, jsonReason(err))
		} else {
			ok[i] = true
		}
		k := steps[i].Key
		switch {
		case k == "":
			add(i, "步骤 %d 没有 key", i+1)
		case k == startKey:
			add(i, "步骤 %d 的 key 不能用 %s", i+1, startKey)
		default:
			if j, dup := idx[k]; dup {
				add(i, "步骤 key 重复：%s（第 %d 步和第 %d 步）", k, j+1, i+1)
			} else {
				idx[k] = i
			}
		}
	}
	label := func(i int) string {
		if n := strings.TrimSpace(steps[i].Name); n != "" {
			return n
		}
		if steps[i].Key != "" {
			return steps[i].Key
		}
		return fmt.Sprintf("步骤 %d", i+1)
	}

	for i, s := range steps {
		if !ok[i] {
			continue
		}
		if strings.TrimSpace(s.Name) == "" {
			add(i, "步骤 %d 没有名称", i+1)
		}
		t, known := kinds(s.Kind)
		if !known {
			add(i, "「%s」的类型 %s 不存在", label(i), s.Kind)
		}
		for _, cf := range t.Required {
			if strings.TrimSpace(s.Config[cf.Key]) == "" {
				add(i, "「%s」还没填「%s」", label(i), cf.Label)
			}
		}
		if t.Branching {
			if len(s.Cases) < 2 {
				add(i, "「%s」至少要有两个分支", label(i))
			}
			seen := map[string]bool{}
			for _, c := range s.Cases {
				switch {
				case strings.TrimSpace(c.Label) == "":
					add(i, "「%s」有分支没写名称", label(i))
				case c.Key == "":
					add(i, "「%s」的分支「%s」没有 key", label(i), c.Label)
				case seen[c.Key]:
					add(i, "「%s」的分支 key 重复：%s", label(i), c.Key)
				}
				seen[c.Key] = true
			}
		}
		if s.Branch != nil {
			j, found := idx[s.Branch.Of]
			if !found || !ok[j] || !isBranching(steps[j].Kind) {
				add(i, "「%s」挂在一个不存在的判断上", label(i))
			} else if !slices.ContainsFunc(steps[j].Cases, func(c Case) bool { return c.Key == s.Branch.Case }) {
				add(i, "「%s」挂的分支 %s 在「%s」里不存在", label(i), s.Branch.Case, label(j))
			}
		}
		if s.After != nil {
			for _, k := range *s.After {
				if _, found := idx[k]; !found {
					add(i, "「%s」依赖的步骤 %s 不存在", label(i), k)
				}
			}
		}
	}

	for _, cyc := range cycles(steps, idx) {
		names := make([]string, 0, len(cyc)+1)
		for _, j := range cyc {
			names = append(names, "「"+label(j)+"」")
		}
		names = append(names, "「"+label(cyc[0])+"」")
		add(cyc[0], "依赖成环：%s", strings.Join(names, " → "))
	}

	if len(f.Layout) > 0 {
		var pos map[string]struct {
			X *float64 `json:"x"`
			Y *float64 `json:"y"`
		}
		if err := json.Unmarshal(f.Layout, &pos); err != nil {
			add(-1, "layout 格式不对：%s", jsonReason(err))
		} else {
			for k, p := range pos {
				if p.X == nil || p.Y == nil {
					add(-1, "layout 里 %s 的位置要有 x 和 y", k)
				}
			}
		}
	}
	return out
}

func isBranching(kind string) bool {
	t, ok := nodeType(kind)
	return ok && t.Branching
}

// depsOf 同原型：没写 after 的接在上一步后面，第一步是起点；引用不存在的 key 跳过（另报）。
func depsOf(steps []stepDef, idx map[string]int, i int) []int {
	var keys []string
	switch {
	case steps[i].After != nil:
		keys = *steps[i].After
	case i > 0:
		return []int{i - 1}
	}
	var out []int
	for _, k := range keys {
		if j, ok := idx[k]; ok {
			out = append(out, j)
		}
	}
	return out
}

// cycles 找依赖图里的环，每个环只报一次，从环里下标最小的步骤开始写。
func cycles(steps []stepDef, idx map[string]int) [][]int {
	const (
		unseen = iota
		onStack
		done
	)
	state := make([]int, len(steps))
	var stack []int
	var out [][]int
	seen := map[string]bool{}
	var visit func(i int)
	visit = func(i int) {
		state[i] = onStack
		stack = append(stack, i)
		for _, j := range depsOf(steps, idx, i) {
			switch state[j] {
			case unseen:
				visit(j)
			case onStack:
				at := slices.Index(stack, j)
				// 栈里是依赖方向（i 依赖 j），反过来写成执行顺序
				cyc := slices.Clone(stack[at:])
				slices.Reverse(cyc)
				m := slices.Index(cyc, slices.Min(cyc))
				cyc = append(cyc[m:], cyc[:m]...)
				sig := fmt.Sprint(cyc)
				if !seen[sig] {
					seen[sig] = true
					out = append(out, cyc)
				}
			}
		}
		stack = stack[:len(stack)-1]
		state[i] = done
	}
	for i := range steps {
		if state[i] == unseen {
			visit(i)
		}
	}
	return out
}

// jsonReason 把 encoding/json 的报错收成一句：哪个字段、要什么类型。
func jsonReason(err error) string {
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) && te.Field != "" {
		return fmt.Sprintf("%s 应该是 %s", te.Field, jsonKind(te.Type.Kind().String()))
	}
	return err.Error()
}

func jsonKind(k string) string {
	switch k {
	case "string":
		return "字符串"
	case "slice":
		return "数组"
	case "map", "struct":
		return "对象"
	case "float64", "int":
		return "数字"
	case "bool":
		return "布尔值"
	}
	return k
}
