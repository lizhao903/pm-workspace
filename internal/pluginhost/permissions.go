// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 高风险/单独授权权限的运行时授予与收回（docs/plugin-spec-v2.md 5.3/5.4）。
// 安装时只授予 normal 权限；fs:write:any / network:any / process:spawn 安装后由用户
// 本人在界面上逐项申请 + 二次确认；trade:live 在 v0.1 外部插件里一律不授予。

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// Grant 授予一项高风险权限，并同步给正在运行的插件进程（plugin.permission_changed）。
func (h *Host) Grant(ctx context.Context, id, permission string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	r, err := h.loadState(ctx, id)
	if err != nil {
		return Info{}, err
	}
	permission = trimPermission(permission)
	if permission == "" {
		return Info{}, wrap(ErrValidation, "permission 不能为空")
	}
	if permission == "trade:live" {
		return Info{}, wrap(ErrValidation, "v0.1 外部插件一律不授予 trade:live（实盘）")
	}
	if !slices.Contains(r.Permissions, permission) {
		return Info{}, wrap(ErrValidation, "插件 %s 的清单没有声明权限 %s", id, permission)
	}
	if PermissionRisk(permission) != "high" {
		return Info{}, wrap(ErrValidation, "%s 不是需要单独申请的高风险权限（安装时已授予）", permission)
	}
	if slices.Contains(r.Granted, permission) {
		return h.infoFromRow(r), nil
	}
	r.Granted = append(r.Granted, permission)
	if err := h.setGranted(ctx, id, r.Granted); err != nil {
		return Info{}, err
	}
	if p := h.lookupProc(id); p != nil {
		p.setGranted(r.Granted)
		h.notifyPermissionChanged(p, r.Granted)
	}
	h.log.Info("外部插件高风险权限已授予", "plugin", id, "permission", permission)
	return h.Get(id)
}

// Revoke 收回一项已授予的高风险权限；收回随时可以，没授予时幂等返回。
func (h *Host) Revoke(ctx context.Context, id, permission string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	r, err := h.loadState(ctx, id)
	if err != nil {
		return Info{}, err
	}
	permission = trimPermission(permission)
	if permission == "" {
		return Info{}, wrap(ErrValidation, "permission 不能为空")
	}
	idx := slices.Index(r.Granted, permission)
	if idx < 0 {
		return h.infoFromRow(r), nil
	}
	r.Granted = append(r.Granted[:idx], r.Granted[idx+1:]...)
	if err := h.setGranted(ctx, id, r.Granted); err != nil {
		return Info{}, err
	}
	if p := h.lookupProc(id); p != nil {
		p.setGranted(r.Granted)
		h.notifyPermissionChanged(p, r.Granted)
	}
	h.log.Info("外部插件权限已收回", "plugin", id, "permission", permission)
	return h.Get(id)
}

// notifyPermissionChanged 推 plugin.permission_changed（失败只记日志，不阻塞权限变更落库）。
func (h *Host) notifyPermissionChanged(p *pluginProcess, granted []string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		params, err := json.Marshal(map[string]any{"permissions": append([]string{}, granted...)})
		if err != nil {
			return
		}
		if _, err := p.call(ctx, "plugin.permission_changed", params); err != nil {
			h.log.Warn("推送权限变更通知失败", "plugin", p.id, "err", err)
		}
	}()
}

func trimPermission(p string) string { return strings.TrimSpace(p) }
