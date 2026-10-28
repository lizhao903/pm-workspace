// Package connector 是连接器框架（CONN-01a）：连接器定义在代码里注册（Registry），接入的实例存在
// connectors 表（0029，store.go）。凭证整组加密存进保险箱，表里只有条目 id 和脱敏提示；
// 明文只在连通测试、拉取工具清单时经 Config 交给定义，调用结束即丢，不进响应、日志和错误文本。
// OAuth 流程和真实连接器（GitHub 等）归 CONN-01b、01c；插件注册连接器归 CONN-02。
package connector

import (
	"context"
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
}

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
	Desc     string     `json:"desc"`
	CanSend  bool       `json:"can_send"`
	Auth     []AuthMode `json:"auth"` // 支持的认证方式，第一个是默认
	Fields   []Field    `json:"fields"`
	// Tools 是静态的工具目录：没有 ListTools 时拉取工具清单就用它
	Tools []ToolDef `json:"tools"`
	// Source 是谁提供的：core 或插件 id
	Source string `json:"source"`

	// Test 做一次连通测试，返回对方的账号名（「我」的称呼从这里来）。
	Test func(ctx context.Context, cfg Config) (account string, err error) `json:"-"`
	// ListTools 向对方拉工具清单；为 nil 时用 Tools。
	ListTools func(ctx context.Context, cfg Config) ([]ToolDef, error) `json:"-"`
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

// Registry 是连接器定义的注册表，内核启动时登记；以后插件经 CONN-02 接进来。
type Registry struct {
	mu   sync.RWMutex
	defs []Def
}

func NewRegistry() *Registry { return &Registry{} }

// Register 登记一个定义；Source 留空记为 core。
func (r *Registry) Register(d Def) error {
	if d.Source == "" {
		d.Source = "core"
	}
	// 空的也给 []，接口里不出 null
	d.Auth, d.Fields, d.Tools = nonNil(d.Auth), nonNil(d.Fields), nonNil(d.Tools)
	if err := d.check(); err != nil {
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

// List 全部定义，按登记顺序。
func (r *Registry) List() []Def {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return slices.Clone(r.defs)
}

// Get 按 tool 取定义。
func (r *Registry) Get(tool string) (Def, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, d := range r.defs {
		if d.Tool == tool {
			return d, true
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
