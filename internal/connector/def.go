// Package connector 是连接器框架（CONN-01a）：连接器定义在代码里注册（Registry），接入的实例存在
// connectors 表（0029，store.go）。凭证整组加密存进保险箱，表里只有条目 id 和脱敏提示；
// 明文只在连通测试、拉取工具清单时经 Config 交给定义，调用结束即丢，不进响应、日志和错误文本。
// OAuth 授权和令牌刷新见 oauth.go（CONN-01b）；真实连接器（GitHub 等）归 CONN-01c；插件注册连接器归 CONN-02。
package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sync"
)

// AuthMode 是认证方式，同原型 AuthMode。
type AuthMode string

const (
	AuthNone   AuthMode = "none"
	AuthOAuth2 AuthMode = "oauth2"
	AuthToken  AuthMode = "token"
)

// ToolMode 是工具授权：关闭、调用前要人确认、自动；只读工具没有「需确认」。
type ToolMode string

const (
	ModeOff     ToolMode = "off"
	ModeConfirm ToolMode = "confirm"
	ModeAuto    ToolMode = "auto"
)

// ToolDef 是对方报回来的一个工具，同原型 ToolDef。
type ToolDef struct {
	Name  string `json:"name"`
	Desc  string `json:"desc"`
	Write bool   `json:"write"`
	// Schema 是参数的 JSON Schema，给模型看；没有时不出这个键（自定义 MCP、OpenAPI 才有，CONN-04）
	Schema json.RawMessage `json:"schema,omitempty"`
}

// DefaultMode 是新拉到的工具的授权：写操作需确认，只读自动（同原型 defaultMode）。
func DefaultMode(t ToolDef) ToolMode {
	if t.Write {
		return ModeConfirm
	}
	return ModeAuto
}

// Field 是配置表单的一个字段，同原型 ToolField。kind=secret 的值进保险箱，对外只有 hint。
type Field struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Kind        string   `json:"kind"` // text / secret / select
	Placeholder string   `json:"placeholder,omitempty"`
	Options     []string `json:"options,omitempty"`
	Required    bool     `json:"required"`
	// Auth 非空时这个字段只属于这几种认证方式：别的方式下不显示、不算必填（CONN-04）
	Auth []AuthMode `json:"auth,omitempty"`
	// Default 是新建时没给的默认值（只对 text、select）
	Default string `json:"default,omitempty"`
	// Long 是长文本（多行输入，最多 maxLongValue 字），如粘贴的 OpenAPI 文档
	Long bool `json:"long,omitempty"`
	// Picker 非空时界面用对应的选择器填这个字段，存的仍是 text（只对 kind=text）；不认识的界面照旧给文本框。
	// 目前只有 PickerIMChannels：从 IM 插件列出的会话里勾选，存逗号分隔的会话编号
	Picker string `json:"picker,omitempty"`
}

// PickerIMChannels：从 GET /api/im/connectors/{id}/conversations 列出的频道里勾选（Slack「监听频道」）。
const PickerIMChannels = "im_channels"

// appliesTo 是这个字段在认证方式 m 下有没有用。
func (f *Field) appliesTo(m AuthMode) bool { return len(f.Auth) == 0 || slices.Contains(f.Auth, m) }

// Config 是交给定义的一次调用的配置：非凭证字段和解密后的凭证。只在调用期间有效，不要留存或打日志。
type Config struct {
	Mode    AuthMode
	values  map[string]string
	secrets map[string]string
}

// Get 取非凭证字段，没填为空串。
func (c Config) Get(key string) string { return c.values[key] }

// Secret 取凭证字段的明文，没填为空串。
func (c Config) Secret(key string) string { return c.secrets[key] }

// AccessToken 是 OAuth 授权拿到的 access_token，没授权为空串。
func (c Config) AccessToken() string { return c.secrets[keyAccessToken] }

// NewConfig 给测试和定义自己的单测用。
func NewConfig(mode AuthMode, values, secrets map[string]string) Config {
	return Config{Mode: mode, values: values, secrets: secrets}
}

