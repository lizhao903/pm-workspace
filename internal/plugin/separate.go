// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
)

// 单独申请的权限（TRD-08c，docs/plugin-api.md 3.2）：清单里可以声明，但安装、升级都不授予，也不要求确认；
// 要用户本人在插件自己的设置里单独申请（POST /api/plugins/{id}/permissions/grant，二次确认输入插件名），
// 插件实现 PermissionGuard 时还要它同意（交易插件：实盘评审通过）。收回随时可以，不用确认。
//
// 现在只有 trade:live（实盘下单，风险最高）。

// SeparatePermissions 是单独申请的权限。
var SeparatePermissions = []string{"trade:live"}

// IsSeparate 看一项权限是不是要单独申请的。
func IsSeparate(perm string) bool { return slices.Contains(SeparatePermissions, perm) }

// installable 是清单里安装、升级时要确认并授予的权限：去掉单独申请的。
func installable(m Manifest) []string {
	out := []string{}
	for _, p := range m.Permissions {
		if !IsSeparate(p) {
			out = append(out, p)
		}
	}
	return out
}

// SeparateDeclared 是清单里声明了的单独申请的权限，按清单顺序。
func (in Info) SeparateDeclared() []string {
	out := []string{}
	for _, p := range in.Manifest.Permissions {
		if IsSeparate(p) {
			out = append(out, p)
		}
	}
	return out
}

// PermissionGuard 是可选接口：用户申请单独授予的权限前问插件一次，ok 为 false 时拒绝，reason 给用户看。
type PermissionGuard interface {
	CanGrant(ctx context.Context, c Core, perm string) (ok bool, reason string)
}

// GrantDeniedError：插件的 PermissionGuard 不同意授予。
type GrantDeniedError struct {
	ID, Perm, Reason string
}

func (e *GrantDeniedError) Error() string {
	return fmt.Sprintf("插件 %s 现在不能授予 %s：%s", e.ID, e.Perm, e.Reason)
}

// ErrNotSeparate：要单独授予、收回的权限不是单独申请的，或清单里没声明。
var ErrNotSeparate = errors.New("permission is not separately granted")

// checkSeparate：已安装、清单声明了、是单独申请的权限。调用方持有 r.mu。
func (r *Registry) checkSeparate(e *entry, perm string) error {
	if !e.state.Installed {
		return fmt.Errorf("%w: 插件 %s 未安装", ErrState, e.m.ID)
	}
	if !IsSeparate(perm) {
		return fmt.Errorf("%w: %s 不是单独申请的权限，随安装、升级确认", ErrNotSeparate, perm)
	}
	if !slices.Contains(e.m.Permissions, perm) {
		return fmt.Errorf("%w: 插件 %s 的清单里没有声明 %s", ErrNotSeparate, e.m.ID, perm)
	}
	return nil
}

// Grant 单独授予一项权限：插件要在跑（PermissionGuard 要问它），插件同意后写状态表。已授予时什么都不做。
// 谁能调由接口层管（只接受用户本人在界面上的操作，见 RequireUser）。
func (r *Registry) Grant(ctx context.Context, id, perm string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	if err := r.checkSeparate(e, perm); err != nil {
		return err
	}
	if slices.Contains(e.state.Permissions, perm) {
		return nil
	}
	if e.active.Load() == nil {
		return fmt.Errorf("%w: 插件 %s 没在运行，先启用", ErrState, id)
	}
	if g, ok := e.p.(PermissionGuard); ok {
		if ok, reason := g.CanGrant(ctx, e.core, perm); !ok {
			return &GrantDeniedError{ID: id, Perm: perm, Reason: reason}
		}
	}
	now := time.Now().UTC()
	st := e.state
	st.Permissions = append(slices.Clone(st.Permissions), perm)
	st.PermissionsAt, st.UpdatedAt = &now, now
	if err := r.store.Save(ctx, st); err != nil {
		return err
	}
	r.setState(e, st)
	e.core.log.Info("plugin permission granted", "perm", perm)
	return nil
}

