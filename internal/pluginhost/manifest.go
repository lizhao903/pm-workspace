// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// ManifestVersion 是外部插件清单格式版本，固定 2（docs/plugin-spec-v2.md 4.2）。
const ManifestVersion = 2

// Manifest 是外部插件 plugin.json（manifest_version 2）。
// 字段与 docs/plugin-spec-v2.md 4.2 一致；第一方内置插件用 internal/plugin.Manifest，两套不要混用。
type Manifest struct {
	ManifestVersion   int               `json:"manifest_version"`
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	Description       string            `json:"description,omitempty"`
	Version           string            `json:"version"`
	API               string            `json:"api"`
	PMW               string            `json:"pmw"`
	License           string            `json:"license"`
	Homepage          string            `json:"homepage,omitempty"`
	Repository        string            `json:"repository"`
	Publisher         *Publisher        `json:"publisher,omitempty"`
	Icon              string            `json:"icon,omitempty"`
	Provides          Provides          `json:"provides,omitzero"`
	Permissions       []string          `json:"permissions"`
	PermissionsReason map[string]string `json:"permissions_reason"`
	Runtime           Runtime           `json:"runtime"`
	Depends           map[string]string `json:"depends,omitempty"`
	OptionalDepends   map[string]string `json:"optional_depends,omitempty"`
	Emits             []string          `json:"emits,omitempty"`
	Subscribes        []string          `json:"subscribes,omitempty"`
	Migrations        string            `json:"migrations,omitempty"`
}

// Publisher 是可选发布者信息；没有 publisher 或没有 key = 未签名（community）。
type Publisher struct {
	ID  string `json:"id"`
	Key string `json:"key,omitempty"`
}

// Provides 按扩展点分组列出本插件注册的 id（规则同 v1，docs/plugin-spec-v2.md 4.4）。
type Provides struct {
	Modules         []string `json:"modules,omitempty"`
	Settings        []string `json:"settings,omitempty"`
	ObjectTypes     []string `json:"object_types,omitempty"`
	Connectors      []string `json:"connectors,omitempty"`
	Skills          []string `json:"skills,omitempty"`
	AgentTools      []string `json:"agent_tools,omitempty"`
	SOPNodes        []string `json:"sop_nodes,omitempty"`
	TodayCards      []string `json:"today_cards,omitempty"`
	Commands        []string `json:"commands,omitempty"`
	Search          []string `json:"search,omitempty"`
	ScheduleActions []string `json:"schedule_actions,omitempty"`
}

// Runtime 是运行形态：backend（子进程 + RPC）和 web（前端 ESM）至少一个。
type Runtime struct {
	Backend *BackendRuntime `json:"backend,omitempty"`
	Web     *WebRuntime     `json:"web,omitempty"`
}

// BackendRuntime 是后端子进程配置。
type BackendRuntime struct {
	Kind            string            `json:"kind"`
	Protocol        string            `json:"protocol"`
	Entry           map[string]string `json:"entry"`
	HealthTimeoutMS int               `json:"health_timeout_ms,omitempty"`
}

// WebRuntime 是前端 ESM 配置。
type WebRuntime struct {
	Entry  string   `json:"entry"`
	Styles []string `json:"styles,omitempty"`
}

// HealthTimeout 返回健康检查超时，缺省 10s。
func (r *BackendRuntime) HealthTimeout() time.Duration {
	if r == nil || r.HealthTimeoutMS <= 0 {
		return 10 * time.Second
	}
	return time.Duration(r.HealthTimeoutMS) * time.Millisecond
}

// Issue 是一条校验问题，Field 是字段路径，例 permissions[1]、runtime.backend.entry。
type Issue struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (i Issue) String() string { return i.Field + " " + i.Message }

// ValidationError 汇总一份清单的全部问题；errors.Is(err, ErrValidation) 为真。
type ValidationError struct {
	Issues []Issue
}

