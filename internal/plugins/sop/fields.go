package sop

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

// 这一步能拿到的字段（TSK-0490）：按声明静态推出来，不用跑一次。输入是触发方式自动带入的字段、输入字段、
// 沿依赖往上每一步声明的输出（输出默认是「输入原样往下传，再加上声明的字段」）；结束节点挑了字段的只留那几个往下传；
// 被条件回退退回的目标步骤多一个 feedback。插件停用、没声明输出的上游让这一组标 open（可能还有别的字段）。
//
// 结构化条件的字段校验（check.go）、编辑器的字段候选（POST /api/sop/step-fields）用这一份。
// TSK-0491（试跑 / 调试）衔接：FieldInfo 的 Sample 是调试时取到的真实值，Declared 为 false 的是「实际返回了但没声明」的字段，
// 由调试结果叠加进来；这里只出静态声明（Declared 都是 true，Sample 都没有）。

// FieldInfo 是能拿到的一个字段。
type FieldInfo struct {
	Path    string   `json:"path"`
	Type    string   `json:"type"`
	Label   string   `json:"label"`
	Values  []Option `json:"values,omitempty"`
	Example string   `json:"example,omitempty"`
	// Open 是对象下面还有没列全的子字段（同 Output.Open）
	Open bool `json:"open,omitempty"`
	// Declared 是声明里有的（静态推出来的都是 true）；TSK-0491 调试时实际返回、没声明的字段为 false
	Declared bool `json:"declared"`
	// Sample 是调试时取到的真实值（TSK-0491 填），静态推断时不带
	Sample any `json:"sample,omitempty"`
}

// FieldGroup 是按来源分的一组字段。
type FieldGroup struct {
	// Source 是 trigger（触发方式自动带入）、input（输入字段）、step（上游步骤的输出）、loopback（被退回重做时带上的）
	Source string `json:"source"`
	Step   string `json:"step,omitempty"`
	Kind   string `json:"kind,omitempty"`
	Label  string `json:"label"`
	// Open 是这一组可能还有没列出的字段（上游节点没声明输出，比如提供它的插件停用了）
	Open   bool        `json:"open"`
	Fields []FieldInfo `json:"fields"`
}

// flowFields 是一条流程里每一步能拿到的字段，按需算、记下来。
type flowFields struct {
	trigger  Trigger
	hasTrig  bool
	inputs   []FieldInfo
	steps    []stepDef
	ok       []bool
	idx      map[string]int
	kinds    kindLookup
	cache    map[int][]FieldGroup
	visiting map[int]bool
}

func newFlowFields(f *Flow, steps []stepDef, ok []bool, idx map[string]int, kinds kindLookup) *flowFields {
	ff := &flowFields{steps: steps, ok: ok, idx: idx, kinds: kinds, cache: map[int][]FieldGroup{}, visiting: map[int]bool{}}
	ff.trigger, ff.hasTrig = triggerOf(f.Trigger)
	var fields []sopField
	_ = json.Unmarshal(f.Fields, &fields)
	for _, fd := range fields {
		if fd.Key == "" {
			continue
		}
		fi := FieldInfo{Path: fd.Key, Type: "string", Label: orDefault(fd.Label, fd.Key), Declared: true}
		for _, o := range fd.Options {
			fi.Values = append(fi.Values, Option{Value: o.Value, Label: orDefault(o.Label, o.Value)})
		}
		ff.inputs = append(ff.inputs, fi)
	}
	return ff
}

// base 是开始节点交给第一步的：触发方式自动带入的字段、输入字段（和自动带入同名的只列在自动带入里）。
func (ff *flowFields) base() []FieldGroup {
	var out []FieldGroup
	auto := map[string]bool{}
	if ff.hasTrig && len(ff.trigger.Outputs) > 0 {
		g := FieldGroup{Source: "trigger", Label: ff.trigger.Label + "自动带入", Fields: []FieldInfo{}}
		for _, o := range ff.trigger.Outputs {
			g.Fields = append(g.Fields, outInfo(o, o.Path))
			auto[o.Path] = true
		}
		out = append(out, g)
	}
	// 手动发起的流程，发起方（Agent 的 run_sop、别的插件、父流程的子流程节点）可以带进没声明的字段，这一组标 open；
	// IM、定时触发带进来的就是声明的那些
	g := FieldGroup{Source: "input", Label: "输入字段", Fields: []FieldInfo{}, Open: !ff.hasTrig || !ff.trigger.Auto}
	for _, fi := range ff.inputs {
		if !auto[fi.Path] {
			g.Fields = append(g.Fields, fi)
		}
	}
	if len(g.Fields) > 0 || g.Open {
		out = append(out, g)
	}
	return out
}

