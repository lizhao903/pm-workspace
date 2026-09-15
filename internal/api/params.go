package api

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

const (
	defaultLimit = 50
	maxLimit     = 200
)

// params 包一层 url.Values，把「解析失败要告诉用户是哪个参数」这件事收口在一处。
type params url.Values

func newParams(r *http.Request) params { return params(r.URL.Query()) }

func (p params) str(k string) string { return strings.TrimSpace(url.Values(p).Get(k)) }

// csv 解析逗号分隔的多选参数，如 type=requirement,task。
func (p params) csv(k string) []string {
	raw := p.str(k)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, s := range parts {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// multi 解析可重复传的参数，如 tag=a&tag=b。
func (p params) multi(k string) []string {
	vs := url.Values(p)[k]
	out := make([]string, 0, len(vs))
	for _, s := range vs {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// boolean 接受 true/1/yes/on 与 false/0/no/off，缺省为 false。
func (p params) boolean(k string) (bool, error) {
	raw := strings.ToLower(p.str(k))
	switch raw {
	case "":
		return false, nil
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off":
		return false, nil
	}
	return false, validationf("invalid %q: expected a boolean like true or 1", k)
}

// limit 解析分页大小：只有显式传 1..max 才生效，0 与负数都回落默认值。
// 不钳到 1 是因为 limit=0 在 HTTP API 里通常表示「没指定」，
// 真返回一条数据只会让人以为数据丢了。超上限仍按钳制处理。
func (p params) limit(k string, def, max int) (int, error) {
	raw := p.str(k)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, validationf("invalid %q: expected an integer", k)
	}
	if v < 1 {
		return def, nil
	}
	if v > max {
		v = max
	}
	return v, nil
}

// intRange 解析整数并钳制到 [min,max]；越界不报错，只有非数字才报错。
func (p params) intRange(k string, def, min, max int) (int, error) {
	raw := p.str(k)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, validationf("invalid %q: expected an integer", k)
	}
	if v < min {
		v = min
	}
	if v > max {
		v = max
	}
	return v, nil
}

// dayBound 决定纯日期写法补哪一端的时分秒。
type dayBound int

const (
	dayStart dayBound = iota // 当天 00:00:00，用于下界
	dayEnd                   // 当天 23:59:59，用于上界
)

// timeAt 支持 RFC3339 与 YYYY-MM-DD 两种写法。纯日期按本地时区补足时分秒，
// 补哪一端取决于它是上界还是下界：due_before=2026-09-30 要含当天所以补 23:59:59，
// due_after=2026-09-30 要含当天所以补 00:00:00。两者都传同一天时正好圈出「当天到期」。
func (p params) timeAt(k string, bound dayBound) (*time.Time, error) {
	raw := p.str(k)
	if raw == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return &t, nil
	}
	if d, err := time.ParseInLocation("2006-01-02", raw, time.Local); err == nil {
		if bound == dayEnd {
			d = d.Add(24*time.Hour - time.Second)
		}
		return &d, nil
	}
	return nil, validationf("invalid %q: expected RFC3339 or YYYY-MM-DD", k)
}

// sortFields 与契约一致，非白名单值直接拒绝，避免把未知字段透给 SQL 层。
var sortFields = map[string]bool{
	"updated_at": true, "created_at": true, "due_at": true, "priority": true, "title": true,
}

func (p params) sort(k string) (string, error) {
	raw := p.str(k)
	if raw == "" {
		return "", nil
	}
	if !sortFields[strings.TrimPrefix(raw, "-")] {
		return "", validationf("invalid %q: expected one of updated_at, created_at, due_at, priority, title", k)
	}
	return raw, nil
}

// objectFilter 把 GET /api/objects 的 query 翻成领域过滤条件。
func objectFilter(r *http.Request) (domain.ObjectFilter, error) {
	p := newParams(r)
	var f domain.ObjectFilter
	var err error

	f.TypeIDs = p.csv("type")
	f.CategoryID = p.str("category")
	f.Statuses = p.csv("status")
	f.Priorities = p.csv("priority")
	f.Tags = p.multi("tag")
	f.OwnerID = p.str("owner_id")
	f.ProjectID = p.str("project")
	f.Query = p.str("q")

	if f.CategorySubtree, err = p.boolean("subtree"); err != nil {
		return f, err
	}
	if f.Uncategorized, err = p.boolean("uncategorized"); err != nil {
		return f, err
	}
	if f.Overdue, err = p.boolean("overdue"); err != nil {
		return f, err
	}
	// stalled 的阈值与终态口径都和 Counts.Stalled 共用，两边分叉就会「徽标 1 / 列表 20」。
	if f.Stalled, err = p.boolean("stalled"); err != nil {
		return f, err
	}
	// not_terminal 给「今日」「本周」用：不带它的话，今天到期但已完成的会混进列表，
	// 而 counts 那边是排除终态的，徽标和列表又对不上。
	if f.NotTerminal, err = p.boolean("not_terminal"); err != nil {
		return f, err
	}
	if f.Inbox, err = p.boolean("inbox"); err != nil {
		return f, err
	}
	if f.IncludeArchived, err = p.boolean("archived"); err != nil {
		return f, err
	}
	if f.IncludeDeleted, err = p.boolean("deleted"); err != nil {
		return f, err
	}
	// due_after/due_before 必须成对解析：只认上界的话，「今日」会把所有逾期的也算进来。
	if f.DueAfter, err = p.timeAt("due_after", dayStart); err != nil {
		return f, err
	}
	if f.DueBefore, err = p.timeAt("due_before", dayEnd); err != nil {
		return f, err
	}
	if f.Sort, err = p.sort("sort"); err != nil {
		return f, err
	}
	if f.Limit, err = p.limit("limit", defaultLimit, maxLimit); err != nil {
		return f, err
	}
	if f.Offset, err = p.intRange("offset", 0, 0, 1<<30); err != nil {
		return f, err
	}
	return f, nil
}

// actorSources 是 revisions.source 的白名单，非法值一律降级成 api，
// 因为来源只是取证信息，不该让前端因为写错 header 就丢掉一次写入。
var actorSources = map[string]bool{"ui": true, "api": true, "agent": true, "import": true}

func actorFrom(r *http.Request) store.Actor {
	src := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Actor-Source")))
	if !actorSources[src] {
		src = store.DefaultActor.Source
	}
	return store.Actor{Name: store.DefaultActor.Name, Source: src}
}
