// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// catalog 是工作对象类型的本地索引，用来把 status/type 的 key 渲染成人能读的标签。
type catalog struct {
	types []*domain.ObjectType
	byID  map[string]*domain.ObjectType
}

// loadCatalog 取类型目录，带短 TTL 缓存。
func (c *client) loadCatalog(ctx context.Context) (*catalog, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cat != nil && time.Since(c.catAt) < c.catTTL {
		return c.cat, nil
	}
	ts, err := c.listObjectTypes(ctx)
	if err != nil {
		return nil, err
	}
	cat := &catalog{types: ts, byID: make(map[string]*domain.ObjectType, len(ts))}
	for _, t := range ts {
		cat.byID[t.ID] = t
	}
	c.cat, c.catAt = cat, time.Now()
	return cat, nil
}

// typeText 渲染成「需求(requirement)」：标签给人看，key 给模型后续调用用。
func (c *catalog) typeText(typeID string) string {
	if c == nil || typeID == "" {
		return typeID
	}
	if t, ok := c.byID[typeID]; ok && t.Name != "" && t.Name != typeID {
		return t.Name + "(" + typeID + ")"
	}
	return typeID
}

func (c *catalog) statusText(typeID, status string) string {
	if c == nil || status == "" {
		return status
	}
	t, ok := c.byID[typeID]
	if !ok {
		return status
	}
	for _, s := range t.Statuses {
		if s.Key == status {
			if s.Label != "" && s.Label != status {
				return s.Label + "(" + status + ")"
			}
			return status
		}
	}
	// 状态不在类型的状态集里：多半是类型改过而旧数据没迁，标出来别让它悄悄混过去。
	return status + "(该类型状态集中已无此项)"
}

// --- 基础格式化 ---

func formatDate(t time.Time) string     { return t.Local().Format("2006-01-02") }
func formatDateTime(t time.Time) string { return t.Local().Format("2006-01-02 15:04") }