func outInfo(o Output, path string) FieldInfo {
	return FieldInfo{Path: path, Type: orDefault(o.Type, "any"), Label: o.Label, Values: o.Values, Example: o.Example, Open: o.Open, Declared: true}
}

// at 是第 i 步的输入里能拿到的字段（i 为 -1 是开始节点交出去的）。
func (ff *flowFields) at(i int) []FieldGroup {
	if i < 0 || i >= len(ff.steps) {
		return ff.base()
	}
	if g, ok := ff.cache[i]; ok {
		return g
	}
	if ff.visiting[i] {
		// 依赖成环（保存校验另报），这一步按开始节点算
		return ff.base()
	}
	ff.visiting[i] = true
	defer delete(ff.visiting, i)
	deps := depsOf(ff.steps, ff.idx, i)
	if ff.steps[i].Branch != nil {
		if j, ok := ff.idx[ff.steps[i].Branch.Of]; ok && !slices.Contains(deps, j) {
			deps = append(deps, j)
		}
	}
	var groups []FieldGroup
	if len(deps) == 0 {
		groups = ff.base()
	}
	for _, j := range deps {
		groups = mergeGroups(groups, ff.after(j))
	}
	if ff.loopTarget(i) {
		groups = append(groups, FieldGroup{Source: "loopback", Label: "被条件回退退回重做时带上", Fields: []FieldInfo{
			{Path: "feedback", Type: "object", Label: "退回时那一步的输入，另有 round（第几轮）、reason（原因）、from（哪一步退回的）", Declared: true},
		}})
	}
	ff.cache[i] = groups
	return groups
}

// after 是第 j 步的输出里能拿到的：输入原样往下传，加上它声明的字段；结束节点挑了字段的只留那几个。
func (ff *flowFields) after(j int) []FieldGroup {
	in := ff.at(j)
	s := ff.steps[j]
	if s.Kind == "end" {
		if keep := list(s.Config["outputs"]); len(keep) > 0 {
			return keepFields(in, keep)
		}
	}
	t, known := ff.kinds(s.Kind)
	g := FieldGroup{Source: "step", Step: s.Key, Kind: s.Kind, Label: stepLabel(s, t), Fields: []FieldInfo{}}
	if !known || !ff.ok[j] || !t.declared() {
		g.Open = true
	} else {
		for _, o := range t.Outputs {
			g.Fields = append(g.Fields, outInfo(o, expandPath(o.Path, s.Config, t.Params)))
		}
		if s.Kind == "extract" {
			for _, k := range list(s.Config["fields"]) {
				g.Fields = append(g.Fields, FieldInfo{Path: "extracted." + k, Type: "string", Label: "提取出的「" + k + "」", Declared: true})
			}
		}
	}
	if len(g.Fields) == 0 && !g.Open {
		return in
	}
	return mergeGroups(slices.Clone(in), []FieldGroup{g})
}

func stepLabel(s stepDef, t NodeType) string {
	name := orDefault(strings.TrimSpace(s.Name), s.Key)
	kind := orDefault(t.Label, s.Kind)
	return fmt.Sprintf("「%s」（%s）的输出", name, kind)
}

// expandPath 把路径里的 {配置项} 换成配置的值，没填用默认值。
func expandPath(p string, cfg map[string]string, params []Param) string {
	for _, pa := range params {
		ph := "{" + pa.Key + "}"
		if strings.Contains(p, ph) {
			p = strings.ReplaceAll(p, ph, orDefault(strings.TrimSpace(cfg[pa.Key]), pa.Default))
		}
	}
	return p
}

// mergeGroups 合并几路上游：同一来源（同一个步骤）只留一组。
func mergeGroups(a, b []FieldGroup) []FieldGroup {
	for _, g := range b {
		dup := slices.ContainsFunc(a, func(x FieldGroup) bool { return x.Source == g.Source && x.Step == g.Step })
		if !dup {
			a = append(a, g)
		}
	}
	return a
}

// keepFields 是结束节点挑了字段时往下传的：只留路径在 keep 里（或在它下面）的字段，组里没剩的去掉。
func keepFields(in []FieldGroup, keep []string) []FieldGroup {
	var out []FieldGroup
	for _, g := range in {
		ng := g
		ng.Fields = nil
		for _, f := range g.Fields {
			if slices.ContainsFunc(keep, func(k string) bool { return pathCovers(k, "object", f.Path) || pathCovers(f.Path, f.Type, k) }) {
				ng.Fields = append(ng.Fields, f)
			}
		}
		if len(ng.Fields) > 0 {
			out = append(out, ng)
		}
	}
	return out
}

// loopTarget 是有条件回退把第 i 步当退回目标。
func (ff *flowFields) loopTarget(i int) bool {
	for _, s := range ff.steps {
		if s.Kind == loopbackKind && strings.TrimSpace(s.Config["target"]) == ff.steps[i].Key {
			return true
		}
	}
	return false
}