// Def 是一个连接器定义。Tool 全局唯一，同原型 Tool.key。
type Def struct {
	Tool     string     `json:"tool"`
	Label    string     `json:"label"`
	Category string     `json:"category"` // im / media / market / dev / other
	Color    string     `json:"color"`
	Logo     string     `json:"logo"` // 平台图标的键（TSK-0725），留空时 Prepare 按 builtinLogos 补，见 logo.go
	Desc     string     `json:"desc"`
	CanSend  bool       `json:"can_send"`
	Auth     []AuthMode `json:"auth"` // 支持的认证方式，第一个是默认
	Fields   []Field    `json:"fields"`
	// Tools 是静态的工具目录：没有 ListTools 时拉取工具清单就用它
	Tools []ToolDef `json:"tools"`
	// Source 是谁提供的：core 或插件 id
	Source string `json:"source"`
	// OAuth 是 OAuth 2.0 的配置；Auth 含 oauth2 时必填
	OAuth *OAuthSpec `json:"oauth"`

	// Test 做一次连通测试，返回对方的账号名（「我」的称呼从这里来）。
	Test func(ctx context.Context, cfg Config) (account string, err error) `json:"-"`
	// ListTools 向对方拉工具清单；为 nil 时用 Tools。
	ListTools func(ctx context.Context, cfg Config) ([]ToolDef, error) `json:"-"`
	// Call 真正调对方的一个工具（AG-02a），args 是参数 JSON 原文，回给模型看的结果文本；
	// 为 nil 时 Agent 调这个连接器的工具回「这个连接器的工具还不能调用」。
	Call func(ctx context.Context, cfg Config, tool string, args json.RawMessage) (string, error) `json:"-"`
	// CheckConfig 在新建、修改时校验合并后的非凭证字段（如地址只能是 http(s)），nil 不查（CONN-04）
	CheckConfig func(values map[string]string) error `json:"-"`
}

var (
	toolRe  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	fieldRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
)

func (d *Def) check() error {
	if !toolRe.MatchString(d.Tool) {
		return fmt.Errorf("connector tool %q must be lowercase letters, digits and underscores", d.Tool)
	}
	if d.Label == "" {
		return fmt.Errorf("connector %s: label is required", d.Tool)
	}
	if d.Logo != "" && !logoRe.MatchString(d.Logo) {
		return fmt.Errorf("connector %s: logo %q must be lowercase letters and digits", d.Tool, d.Logo)
	}
	if len(d.Auth) == 0 {
		return fmt.Errorf("connector %s: at least one auth mode is required", d.Tool)
	}
	for _, m := range d.Auth {
		if m != AuthNone && m != AuthOAuth2 && m != AuthToken {
			return fmt.Errorf("connector %s: unknown auth mode %q", d.Tool, m)
		}
	}
	if d.Test == nil {
		return fmt.Errorf("connector %s: Test is required", d.Tool)
	}
	seen := map[string]bool{}
	for _, f := range d.Fields {
		if !fieldRe.MatchString(f.Key) || seen[f.Key] {
			return fmt.Errorf("connector %s: field key %q is invalid or repeated", d.Tool, f.Key)
		}
		seen[f.Key] = true
		if f.Kind != "text" && f.Kind != "secret" && f.Kind != "select" {
			return fmt.Errorf("connector %s: field %s has unknown kind %q", d.Tool, f.Key, f.Kind)
		}
		for _, m := range f.Auth {
			if !slices.Contains(d.Auth, m) {
				return fmt.Errorf("connector %s: field %s belongs to auth mode %q that is not supported", d.Tool, f.Key, m)
			}
		}
		if f.Picker != "" && (f.Kind != "text" || f.Long || f.Picker != PickerIMChannels) {
			return fmt.Errorf("connector %s: field %s has an invalid picker %q", d.Tool, f.Key, f.Picker)
		}
		if f.Default != "" && (f.Kind == "secret" || f.Kind == "select" && !slices.Contains(f.Options, f.Default)) {
			return fmt.Errorf("connector %s: field %s has an invalid default", d.Tool, f.Key)
		}
	}
	if slices.Contains(d.Auth, AuthOAuth2) {
		if d.OAuth == nil {
			return fmt.Errorf("connector %s: oauth2 needs an OAuth spec", d.Tool)
		}
		if err := d.OAuth.check(d); err != nil {
			return fmt.Errorf("connector %s: %w", d.Tool, err)
		}
	} else if d.OAuth != nil {
		return fmt.Errorf("connector %s: OAuth spec given but oauth2 is not an auth mode", d.Tool)
	}
	return checkToolDefs(d.Tool, d.Tools)
}