func joinNonEmpty(sep string, parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// --- 工作对象 ---

// objectLine 是列表里的一行。只拼非空字段，短对象就短，别用一堆「-」占满上下文。
func objectLine(cat *catalog, o *domain.Object) string {
	head := o.ID
	if o.Ref != "" {
		head += "  " + o.Ref
	}
	tail := []string{cat.statusText(o.TypeID, o.Status)}
	if o.Priority != "" {
		tail = append(tail, o.Priority)
	}
	if o.DueAt != nil {
		tail = append(tail, "到期 "+formatDate(*o.DueAt))
	}
	if n := ownerText(o); n != "" {
		tail = append(tail, "负责人 "+n)
	}
	if len(o.Tags) > 0 {
		tail = append(tail, "标签 "+strings.Join(o.Tags, ","))
	}
	if o.ArchivedAt != nil {
		tail = append(tail, "已归档")
	}
	if o.DeletedAt != nil {
		tail = append(tail, "已删除")
	}
	return head + "  " + o.Title + " | " + joinNonEmpty(" | ", tail...)
}

// ownerText 取负责人的显示名。0010 之后负责人是干系人引用，名字在 OwnerName 里；
// Owner 是迁移前的自由文本，只在 OwnerName 为空时兜底（store 已经兜过一次，这里防老后端）。
func ownerText(o *domain.Object) string {
	if o.OwnerName != "" {
		return o.OwnerName
	}
	return o.Owner
}

// propStr 取 props 里的字符串字段，不是字符串（或没有）时返回空串。
func propStr(o *domain.Object, key string) string {
	if o == nil || o.Props == nil {
		return ""
	}
	v, _ := o.Props[key].(string)
	return strings.TrimSpace(v)
}

// objectDetail 是单对象全文：结构化摘要 + 正文。
func objectDetail(cat *catalog, o *domain.Object) string {
	var b strings.Builder
	title := o.Title
	if o.Ref != "" {
		title = o.Ref + " " + title
	}
	fmt.Fprintf(&b, "%s\n\n", title)

	kv := func(k, v string) {
		if strings.TrimSpace(v) != "" {
			fmt.Fprintf(&b, "%s：%s\n", k, v)
		}
	}
	kv("id", o.ID)
	kv("类型", cat.typeText(o.TypeID))
	kv("状态", cat.statusText(o.TypeID, o.Status))
	kv("优先级", o.Priority)
	kv("负责人", ownerText(o))
	if o.CategoryID != nil {
		// CategoryPath 是 slug 路径（/product/cloud/），给人看不如中文名直观，
		// 但它能看出层级，所以放在括号里作补充。
		name := o.CategoryName
		if p := o.CategoryPath; p != "" && p != name {
			name = joinNonEmpty("", name, " ("+p+")")
		}
		kv("分类", joinNonEmpty(" ", name, "["+*o.CategoryID+"]"))
	} else {
		kv("分类", "未分类")
	}
	if o.ProjectID != nil {
		kv("所属项目", joinNonEmpty(" ", o.ProjectTitle, "["+*o.ProjectID+"]"))
	}
	if o.DueAt != nil {
		kv("到期", formatDate(*o.DueAt))
	}
	if len(o.Tags) > 0 {
		kv("标签", strings.Join(o.Tags, ", "))
	}
	kv("关联数", fmt.Sprint(o.LinkCount))
	kv("来源", o.Source)
	if o.StartedAt != nil {
		kv("开始于", formatDateTime(*o.StartedAt))
	}
	if o.CompletedAt != nil {
		kv("完成于", formatDateTime(*o.CompletedAt))
	}
	if o.ArchivedAt != nil {
		kv("归档于", formatDateTime(*o.ArchivedAt))
	}
	if o.DeletedAt != nil {
		kv("删除于", formatDateTime(*o.DeletedAt))
	}
	kv("创建于", formatDateTime(o.CreatedAt))
	kv("更新于", formatDateTime(o.UpdatedAt))
	kv("工作目录", o.Workdir)
	kv("关联仓库", propStr(o, domain.PropRepo))
	if len(o.Props) > 0 {
		keys := make([]string, 0, len(o.Props))
		for k := range o.Props {
			// 开发任务的约定字段单独展示，不混在自定义属性里。
			if k == domain.PropAcceptance || k == domain.PropRepo {
				continue
			}
			keys = append(keys, k)
		}
		sort.Strings(keys)
		pairs := make([]string, 0, len(keys))
		for _, k := range keys {
			pairs = append(pairs, fmt.Sprintf("%s=%v", k, o.Props[k]))
		}
		kv("自定义属性", strings.Join(pairs, ", "))
	}
	if ac := propStr(o, domain.PropAcceptance); ac != "" {
		b.WriteString("\n--- 验收标准 ---\n" + ac)
		if !strings.HasSuffix(ac, "\n") {
			b.WriteString("\n")
		}
	}

	b.WriteString("\n--- 正文 ---\n")
	if strings.TrimSpace(o.Body) == "" {
		b.WriteString("（空）\n")
	} else {
		b.WriteString(o.Body)
		if !strings.HasSuffix(o.Body, "\n") {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// --- 类型与字典 ---

func renderTypes(types []*domain.ObjectType, dicts []*domain.Dictionary) string {
	var b strings.Builder
	b.WriteString("工作对象类型（type_id 用于 pmw_create_object / pmw_search 的 type 参数）：\n\n")
	for _, t := range types {
		flag := ""
		if t.Builtin {
			flag = "，内置"
		}
		fmt.Fprintf(&b, "%s  id=%s  ref 前缀=%s%s\n", t.Name, t.ID, t.RefPrefix, flag)
		if len(t.Statuses) == 0 {
			b.WriteString("  状态集：（空）\n\n")
			continue
		}
		b.WriteString("  状态集（pmw_update_object 的 status 只能取这里的 key）：\n")
		for _, s := range t.Statuses {
			term := ""
			if s.Terminal {
				term = "  [终态]"
			}
			fmt.Fprintf(&b, "    %-12s %s%s\n", s.Key, s.Label, term)
		}
		b.WriteString("\n")
	}

	for _, d := range dicts {
		if len(d.Items) == 0 {
			continue
		}
		switch d.ID {
		case domain.DictPriority:
			b.WriteString("优先级（pmw_create_object / pmw_update_object 的 priority）：\n")
		case domain.DictLinkRelation:
			b.WriteString("关联关系（pmw_link_objects 的 relation）：\n")
		default:
			continue
		}
		for _, it := range d.Items {
			if it.ArchivedAt != nil {
				continue
			}
			scope := ""
			if it.TypeID != nil {
				scope = "  仅限类型 " + *it.TypeID
			}
			fmt.Fprintf(&b, "    %-14s %s%s\n", it.Key, it.Label, scope)
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// --- 分类树 ---

func renderCategories(cat *catalog, typeID string, roots []*domain.Category) string {
	var b strings.Builder
	if typeID != "" {
		fmt.Fprintf(&b, "%s 的分类树（缩进表示层级，括号内为 id）：\n\n", cat.typeText(typeID))
	} else {
		b.WriteString("全部类型的分类树（缩进表示层级，括号内为 id）：\n\n")
	}
	if len(roots) == 0 {
		b.WriteString("（该类型下还没有分类）\n")
		return b.String()
	}
	var walk func(nodes []*domain.Category, depth int)
	walk = func(nodes []*domain.Category, depth int) {
		for _, n := range nodes {
			count := fmt.Sprintf("%d", n.Count)
			if n.TotalCount != n.Count {
				count = fmt.Sprintf("%d，含子树 %d", n.Count, n.TotalCount)
			}
			fmt.Fprintf(&b, "%s%s  (%s)  对象 %s\n",
				strings.Repeat("  ", depth), n.Name, n.ID, count)
			walk(n.Children, depth+1)
		}
	}
	walk(roots, 0)
	b.WriteString("\n用 pmw_search 的 category 参数按分类筛选；带 subtree=true 可连子分类一起查。\n")
	return b.String()
}

// --- 待办概览 ---

func renderCounts(cat *catalog, scope string, c *domain.Counts) string {
	var b strings.Builder
	if scope != "" {
		fmt.Fprintf(&b, "待办概览（聚焦类计数器已收窄到 %s）：\n\n", cat.typeText(scope))
	} else {
		b.WriteString("待办概览（全局）：\n\n")
	}
	fmt.Fprintf(&b, "收件箱 %d | 今日到期 %d | 本周到期 %d | 已逾期 %d | 停滞 %d（14 天未更新且未进终态） | 总计 %d\n",
		c.Inbox, c.Today, c.Week, c.Overdue, c.Stalled, c.Total)

	if len(c.ByType) > 0 {
		b.WriteString("\n按类型：\n")
		for _, id := range sortedKeys(c.ByType) {
			line := fmt.Sprintf("  %s  %d", cat.typeText(id), c.ByType[id])
			if u := c.UncategorizedByType[id]; u > 0 {
				line += fmt.Sprintf("（其中未分类 %d）", u)
			}
			b.WriteString(line + "\n")
		}
	}

	if len(c.ByStatus) > 0 {
		b.WriteString("\n按状态：\n")
		for _, k := range sortedKeys(c.ByStatus) {
			// key 是 "<type_id>:<status>"：不同类型的状态有重名，裸 status 聚合没有业务含义。
			typeID, status, ok := strings.Cut(k, ":")
			if !ok {
				fmt.Fprintf(&b, "  %s  %d\n", k, c.ByStatus[k])
				continue
			}
			fmt.Fprintf(&b, "  %s  %s  %d\n", cat.typeText(typeID), cat.statusText(typeID, status), c.ByStatus[k])
		}
	}
	return b.String()
}

func sortedKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// --- 变更历史 ---

// renderRevisions 把变更流渲染成日报能直接用的样子。titles 把 object_id 补成标题，
// 查不到就退回裸 id，不影响主干信息。
func renderRevisions(revs []*domain.Revision, titles map[string]string, scope string) string {
	var b strings.Builder
	if scope != "" {
		fmt.Fprintf(&b, "%s 的变更历史，共 %d 条（新→旧）：\n\n", scope, len(revs))
	} else {
		fmt.Fprintf(&b, "最近变更共 %d 条（新→旧）：\n\n", len(revs))
	}
	if len(revs) == 0 {
		b.WriteString("（这段时间没有任何变更）\n")
		return b.String()
	}
	for _, r := range revs {
		// 只看单个对象时，每行再重复一遍它的 id 和标题纯属噪音。
		subject := ""
		if scope == "" {
			subject = r.ObjectID
			if t := titles[r.ObjectID]; t != "" {
				subject = r.ObjectID + " " + t
			}
			subject += "  "
		}
		change := describeChange(r)
		who := joinNonEmpty("/", r.Actor, r.Source)
		fmt.Fprintf(&b, "%s  %s%s", formatDateTime(r.CreatedAt), subject, change)
		if who != "" {
			fmt.Fprintf(&b, "  (%s)", who)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func describeChange(r *domain.Revision) string {
	if r.Field == "created" {
		return "新建：" + truncate(r.NewValue, 60)
	}
	// 进展行的 old_value 是元数据 JSON 不是旧值，按「旧 → 新」渲染会读成乱码。
	if r.Field == domain.FieldProgress {
		return "进展：" + truncate(r.NewValue, 80)
	}
	old, new := truncate(r.OldValue, 40), truncate(r.NewValue, 40)
	switch {
	case old == "" && new == "":
		return r.Field + " 已变更"
	case old == "":
		return r.Field + ": （空） → " + new
	case new == "":
		return r.Field + ": " + old + " → （空）"
	default:
		return r.Field + ": " + old + " → " + new
	}
}

// truncate 按 rune 截断，避免把中文切成半个字符。
func truncate(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n]) + "…"
}
