// Package plugin 是插件清单的类型、解析和校验（CORE-01b），规范见 docs/plugin-api.md。
// 前端 frontend/src/core/plugin/manifest.ts 是同一套规则，两边共用
// docs/plugin-manifest-examples/ 里的样例和期望错误，错误信息逐字一致。
package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
)

// APIVersion 是内核对插件承诺的插件 API 版本，和内核发版号分开记（docs/plugin-api.md 1.3）。
const APIVersion = "1.0.0"

// Manifest 是 plugin.json，字段名和清单一致。
type Manifest struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Description     string            `json:"description,omitempty"`
	Version         string            `json:"version"`
	Core            string            `json:"core"`
	Depends         map[string]string `json:"depends,omitempty"`
	OptionalDepends map[string]string `json:"optional_depends,omitempty"`
	Provides        Provides          `json:"provides"`
	Emits           []string          `json:"emits,omitempty"`
	Subscribes      []string          `json:"subscribes,omitempty"`
	Adopts          Adopts            `json:"adopts,omitzero"`
	Permissions     []string          `json:"permissions"`
	Migrations      string            `json:"migrations,omitempty"`
	TablePrefix     string            `json:"table_prefix,omitempty"`
}

// Provides 按扩展点分组列出本插件注册的 id（docs/plugin-api.md 1.5）。
type Provides struct {
	Modules     []string `json:"modules"`
	Settings    []string `json:"settings"`
	ObjectTypes []string `json:"object_types"`
	Connectors  []string `json:"connectors"`
	Skills      []string `json:"skills"`
	AgentTools  []string `json:"agent_tools"`
	SOPNodes    []string `json:"sop_nodes"`
	TodayCards  []string `json:"today_cards"`
	Commands    []string `json:"commands"`
	Search      []string `json:"search"`
}

// Adopts 是认领插件化之前就在内核里的东西（docs/plugin-api.md 1.6）。
// 白名单检查在 CORE-04a 注册时做。
type Adopts struct {
	ObjectTypes []string `json:"object_types"`
	Routes      []string `json:"routes"`
}

// Issue 是一条校验问题，Field 是出错的字段路径，例 depends.projects、permissions[1]。
type Issue struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (i Issue) String() string { return i.Field + " " + i.Message }

// ValidationError 汇总一份清单的全部问题。
type ValidationError struct {
	Issues []Issue
}

func (e *ValidationError) Error() string {
	s := make([]string, len(e.Issues))
	for i, is := range e.Issues {
		s[i] = is.String()
	}
	return "插件清单不合法：" + strings.Join(s, "；")
}

// Issues 取出 err 里的校验问题；不是校验错误时返回 nil。
func Issues(err error) []Issue {
	var ve *ValidationError
	if errors.As(err, &ve) {
		return ve.Issues
	}
	return nil
}

// ReservedIDs 是内核保留字，插件 id 不能用（docs/plugin-api.md 1.4）。
var ReservedIDs = []string{
	"api", "admin", "agent", "agent_providers", "artifacts", "audits", "categories", "contacts", "core", "counts",
	"dict_items", "dictionaries", "fs", "health", "kernel", "library", "links", "objects", "object_types",
	"plugins", "revisions", "runs", "sessions", "settings", "shortcut_groups", "shortcuts", "stakeholders",
	"stats", "tags", "tasks", "today", "workspaces",
}

// Permissions 是内核认的固定权限；另有 secrets:<scope>（docs/plugin-api.md 3.1）。
var Permissions = []string{
	"fs:read:project", "fs:write:project", "fs:read:attachments", "fs:write:attachments",
	"fs:read:any", "fs:write:any",
	"network:localhost", "network:im", "network:media-platforms", "network:market-data",
	"network:exchanges", "network:any",
	"process:spawn", "trade:live",
}

// KernelEvents 是内核事件第一版（docs/plugin-api.md 2.10）。
var KernelEvents = []string{
	"object.created", "object.updated", "object.status_changed",
	"task.review_requested", "run.finished", "contact.identity_merged",
}

// 内核事件用的命名空间；这些前缀的事件只能是 KernelEvents 里的。
var kernelEventNamespaces = []string{"object", "task", "run", "contact"}

// SharedTablePrefixes 是插件族可以共享的表前缀白名单，键是前缀、值是可用的插件 id。
// 交易套件的前缀放到 M6 定，先留空。
var SharedTablePrefixes = map[string][]string{}

// ManifestFields 是清单的顶层字段，顺序同 docs/plugin-api.md 1.1。
var ManifestFields = []string{
	"id", "name", "description", "version", "core", "depends", "optional_depends", "provides",
	"emits", "subscribes", "adopts", "permissions", "migrations", "table_prefix",
}