func (e *ValidationError) Error() string {
	parts := make([]string, len(e.Issues))
	for i, is := range e.Issues {
		parts[i] = is.String()
	}
	return "插件清单不合法：" + strings.Join(parts, "；")
}

// Is 让 ValidationError 匹配 ErrValidation 哨兵。
func (e *ValidationError) Is(target error) bool { return target == ErrValidation }

// Issues 取出 err 里的校验问题；不是校验错误时返回 nil。
func Issues(err error) []Issue {
	var ve *ValidationError
	if errors.As(err, &ve) {
		return ve.Issues
	}
	return nil
}

// 顶层字段（docs/plugin-spec-v2.md 4.2）；额外的字段一律非法。
var manifestFields = []string{
	"manifest_version", "id", "name", "description", "version", "api", "pmw",
	"license", "homepage", "repository", "publisher", "icon", "provides",
	"permissions", "permissions_reason", "runtime", "depends", "optional_depends",
	"emits", "subscribes", "migrations",
}

// 外部插件禁止的 v1 字段及替代方式（docs/plugin-spec-v2.md 4.4）。
var forbiddenFields = map[string]string{
	"core":         "改用 api + pmw 版本范围",
	"adopts":       "外部插件不能认领内核已有对象类型/路由",
	"table_prefix": "外部插件没有内核表前缀，数据只进私有库",
	"icons":        "v2 外部插件只用单一 icon 包内路径",
}

// v2 权限 = v1 权限 + 外部插件新增能力（docs/plugin-spec-v2.md 5.2）。
var v2ExtraPermissions = []string{
	"objects:read", "objects:write", "events:subscribe", "agent:run",
	"notify", "schedule", "artifacts:write", "audit:write",
}

// BuiltinPluginIDs 是第一方内置插件 id；外部插件不能和它们重名（以 internal/plugins/ 为准）。
var BuiltinPluginIDs = []string{
	"browser", "domains", "etf", "im", "jobs", "projects",
	"recording", "sop", "terminal", "trade", "tts", "video",
}

// KernelEvents 是宿主当前公开的内核事件（复用 v1 列表）。
var KernelEvents = plugin.KernelEvents

var (
	idRe        = regexp.MustCompile(`^[a-z][a-z0-9_]{1,23}$`)
	keyRe       = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	eventRe     = regexp.MustCompile(`^([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*$`)
	secretRe    = regexp.MustCompile(`^secrets:[a-z][a-z0-9_]*$`)
	platformRe  = regexp.MustCompile(`^(darwin|linux|windows)-(amd64|arm64)$`)
	publisherRe = regexp.MustCompile(`^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$`)
	base64KeyRe = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)
	cjkRe       = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)
)

// Parse 解析 plugin.json 并做结构 + 语义校验（docs/plugin-spec-v2.md 4.6 第 1–3 步）。
// 环境相关（api/pmw 是否兼容、依赖是否满足）由 Resolve 用 CheckCompatibility 单独做。
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
	return fromValue(raw)
}

// fromValue 校验已经解成通用值的清单。
func fromValue(raw any) (*Manifest, error) {
	c := &checker{}
	m := c.manifest(raw)
	if len(c.issues) > 0 {
		return nil, &ValidationError{c.issues}
	}
	return m, nil
}

// pmwVersionMatches 判断宿主版本是否落在插件声明的 pmw 范围里。
// 宿主版本为空或不是正式版本号（开发构建 -X main.version=dev 编出来的 "dev"）时不判断、算满足：
// 生产实例 bro.vip 就是 dev 构建，按字面比较会把所有声明了 pmw 范围的外部插件都拦下。
// api 范围照常检查，插件协议不兼容仍然装不上。
func pmwVersionMatches(hostVersion, rng string) bool {
	if _, ok := plugin.ParseVersion(strings.TrimSpace(hostVersion)); !ok {
		return true
	}
	return plugin.Satisfies(strings.TrimSpace(hostVersion), rng)
}