func checkToolDefs(tool string, ts []ToolDef) error {
	seen := map[string]bool{}
	for _, t := range ts {
		if t.Name == "" || seen[t.Name] {
			return fmt.Errorf("connector %s: tool name %q is empty or repeated", tool, t.Name)
		}
		seen[t.Name] = true
	}
	return nil
}

func (d *Def) field(key string) *Field {
	for i := range d.Fields {
		if d.Fields[i].Key == key {
			return &d.Fields[i]
		}
	}
	return nil
}

// ErrDuplicate：同一个 tool 注册了两次。
var ErrDuplicate = errors.New("connector already registered")

// Registry 是连接器定义的注册表，内核启动时登记；插件的定义经 SetPluginDefs 接进来（CONN-02）。
type Registry struct {
	mu   sync.RWMutex
	defs []Def
	// plugin 返回在跑的插件登记的定义（已经 Prepare 过），每次 List、Get 现取：插件停用后立刻不在里面
	plugin func() []Def
}

// SetPluginDefs 接上插件登记的定义（plugin.Registry.ConnectorDefs）。和内核定义同 tool 时内核的优先，插件的不出现。
func (r *Registry) SetPluginDefs(fn func() []Def) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.plugin = fn
}

func NewRegistry() *Registry { return &Registry{} }

// Prepare 补齐默认值并校验，返回可以登记的定义；Source 留空记为 core。插件登记时也走它。
func Prepare(d Def) (Def, error) {
	if d.Source == "" {
		d.Source = "core"
	}
	if d.Logo == "" {
		d.Logo = builtinLogos[d.Tool]
	}
	// 空的也给 []，接口里不出 null
	d.Auth, d.Fields, d.Tools = nonNil(d.Auth), nonNil(d.Fields), nonNil(d.Tools)
	if d.OAuth != nil {
		// 拷一份再改，不动调用方的定义
		o := *d.OAuth
		o.Scopes, o.Builtin = nonNil(o.Scopes), o.ClientID != ""
		d.OAuth = &o
	}
	if err := d.check(); err != nil {
		return Def{}, err
	}
	return d, nil
}

// Register 登记一个内核定义；Source 留空记为 core。
func (r *Registry) Register(d Def) error {
	d, err := Prepare(d)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if slices.ContainsFunc(r.defs, func(x Def) bool { return x.Tool == d.Tool }) {
		return fmt.Errorf("%w: %s", ErrDuplicate, d.Tool)
	}
	r.defs = append(r.defs, d)
	return nil
}

// List 全部定义：内核的按登记顺序，后面是在跑的插件登记的。
func (r *Registry) List() []Def {
	r.mu.RLock()
	out, fn := slices.Clone(r.defs), r.plugin
	r.mu.RUnlock()
	if fn == nil {
		return out
	}
	for _, d := range fn() {
		if !slices.ContainsFunc(out, func(x Def) bool { return x.Tool == d.Tool }) {
			out = append(out, d)
		}
	}
	return out
}

// Get 按 tool 取定义；插件停用后它的定义取不到，实例上 available 为 false。
func (r *Registry) Get(tool string) (Def, bool) {
	r.mu.RLock()
	i, fn := slices.IndexFunc(r.defs, func(d Def) bool { return d.Tool == tool }), r.plugin
	var d Def
	if i >= 0 {
		d = r.defs[i]
	}
	r.mu.RUnlock()
	if i >= 0 {
		return d, true
	}
	if fn != nil {
		for _, d := range fn() {
			if d.Tool == tool {
				return d, true
			}
		}
	}
	return Def{}, false
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