func segs(p string) []string {
	p = indexRe.ReplaceAllString(strings.TrimSpace(p), ".$1")
	var out []string
	for _, s := range strings.Split(p, ".") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// pathCovers 是声明的字段 decl（类型 typ）能不能取到 want：同一个字段；decl 是对象、列表或任意类型而 want 在它下面；
// want 是 decl 的上层（取的是整个对象）。
func pathCovers(decl, typ, want string) bool {
	d, w := segs(decl), segs(want)
	if len(d) == 0 || len(w) == 0 {
		return false
	}
	n := min(len(d), len(w))
	if !slices.Equal(d[:n], w[:n]) {
		return false
	}
	if len(w) > len(d) {
		return typ == "object" || typ == "list" || typ == "any"
	}
	return true
}

// lookup 查第 i 步能不能拿到字段 path：known 是声明里有，open 是有上游没声明全（拿不到也只是可能）。
// 对象、列表下面没列子字段的，子字段都算有；列了子字段的（比如 message.text、message.relevance）只认列出来的。
func (ff *flowFields) lookup(i int, path string) (known, open bool) {
	for _, g := range ff.at(i) {
		open = open || g.Open
		for _, f := range g.Fields {
			typ := f.Type
			if !f.Open && hasChildren(g.Fields, f.Path) {
				typ = "closed"
			}
			if pathCovers(f.Path, typ, path) {
				return true, open
			}
		}
	}
	return false, open
}

// hasChildren 是同一组里有列在 p 下面的字段。
func hasChildren(fields []FieldInfo, p string) bool {
	ps := segs(p)
	return slices.ContainsFunc(fields, func(f FieldInfo) bool {
		fs := segs(f.Path)
		return len(fs) > len(ps) && slices.Equal(fs[:len(ps)], ps)
	})
}

// names 是第 i 步能拿到的字段路径，给校验信息用，最多 n 个；和 near 同一个顶层字段的排在前面（写错子字段时先看到同级的）。
func (ff *flowFields) names(i, n int, near string) (list []string, total int) {
	var all []string
	for _, g := range ff.at(i) {
		for _, f := range g.Fields {
			all = append(all, f.Path)
		}
	}
	if ns := segs(near); len(ns) > 1 {
		slices.SortStableFunc(all, func(a, b string) int {
			ra, rb := segs(a)[0] == ns[0], segs(b)[0] == ns[0]
			switch {
			case ra && !rb:
				return -1
			case rb && !ra:
				return 1
			}
			return 0
		})
	}
	if len(all) > n {
		return all[:n], len(all)
	}
	return all, len(all)
}

// stepFields 是 POST /api/sop/step-fields：{draft, step}，draft 同 AI 协助的草稿（形状同 SopFlow，可只给 trigger、fields、steps），
// step 是步骤 key，"__start" 或不给是开始节点交出去的。回 FieldGroup[]。草稿校验没过也照算（编辑中途常有）。
func (h *flows) stepFields(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	f, _, err := readDraft(raw["draft"], kindsOf(h.c))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var key string
	if v, ok := raw["step"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &key) != nil {
			fail(w, r, h.c, apiErr(errValidation, "step 必须是步骤 key"))
			return
		}
	}
	steps, ok, idx := parseDefs(f.Steps)
	i := -1
	if key != "" && key != startKey {
		j, found := idx[key]
		if !found {
			fail(w, r, h.c, apiErr(errValidation, "草稿里没有步骤 %s", key))
			return
		}
		i = j
	}
	groups := newFlowFields(&f, steps, ok, idx, kindsOf(h.c)).at(i)
	if groups == nil {
		groups = []FieldGroup{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": groups, "meta": map[string]int{"total": len(groups)}})
}

// parseDefs 把步骤 JSON 解成 stepDef，ok 标出解得开的，idx 是 key → 下标（重复的取第一个）。
func parseDefs(v json.RawMessage) ([]stepDef, []bool, map[string]int) {
	var raws []json.RawMessage
	_ = json.Unmarshal(v, &raws)
	steps := make([]stepDef, len(raws))
	ok := make([]bool, len(raws))
	idx := map[string]int{}
	for i, r := range raws {
		if json.Unmarshal(r, &steps[i]) == nil {
			ok[i] = true
		}
		if _, dup := idx[steps[i].Key]; !dup && steps[i].Key != "" {
			idx[steps[i].Key] = i
		}
	}
	return steps, ok, idx
}

// triggers 是 GET /api/sop/triggers：每种触发方式和它自动带进输入的字段。
func triggersList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": Triggers, "meta": map[string]int{"total": len(Triggers)}})
}