// CheckCompatibility 检查清单声明的 api / pmw 范围是否包含当前宿主版本。
// hostVersion 为空或不是正式版本号（如 dev）时跳过 pmw 检查，见 pmwVersionMatches。
func CheckCompatibility(m *Manifest, hostVersion string) error {
	var issues []Issue
	if !plugin.Satisfies(ExternalAPIVersion, m.API) {
		issues = append(issues, Issue{"api", fmt.Sprintf(
			"不包含宿主插件 API 版本 %s：%s", ExternalAPIVersion, m.API)})
	}
	if !pmwVersionMatches(hostVersion, m.PMW) {
		issues = append(issues, Issue{"pmw", fmt.Sprintf(
			"不包含当前 PMW 版本 %s：%s", hostVersion, m.PMW)})
	}
	if len(issues) > 0 {
		return &ValidationError{issues}
	}
	return nil
}

// CurrentPlatform 返回当前平台的清单键，例 darwin-arm64。
func CurrentPlatform() string { return platformKey() }

type checker struct{ issues []Issue }

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

// each 逐项检查并查重；check 返回空串表示通过。
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

func (c *checker) manifest(raw any) *Manifest {
	obj, ok := raw.(map[string]any)
	if !ok {
		c.add("清单", "必须是 JSON 对象")
		return nil
	}
	m := &Manifest{}

	// 先给禁止字段更明确的提示，再报未知字段。
	for _, k := range sortedKeys(obj) {
		if hint, bad := forbiddenFields[k]; bad {
			c.add(k, "外部插件不允许该字段（%s）", hint)
		} else if !slices.Contains(manifestFields, k) {
			c.add(k, "是未知字段")
		}
	}

	idOK := false
	if v, has := obj["id"]; !has {
		c.add("id", "必填")
	} else if id, ok := v.(string); !ok {
		c.add("id", "必须是字符串")
	} else {
		switch {
		case !idRe.MatchString(id):
			c.add("id", "不合法：必须匹配 %s：%s", idRe.String(), id)
		case slices.Contains(plugin.ReservedIDs, id):
			c.add("id", "是内核保留字：%s", id)
		case slices.Contains(BuiltinPluginIDs, id):
			c.add("id", "与内置插件 id 冲突：%s", id)
		default:
			idOK = true
		}
		m.ID = id
	}
	id := m.ID

	// manifest_version
	if v, has := obj["manifest_version"]; !has {
		c.add("manifest_version", "必填")
	} else if n, ok := v.(json.Number); !ok || n.String() != "2" {
		c.add("manifest_version", "必须固定为 2")
	} else {
		m.ManifestVersion = ManifestVersion
	}

	if name, ok := c.str(obj, "name", "name", true); ok {
		if strings.TrimSpace(name) == "" {
			c.add("name", "不能为空")
		}
		m.Name = name
	}
	m.Description, _ = c.str(obj, "description", "description", false)

	if v, ok := c.str(obj, "version", "version", true); ok {
		if _, ok := plugin.ParseVersion(v); !ok {
			c.add("version", "不是合法的版本号（MAJOR.MINOR.PATCH）：%s", v)
		}
		m.Version = v
	}
	if v, ok := c.str(obj, "api", "api", true); ok {
		if _, ok := plugin.ParseRange(v); !ok {
			c.add("api", "版本范围不合法：%s", v)
		}
		m.API = v
	}
	if v, ok := c.str(obj, "pmw", "pmw", true); ok {
		if _, ok := plugin.ParseRange(v); !ok {
			c.add("pmw", "版本范围不合法：%s", v)
		}
		m.PMW = v
	}
	if v, ok := c.str(obj, "license", "license", true); ok {
		if strings.TrimSpace(v) == "" {
			c.add("license", "不能为空")
		}
		m.License = v
	}
	if v, ok := c.str(obj, "homepage", "homepage", false); ok {
		if !strings.HasPrefix(v, "https://") && !strings.HasPrefix(v, "http://") {
			c.add("homepage", "必须是 http(s) URL：%s", v)
		}
		m.Homepage = v
	}
	if v, ok := c.str(obj, "repository", "repository", true); ok {
		// v0.1 只接受 github.com 的 https 仓库（docs/plugin-spec-v2.md 4.2 / 3.1）。
		if !strings.HasPrefix(v, "https://github.com/") {
			c.add("repository", "v0.1 只接受 https://github.com/...：%s", v)
		}
		m.Repository = v
	}
	if p, ok := c.object(obj, "publisher", "publisher", false); ok {
		c.unknownKeys(p, []string{"id", "key"}, "publisher.", "是未知字段")
		m.Publisher = &Publisher{}
		if v, ok := c.str(p, "id", "publisher.id", true); ok {
			if !publisherRe.MatchString(v) {
				c.add("publisher.id", "不合法：应形如 github:owner：%s", v)
			}
			m.Publisher.ID = v
		}
		if v, ok := c.str(p, "key", "publisher.key", false); ok {
			if !base64KeyRe.MatchString(v) {
				c.add("publisher.key", "必须是 ed25519 公钥 raw 32 字节的 base64（44 字符）")
			} else if raw, err := base64.StdEncoding.DecodeString(v); err != nil || len(raw) != 32 {
				c.add("publisher.key", "不是合法的 ed25519 公钥")
			}
			m.Publisher.Key = v
		}
	}
	if v, ok := c.str(obj, "icon", "icon", false); ok {
		if !relPath(v) {
			c.add("icon", "必须是插件目录内的相对路径：%s", v)
		}
		m.Icon = v
	}

	c.provides(obj, m, id, idOK)
	c.permissions(obj, m)
	c.runtime(obj, m)
	c.deps(obj, m, id)
	c.events(obj, m, id, idOK)
	if v, ok := c.str(obj, "migrations", "migrations", false); ok {
		if !relPath(v) {
			c.add("migrations", "必须是插件目录内的相对路径：%s", v)
		}
		m.Migrations = v
	}

	// 清单内一致性（docs/plugin-spec-v2.md 5.6）。
	if len(m.Provides.Modules) > 0 && m.Runtime.Web == nil {
		c.add("runtime", "提供了 provides.modules 就必须有 runtime.web")
	}
	if len(m.Provides.Connectors) > 0 {
		hasNetwork := false
		for _, p := range m.Permissions {
			if strings.HasPrefix(p, "network:") {
				hasNetwork = true
				break
			}
		}
		if !hasNetwork {
			c.add("permissions", "提供了 provides.connectors 就必须至少声明一项 network:* 权限")
		}
	}
	hasSubPerm := slices.Contains(m.Permissions, "events:subscribe")
	if len(m.Subscribes) > 0 && !hasSubPerm {
		c.add("permissions", "声明了 subscribes 就必须有 events:subscribe 权限")
	}
	if hasSubPerm && len(m.Subscribes) == 0 {
		c.add("subscribes", "声明了 events:subscribe 权限就必须有订阅")
	}
	return m
}