// ExtensionPoints 是 provides 的分组键。
var ExtensionPoints = []string{
	"modules", "settings", "object_types", "connectors", "skills",
	"agent_tools", "sop_nodes", "today_cards", "commands", "search",
}

var adoptsFields = []string{"object_types", "routes"}

var (
	idRe     = regexp.MustCompile(`^[a-z][a-z0-9_]{1,23}$`)
	keyRe    = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	eventRe  = regexp.MustCompile(`^([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*$`)
	secretRe = regexp.MustCompile(`^secrets:[a-z][a-z0-9_]*$`)
)

// Parse 解析 plugin.json 并做结构校验，不看别的插件；有问题时返回 *ValidationError。
func Parse(data []byte) (*Manifest, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return nil, &ValidationError{[]Issue{{"清单", "不是合法的 JSON：" + err.Error()}}}
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, &ValidationError{[]Issue{{"清单", "不是合法的 JSON：结尾有多余内容"}}}
	}
	return FromValue(raw)
}

// FromValue 校验已经解成通用值（map[string]any 等）的清单。
func FromValue(raw any) (*Manifest, error) {
	c := &checker{}
	m := c.manifest(raw)
	if len(c.issues) > 0 {
		return nil, &ValidationError{c.issues}
	}
	return m, nil
}

// Env 是校验依赖和冲突时的环境：当前插件 API 版本和其他可用的插件。
type Env struct {
	APIVersion string // 空表示 APIVersion
	Plugins    []*Manifest
}

// Check 拿环境检查 core 范围、强依赖是否存在和版本是否匹配、强依赖成环、连接器 id 冲突。
// 弱依赖没装也行，不检查。m 必须是 Parse 通过的清单；环境里和 m 同 id 的插件被忽略。
func Check(m *Manifest, env Env) error {
	var issues []Issue
	add := func(field, msg string) { issues = append(issues, Issue{field, msg}) }

	api := env.APIVersion
	if api == "" {
		api = APIVersion
	}
	if !Satisfies(api, m.Core) {
		add("core", fmt.Sprintf("不包含当前插件 API 版本 %s：%s", api, m.Core))
	}

	others := map[string]*Manifest{}
	for _, p := range env.Plugins {
		if p != nil && p.ID != m.ID {
			others[p.ID] = p
		}
	}
	for _, dep := range sortedKeys(m.Depends) {
		rng := m.Depends[dep]
		p, ok := others[dep]
		if !ok {
			add("depends."+dep, "依赖的插件不存在")
			continue
		}
		if !Satisfies(p.Version, rng) {
			add("depends."+dep, fmt.Sprintf("要求 %s，已有版本 %s", rng, p.Version))
		}
	}
	if cycle := findCycle(m, others); cycle != nil {
		add("depends", "形成循环依赖："+strings.Join(cycle, " -> "))
	}

	owner := map[string]string{}
	for _, id := range sortedKeys(others) {
		for _, t := range others[id].Provides.Connectors {
			if _, ok := owner[t]; !ok {
				owner[t] = id
			}
		}
	}
	for i, t := range m.Provides.Connectors {
		if id, ok := owner[t]; ok {
			add(fmt.Sprintf("provides.connectors[%d]", i), fmt.Sprintf("已被插件 %s 声明：%s", id, t))
		}
	}

	if len(issues) > 0 {
		return &ValidationError{issues}
	}
	return nil
}

// Validate 是 Parse 加 Check；结构有问题时不做环境检查。
func Validate(data []byte, env Env) (*Manifest, error) {
	m, err := Parse(data)
	if err != nil {
		return nil, err
	}
	if err := Check(m, env); err != nil {
		return nil, err
	}
	return m, nil
}