// Revoke 收回一项单独授予的权限。没授予时什么都不做。
func (r *Registry) Revoke(ctx context.Context, id, perm string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	if !e.state.Installed {
		return fmt.Errorf("%w: 插件 %s 未安装", ErrState, id)
	}
	if !IsSeparate(perm) {
		return fmt.Errorf("%w: %s 不是单独申请的权限，随安装、升级确认", ErrNotSeparate, perm)
	}
	if !slices.Contains(e.state.Permissions, perm) {
		return nil
	}
	now := time.Now().UTC()
	st := e.state
	st.Permissions = slices.DeleteFunc(slices.Clone(st.Permissions), func(p string) bool { return p == perm })
	st.PermissionsAt, st.UpdatedAt = &now, now
	if err := r.store.Save(ctx, st); err != nil {
		return err
	}
	r.setState(e, st)
	e.core.log.Info("plugin permission revoked", "perm", perm)
	return nil
}

// RevokePermission 让插件收回自己单独授予的权限（交易插件：撤回评审时 trade:live 一并收回）。
// 只能收回，不能授予；不能在持有注册表锁的回调里调（Register、CanDisable、CanGrant 等）。
func (c *core) RevokePermission(ctx context.Context, perm string) error {
	if c.reg == nil {
		return fmt.Errorf("%w: 插件 %s 没接注册表", ErrState, c.id)
	}
	return c.reg.Revoke(ctx, c.id, perm)
}

/* ---------- 只接受用户本人的操作 ---------- */

// 内核区分「用户本人」和 Agent、脚本只有一种办法：请求带的取证头 X-Actor-Source（api 层的 actorFrom 解析后放进 ctx）。
// 前端的写请求一律带 X-Actor-Source: ui、不带会话标识；pmw-mcp（Agent 经 MCP 回写）一律带 agent 和 X-Actor-Session；
// 没带头的（curl、脚本、别的进程）是 api。所以「只接受用户本人」= 来源是 ui 且没带会话标识。
//
// 这只是声明式的来源，不是认证：本机任何能发 HTTP 的进程都能伪造 X-Actor-Source: ui（内核没有用户会话或令牌）。
// 它挡得住走 MCP 工具、内置 Agent 和照常调接口的代理，挡不住故意伪造请求头的本机进程。

// RequestActor 是这次请求的操作者（取证头解析出来的）。
type RequestActor struct {
	Name    string
	Session string
	Source  string // ui / api / agent / import，不认识的降成 api
}

// ActorOf 取 ctx 里这次请求的操作者；不是从接口进来的（后台任务）是 me / api。
func ActorOf(ctx context.Context) RequestActor {
	a := audit.ActorFrom(ctx)
	return RequestActor{Name: a.Name, Session: a.Session, Source: a.Source}
}

// IsUser：来源是界面（ui）且没带会话标识。
func (a RequestActor) IsUser() bool { return a.Source == "ui" && a.Session == "" }

// Label 是给人看的操作者：名字，带会话时加「#会话」，再加来源。
func (a RequestActor) Label() string {
	s := a.Name
	if a.Session != "" {
		s += "#" + a.Session
	}
	return s + "（" + a.Source + "）"
}

// ErrNotUser：只接受用户本人在界面上的操作，这次请求来自 Agent、脚本或别的接口调用。
var ErrNotUser = errors.New("only the user can do this")

// NotUserError 是 RequireUser 的错误，Error() 直接给人看。
type NotUserError struct {
	What  string
	Actor RequestActor
}

func (e *NotUserError) Error() string {
	return fmt.Sprintf("%s只能由用户本人在界面上操作，不接受 Agent、脚本或接口代为提交（这次的来源：%s）", e.What, e.Actor.Label())
}

func (e *NotUserError) Unwrap() error { return ErrNotUser }

// RequireUser 在这次请求不是用户本人在界面上的操作时返回 *NotUserError。what 是要做的事，如「实盘评审」。
func RequireUser(ctx context.Context, what string) error {
	a := ActorOf(ctx)
	if a.IsUser() {
		return nil
	}
	return &NotUserError{What: what, Actor: a}
}