func (c *checker) provides(obj map[string]any, m *Manifest, id string, idOK bool) {
	p, ok := c.object(obj, "provides", "provides", false)
	if !ok {
		return
	}
	known := []string{
		"modules", "settings", "object_types", "connectors", "skills", "agent_tools",
		"sop_nodes", "today_cards", "commands", "search", "schedule_actions",
	}
	c.unknownKeys(p, known, "provides.", "是未知扩展点")

	lists := map[string]*[]string{
		"modules": &m.Provides.Modules, "settings": &m.Provides.Settings,
		"object_types": &m.Provides.ObjectTypes, "connectors": &m.Provides.Connectors,
		"skills": &m.Provides.Skills, "agent_tools": &m.Provides.AgentTools,
		"sop_nodes": &m.Provides.SOPNodes, "today_cards": &m.Provides.TodayCards,
		"commands": &m.Provides.Commands, "search": &m.Provides.Search,
		"schedule_actions": &m.Provides.ScheduleActions,
	}
	for _, ep := range known {
		list, _ := c.strList(p, ep, "provides."+ep, false)
		*lists[ep] = list
		c.each("provides."+ep, list, func(s string) string {
			return providesItem(ep, s, id, idOK)
		})
	}
}

func providesItem(ep, s, id string, idOK bool) string {
	if ep == "commands" {
		if !idOK {
			return ""
		}
		if !strings.HasPrefix(s, id+".") || !keyRe.MatchString(s[len(id)+1:]) {
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
	case "agent_tools", "sop_nodes", "today_cards", "schedule_actions":
		if !strings.HasPrefix(s, id+"_") {
			return "必须以 " + id + "_ 开头"
		}
	}
	return ""
}

// validPermission 判断是不是 v2 可申请权限。
func validPermission(name string) bool {
	if slices.Contains(plugin.Permissions, name) || slices.Contains(v2ExtraPermissions, name) {
		return true
	}
	return secretRe.MatchString(name)
}

func (c *checker) permissions(obj map[string]any, m *Manifest) {
	list, ok := c.strList(obj, "permissions", "permissions", true)
	if ok {
		m.Permissions = list
		c.each("permissions", list, func(s string) string {
			if !validPermission(s) {
				return "是未知权限"
			}
			return ""
		})
	}
	if m.Permissions == nil {
		m.Permissions = []string{}
	}

	reasons, ok := c.object(obj, "permissions_reason", "permissions_reason", true)
	if !ok {
		return
	}
	m.PermissionsReason = map[string]string{}
	for _, k := range sortedKeys(reasons) {
		f := "permissions_reason." + k
		v, isStr := reasons[k].(string)
		switch {
		case !validPermission(k):
			c.add(f, "不是已声明的权限：%s", k)
		case !isStr:
			c.add(f, "必须是字符串")
		case strings.TrimSpace(v) == "":
			c.add(f, "不能为空")
		case utf8RuneLen(v) > 80:
			c.add(f, "必须是 1–80 字的理由")
		case !cjkRe.MatchString(v):
			c.add(f, "必须是中文理由")
		default:
			m.PermissionsReason[k] = v
		}
	}
	// 每一项权限都必须有理由，缺一项即清单非法；反过来给未声明的权限写理由也非法。
	for i, p := range m.Permissions {
		if _, has := reasons[p]; !has {
			c.add(fmt.Sprintf("permissions[%d]", i), "缺少 permissions_reason 里的中文理由：%s", p)
		}
	}
	for _, k := range sortedKeys(reasons) {
		if !slices.Contains(m.Permissions, k) {
			c.add("permissions_reason."+k, "不是已声明的权限：%s", k)
		}
	}
}

func (c *checker) runtime(obj map[string]any, m *Manifest) {
	rt, ok := c.object(obj, "runtime", "runtime", true)
	if !ok {
		return
	}
	c.unknownKeys(rt, []string{"backend", "web"}, "runtime.", "是未知字段")

	if b, ok := c.object(rt, "backend", "runtime.backend", false); ok {
		c.unknownKeys(b, []string{"kind", "protocol", "entry", "health_timeout_ms"}, "runtime.backend.", "是未知字段")
		be := &BackendRuntime{}
		if v, ok := c.str(b, "kind", "runtime.backend.kind", true); ok {
			if v != "process" {
				c.add("runtime.backend.kind", "v0.1 只支持 process：%s", v)
			}
			be.Kind = v
		}
		if v, ok := c.str(b, "protocol", "runtime.backend.protocol", true); ok {
			if v != ProtocolVersion {
				c.add("runtime.backend.protocol", "必须固定为 %s：%s", ProtocolVersion, v)
			}
			be.Protocol = v
		}
		entries, hasEntry := c.object(b, "entry", "runtime.backend.entry", true)
		if hasEntry {
			if len(entries) == 0 {
				c.add("runtime.backend.entry", "至少列出一个平台")
			}
			be.Entry = map[string]string{}
			for _, k := range sortedKeys(entries) {
				f := "runtime.backend.entry." + k
				v, isStr := entries[k].(string)
				switch {
				case !platformRe.MatchString(k):
					c.add(f, "不是合法的平台键（例 darwin-arm64）")
				case !isStr:
					c.add(f, "必须是字符串")
				case !relPath(v):
					c.add(f, "必须是插件目录内的相对路径：%s", v)
				default:
					be.Entry[k] = v
				}
			}
		}
		if v, has := b["health_timeout_ms"]; has {
			n, ok := v.(json.Number)
			if !ok {
				c.add("runtime.backend.health_timeout_ms", "必须是整数")
			} else if ms, err := n.Int64(); err != nil || ms < 100 || ms > 60000 {
				c.add("runtime.backend.health_timeout_ms", "范围必须是 100–60000")
			} else {
				be.HealthTimeoutMS = int(ms)
			}
		}
		m.Runtime.Backend = be
	}

	if w, ok := c.object(rt, "web", "runtime.web", false); ok {
		c.unknownKeys(w, []string{"entry", "styles"}, "runtime.web.", "是未知字段")
		we := &WebRuntime{}
		if v, ok := c.str(w, "entry", "runtime.web.entry", true); ok {
			if !relPath(v) {
				c.add("runtime.web.entry", "必须是插件目录内的相对路径：%s", v)
			}
			we.Entry = v
		}
		if styles, ok := c.strList(w, "styles", "runtime.web.styles", false); ok {
			we.Styles = styles
			c.each("runtime.web.styles", styles, func(s string) string {
				if !relPath(s) {
					return "必须是插件目录内的相对路径"
				}
				return ""
			})
		}
		m.Runtime.Web = we
	}

	if m.Runtime.Backend == nil && m.Runtime.Web == nil {
		c.add("runtime", "backend 和 web 至少要有一个")
	}
}

func (c *checker) deps(obj map[string]any, m *Manifest, id string) {
	m.Depends = c.depMap(obj, "depends", id)
	m.OptionalDepends = c.depMap(obj, "optional_depends", id)
	for _, dep := range sortedKeys(m.OptionalDepends) {
		if _, dup := m.Depends[dep]; dup {
			c.add("optional_depends."+dep, "已在 depends 里声明")
		}
	}
}

func (c *checker) depMap(obj map[string]any, key, id string) map[string]string {
	o, ok := c.object(obj, key, key, false)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for _, dep := range sortedKeys(o) {
		f := key + "." + dep
		rng, isStr := o[dep].(string)
		switch {
		case !idRe.MatchString(dep):
			c.add(f, "不是合法的插件 id")
		case dep == id:
			c.add(f, "不能依赖自己")
		case !isStr:
			c.add(f, "必须是字符串")
		default:
			if _, ok := plugin.ParseRange(rng); !ok {
				c.add(f, "版本范围不合法：%s", rng)
				continue
			}
			out[dep] = rng
		}
	}
	return out
}

func (c *checker) events(obj map[string]any, m *Manifest, id string, idOK bool) {
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
			case slices.Contains(KernelEvents, s):
				return ""
			case slices.Contains(plugin.ReservedIDs, ns) || slices.Contains([]string{"object", "task", "run", "contact"}, ns):
				return "是未知的内核事件"
			case ns == id:
				return "不能订阅自己发布的事件"
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
}

// relPath 判断是不是包内相对路径：非空、不以 / 开头、不含 .. 段和反斜杠。
func relPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, `\`) {
		return false
	}
	return !slices.Contains(strings.Split(p, "/"), "..")
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func utf8RuneLen(s string) int { return len([]rune(s)) }