// findCycle 沿强依赖从 m 出发找回到 m 的环，返回 [m, ..., m]；按 id 排序遍历，结果稳定。
func findCycle(m *Manifest, others map[string]*Manifest) []string {
	seen := map[string]bool{}
	var walk func(id string, path []string) []string
	walk = func(id string, path []string) []string {
		var deps map[string]string
		if id == m.ID {
			deps = m.Depends
		} else if p, ok := others[id]; ok {
			deps = p.Depends
		}
		for _, d := range sortedKeys(deps) {
			if d == m.ID {
				return append(slices.Clone(path), d)
			}
			if seen[d] {
				continue
			}
			seen[d] = true
			if c := walk(d, append(path, d)); c != nil {
				return c
			}
		}
		return nil
	}
	return walk(m.ID, []string{m.ID})
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

type checker struct {
	issues []Issue
}

func (c *checker) add(field, format string, args ...any) {
	c.issues = append(c.issues, Issue{field, fmt.Sprintf(format, args...)})
}

func (c *checker) unknownKeys(obj map[string]any, known []string, prefix, msg string) {
	for _, k := range sortedKeys(obj) {
		if !slices.Contains(known, k) {
			c.add(prefix+k, "%s", msg)
		}
	}
}

// str 取字符串字段；没有返回 ok=false，类型不对记一条问题。
func (c *checker) str(obj map[string]any, key, field string, required bool) (string, bool) {
	v, has := obj[key]
	if !has {
		if required {
			c.add(field, "必填")
		}
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		c.add(field, "必须是字符串")
		return "", false
	}
	return s, true
}

func (c *checker) strList(obj map[string]any, key, field string, required bool) ([]string, bool) {
	v, has := obj[key]
	if !has {
		if required {
			c.add(field, "必填")
		}
		return nil, false
	}
	arr, ok := v.([]any)
	if !ok {
		c.add(field, "必须是字符串数组")
		return nil, false
	}
	out := make([]string, 0, len(arr))
	good := true
	for i, e := range arr {
		s, ok := e.(string)
		if !ok {
			c.add(fmt.Sprintf("%s[%d]", field, i), "必须是字符串")
			good = false
			continue
		}
		out = append(out, s)
	}
	if !good {
		return nil, false
	}
	return out, true
}

func (c *checker) object(obj map[string]any, key, field string, required bool) (map[string]any, bool) {
	v, has := obj[key]
	if !has {
		if required {
			c.add(field, "必填")
		}
		return nil, false
	}
	o, ok := v.(map[string]any)
	if !ok {
		c.add(field, "必须是对象")
		return nil, false
	}
	return o, true
}

// each 对字符串数组逐项检查，同时查重；check 返回空串表示通过。
func (c *checker) each(field string, list []string, check func(s string) string) {
	seen := map[string]bool{}
	for i, s := range list {
		f := fmt.Sprintf("%s[%d]", field, i)
		if msg := check(s); msg != "" {
			c.add(f, "%s：%s", msg, s)
			continue
		}
		if seen[s] {
			c.add(f, "重复：%s", s)
		}
		seen[s] = true
	}
}

func (c *checker) deps(obj map[string]any, key, selfID string) map[string]string {
	o, ok := c.object(obj, key, key, false)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for _, dep := range sortedKeys(o) {
		f := key + "." + dep
		rng, ok := o[dep].(string)
		switch {
		case !idRe.MatchString(dep):
			c.add(f, "不是合法的插件 id")
		case dep == selfID:
			c.add(f, "不能依赖自己")
		case !ok:
			c.add(f, "必须是字符串")
		default:
			if _, ok := ParseRange(rng); !ok {
				c.add(f, "版本范围不合法：%s", rng)
				continue
			}
			out[dep] = rng
		}
	}
	return out
}

func (c *checker) manifest(raw any) *Manifest {
	obj, ok := raw.(map[string]any)
	if !ok {
		c.add("清单", "必须是 JSON 对象")
		return nil
	}
	m := &Manifest{}
	c.unknownKeys(obj, ManifestFields, "", "是未知字段")

	// id 不合法时跳过所有和 id 相关的前缀检查，免得一个错引出一串
	idOK := false
	if id, ok := c.str(obj, "id", "id", true); ok {
		switch {
		case !idRe.MatchString(id):
			c.add("id", "不合法：必须匹配 %s：%s", idRe.String(), id)
		case slices.Contains(ReservedIDs, id):
			c.add("id", "是内核保留字：%s", id)
		default:
			idOK = true
		}
		m.ID = id
	}
	id := m.ID

	if name, ok := c.str(obj, "name", "name", true); ok {
		if strings.TrimSpace(name) == "" {
			c.add("name", "不能为空")
		}
		m.Name = name
	}
	m.Description, _ = c.str(obj, "description", "description", false)
	if v, ok := c.str(obj, "version", "version", true); ok {
		if _, ok := ParseVersion(v); !ok {
			c.add("version", "不是合法的版本号（MAJOR.MINOR.PATCH）：%s", v)
		}
		m.Version = v
	}
	if v, ok := c.str(obj, "core", "core", true); ok {
		if _, ok := ParseRange(v); !ok {
			c.add("core", "版本范围不合法：%s", v)
		}
		m.Core = v
	}

	m.Depends = c.deps(obj, "depends", id)
	m.OptionalDepends = c.deps(obj, "optional_depends", id)
	for _, dep := range sortedKeys(m.OptionalDepends) {
		if _, dup := m.Depends[dep]; dup {
			c.add("optional_depends."+dep, "已在 depends 里声明")
		}
	}

	if p, ok := c.object(obj, "provides", "provides", true); ok {
		c.unknownKeys(p, ExtensionPoints, "provides.", "是未知扩展点")
		lists := map[string]*[]string{
			"modules": &m.Provides.Modules, "settings": &m.Provides.Settings,
			"object_types": &m.Provides.ObjectTypes, "connectors": &m.Provides.Connectors,
			"skills": &m.Provides.Skills, "agent_tools": &m.Provides.AgentTools,
			"sop_nodes": &m.Provides.SOPNodes, "today_cards": &m.Provides.TodayCards,
			"commands": &m.Provides.Commands, "search": &m.Provides.Search,
		}
		for _, ep := range ExtensionPoints {
			list, _ := c.strList(p, ep, "provides."+ep, false)
			*lists[ep] = list
			c.each("provides."+ep, list, func(s string) string { return providesItem(ep, s, id, idOK) })
		}
	}

	if list, ok := c.strList(obj, "emits", "emits", false); ok {
		m.Emits = list
		c.each("emits", list, func(s string) string {
			if !eventRe.MatchString(s) {
				return "不是合法的事件类型"
			}
			if idOK && !strings.HasPrefix(s, id+".") {
				return "必须是 " + id + ".<事件名>"
			}
			return ""
		})
	}
	if list, ok := c.strList(obj, "subscribes", "subscribes", false); ok {
		m.Subscribes = list
		c.each("subscribes", list, func(s string) string {
			mm := eventRe.FindStringSubmatch(s)
			if mm == nil {
				return "不是合法的事件类型"
			}
			ns := mm[1]
			switch {
			case slices.Contains(KernelEvents, s), idOK && ns == id:
				return ""
			case slices.Contains(kernelEventNamespaces, ns) || slices.Contains(ReservedIDs, ns):
				return "是未知的内核事件"
			}
			if _, ok := m.Depends[ns]; ok {
				return ""
			}
			if _, ok := m.OptionalDepends[ns]; ok {
				return ""
			}
			return fmt.Sprintf("订阅了 %s 的事件，但 %s 不在 depends 或 optional_depends 里", ns, ns)
		})
	}

	if a, ok := c.object(obj, "adopts", "adopts", false); ok {
		c.unknownKeys(a, adoptsFields, "adopts.", "是未知字段")
		m.Adopts.ObjectTypes, _ = c.strList(a, "object_types", "adopts.object_types", false)
		c.each("adopts.object_types", m.Adopts.ObjectTypes, func(s string) string {
			if !keyRe.MatchString(s) {
				return "不合法：只能用小写字母、数字、下划线"
			}
			return ""
		})
		m.Adopts.Routes, _ = c.strList(a, "routes", "adopts.routes", false)
		c.each("adopts.routes", m.Adopts.Routes, func(s string) string {
			if !strings.HasPrefix(s, "/api/") {
				return "必须以 /api/ 开头"
			}
			return ""
		})
	}

	if list, ok := c.strList(obj, "permissions", "permissions", true); ok {
		m.Permissions = list
		c.each("permissions", list, func(s string) string {
			if slices.Contains(Permissions, s) || secretRe.MatchString(s) {
				return ""
			}
			return "是未知权限"
		})
	}
	if m.Permissions == nil {
		m.Permissions = []string{}
	}

	hasMigrations := false
	if v, ok := c.str(obj, "migrations", "migrations", false); ok {
		m.Migrations = v
		if !relPath(v) {
			c.add("migrations", "必须是插件目录内的相对路径：%s", v)
		}
		hasMigrations = true
	}
	if v, ok := c.str(obj, "table_prefix", "table_prefix", false); ok {
		m.TablePrefix = v
		if idOK && v != id+"_" && !slices.Contains(SharedTablePrefixes[v], id) {
			c.add("table_prefix", "必须是 %s_：%s", id, v)
		}
	} else if _, has := obj["table_prefix"]; !has && hasMigrations {
		c.add("table_prefix", "有迁移时必填")
	}
	return m
}

func providesItem(ep, s, id string, idOK bool) string {
	switch ep {
	case "commands":
		if idOK && !(strings.HasPrefix(s, id+".") && keyRe.MatchString(s[len(id)+1:])) {
			return "必须是 " + id + ".<动作>"
		}
		return ""
	}
	if !keyRe.MatchString(s) {
		return "不合法：只能用小写字母、数字、下划线"
	}
	if !idOK {
		return ""
	}
	switch ep {
	case "object_types":
		if s != id && !strings.HasPrefix(s, id+"_") {
			return "必须等于 " + id + " 或以 " + id + "_ 开头"
		}
	case "skills":
		if !strings.HasPrefix(s, "sk_") {
			return "必须以 sk_ 开头"
		}
	case "agent_tools", "sop_nodes", "today_cards":
		if !strings.HasPrefix(s, id+"_") {
			return "必须以 " + id + "_ 开头"
		}
	}
	return ""
}

// relPath 判断是不是插件目录内的相对路径：非空、不以 / 开头、不含 .. 段和反斜杠。
func relPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, `\`) {
		return false
	}
	return !slices.Contains(strings.Split(p, "/"), "..")
}
