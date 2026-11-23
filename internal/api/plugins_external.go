// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/pluginhost"
)

// externalPluginAPIVersion 是外部插件宿主实现的插件 API 版本（docs/plugin-spec-v2.md 4.2，
// 清单 api 范围要含它宿主才肯收）。直接取宿主导出的常量，避免两边版本号漂移。
// capabilities 和 install-check 靠它判断兼容性。
const externalPluginAPIVersion = pluginhost.ExternalAPIVersion

// frontendHostCallMethods 是前端可以直接触发的 broker 能力（前端 ctx.host.call 用）：
// 只读对象、插件设置、通知。权限仍由 pluginhost 的 broker 按清单声明 + 用户授予校验。
var frontendHostCallMethods = map[string]bool{
	"host.objects.list": true,
	"host.objects.get":  true,
	"host.settings.get": true,
	"host.settings.set": true,
	"host.notify":       true,
}

// externalCallMethods 是 /call 只允许透传给插件的方法：都是宿主在插件运行中发起的 request。
// 生命周期方法（plugin.activate / plugin.deactivate / plugin.permission_changed）不在这里，
// 免得外部调用绕过启停流程。
var externalCallMethods = map[string]bool{
	"plugin.command.run":   true,
	"plugin.health":        true,
	"plugin.event.deliver": true,
}

// externalPluginRoutes 挂外部插件管理接口（P1-a，docs/plugin-community-plan.md）。
// 没有外部插件宿主时一条路由都不注册：--allow-external-plugins=false 下
// /api/plugins/external 和其他未注册路径一样回 404，现有路由表不受影响。
func (s *Server) externalPluginRoutes(m routeRegistrar) {
	if s.opt.External == nil {
		return
	}
	m.HandleFunc("GET /api/plugins/external", s.handleListExternalPlugins)
	m.HandleFunc("GET /api/plugins/external/capabilities", s.handleExternalPluginCapabilities)
	m.HandleFunc("POST /api/plugins/external/resolve", s.handleResolveExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/market", s.handleFetchExternalMarket)
	m.HandleFunc("POST /api/plugins/external/dev/reload", s.handleReloadExternalDev)
	m.HandleFunc("POST /api/plugins/external/install", s.handleInstallExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/enable", s.handleEnableExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/disable", s.handleDisableExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/uninstall", s.handleUninstallExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/call", s.handleCallExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/upgrade", s.handleUpgradeExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/rollback", s.handleRollbackExternalPlugin)
	m.HandleFunc("POST /api/plugins/external/{id}/permissions/grant", s.handleGrantExternalPermission)
	m.HandleFunc("POST /api/plugins/external/{id}/permissions/revoke", s.handleRevokeExternalPermission)
	m.HandleFunc("GET /api/plugins/external/{id}/api/{path...}", s.handleExternalPluginAPI)
	m.HandleFunc("POST /api/plugins/external/{id}/api/{path...}", s.handleExternalPluginAPI)
	m.HandleFunc("PUT /api/plugins/external/{id}/api/{path...}", s.handleExternalPluginAPI)
	m.HandleFunc("PATCH /api/plugins/external/{id}/api/{path...}", s.handleExternalPluginAPI)
	m.HandleFunc("DELETE /api/plugins/external/{id}/api/{path...}", s.handleExternalPluginAPI)
	m.HandleFunc("GET /api/plugins/external/{id}/web/{path...}", s.handleExternalPluginWeb)
	m.HandleFunc("GET /api/plugins/external/{id}/icon", s.handleExternalPluginIcon)
}

// externalPluginFail 把宿主的哨兵错误映射成契约错误：参数/权限 400，找不到 404，
// 状态、平台/API 不兼容、没在运行 409。其余错误（IO、DB 等）交给 fail 按 500 处理并进日志。
func (s *Server) externalPluginFail(w http.ResponseWriter, r *http.Request, err error) {
	s.fail(w, r, externalPluginErr(err))
}

// externalPluginErr 做哨兵到契约错误码的映射，保留宿主给的 message——它已经写成给用户看的话。
// 用 apiError 而不是 fmt.Errorf("%w: ...", domain.ErrConflict)：errors.Is 一样能判，
// 但前端看到的是宿主原文，不会多出「conflict: 」前缀。
func externalPluginErr(err error) error {
	switch {
	case errors.Is(err, pluginhost.ErrNotFound):
		return &apiError{msg: err.Error(), err: domain.ErrNotFound}
	case errors.Is(err, pluginhost.ErrValidation), errors.Is(err, pluginhost.ErrPermission):
		return &apiError{msg: err.Error(), err: domain.ErrValidation}
	case errors.Is(err, pluginhost.ErrConflict), errors.Is(err, pluginhost.ErrIncompatible),
		errors.Is(err, pluginhost.ErrNotRunning):
		return &apiError{msg: err.Error(), err: domain.ErrConflict}
	default:
		return err
	}
}

// externalSourceBody 是 resolve / install 请求体里的安装来源，字段和 pluginhost.Source 一致；
// 单独定义是为了控制 JSON 字段名（宿主类型由 A1 维护，不在协议层依赖它的 tag）。
type externalSourceBody struct {
	Type   string `json:"type"`   // dir | archive | github
	Path   string `json:"path"`   // dir / archive 的本地绝对路径
	URL    string `json:"url"`    // github 的资产直链、release 页或仓库页
	SHA256 string `json:"sha256"` // 可选，期望的包哈希
}

func (b externalSourceBody) source() pluginhost.Source {
	return pluginhost.Source{
		Type:   strings.TrimSpace(b.Type),
		Path:   strings.TrimSpace(b.Path),
		URL:    strings.TrimSpace(b.URL),
		SHA256: strings.ToLower(strings.TrimSpace(b.SHA256)),
	}
}

// validateExternalSource 只做协议层校验（必填、枚举、绝对路径、哈希格式）；
// 包本身合不合法、跟当前平台兼不兼容交给宿主 Resolve，那边才有完整的清单校验。
func validateExternalSource(b externalSourceBody) error {
	src := b.source()
	switch src.Type {
	case "dir", "archive", "dev":
		if src.Path == "" {
			return validationf("source.type 是 %q 时 source.path 必填（本地绝对路径）", src.Type)
		}
		if !filepath.IsAbs(src.Path) {
			return validationf("source.path 必须是绝对路径，收到 %q", src.Path)
		}
	case "github":
		if src.URL == "" {
			return validationf("source.type 是 \"github\" 时 source.url 必填")
		}
		if !strings.HasPrefix(src.URL, "https://") && !strings.HasPrefix(src.URL, "http://") {
			return validationf("source.url 必须是 http(s) 地址，收到 %q", src.URL)
		}
	case "":
		return validationf("source.type 必填：dir、archive 或 github")
	default:
		return validationf("source.type 只能是 dev、dir、archive 或 github，收到 %q", src.Type)
	}
	if src.SHA256 != "" {
		if len(src.SHA256) != 64 {
			return validationf("source.sha256 必须是 64 位十六进制，收到 %d 位", len(src.SHA256))
		}
		if _, err := hex.DecodeString(src.SHA256); err != nil {
			return validationf("source.sha256 必须是 64 位十六进制：%v", err)
		}
	}
	return nil
}

// handleListExternalPlugins：宿主记着的全部外部插件（已装，含启停状态）。
// 宿主没起来时 List 返回空列表；这里统一回 [] 而不是 null。
func (s *Server) handleListExternalPlugins(w http.ResponseWriter, r *http.Request) {
	respondData(w, http.StatusOK, nonNil(s.opt.External.List()))
}

// handleExternalPluginCapabilities：install-check 和前端启动时探测宿主能力。
// 没有宿主时这条路由不注册（404），调用方据此判断这个实例不支持外部插件。
func (s *Server) handleExternalPluginCapabilities(w http.ResponseWriter, r *http.Request) {
	hostVersion := s.opt.Version
	if hostVersion == "" {
		hostVersion = "dev"
	}
	respondData(w, http.StatusOK, map[string]any{
		"external_plugins": true,
		"api_version":      externalPluginAPIVersion,
		"host_version":     hostVersion,
	})
}

type resolveExternalPluginReq struct {
	Source externalSourceBody `json:"source"`
}

// handleResolveExternalPlugin：解析来源、校验包和清单、返回预览，不安装。
// 危险操作（下载、解包）都限制在宿主的临时目录里，这里不留任何状态。
func (s *Server) handleResolveExternalPlugin(w http.ResponseWriter, r *http.Request) {
	var req resolveExternalPluginReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := validateExternalSource(req.Source); err != nil {
		s.fail(w, r, err)
		return
	}
	preview, err := s.opt.External.Resolve(r.Context(), req.Source.source())
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, preview)
}

type installExternalPluginReq struct {
	Source externalSourceBody `json:"source"`
	// ConfirmPermissions 是用户在预览里确认过的权限，必须覆盖清单里所有非高风险项；
	// 高风险（process:spawn、fs:write:any、network:any 等）本批不授予，只回 warnings。
	ConfirmPermissions []string `json:"confirm_permissions"`
	// Enable 装完是否顺手启用，缺省 true（界面上安装和启用是一个动作）。
	Enable *bool `json:"enable"`
}

// handleInstallExternalPlugin：先 Resolve 拿预览校验权限确认，再安装；enable 缺省 true。
// 高风险权限不要求也不接受确认（本批不授予），在 warnings 里说明相关功能会失败。
// 安装成功但启用失败时仍回 200：插件已装上，enabled=false、warnings 里带原因，用户可重试启用。
func (s *Server) handleInstallExternalPlugin(w http.ResponseWriter, r *http.Request) {
	var req installExternalPluginReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := validateExternalSource(req.Source); err != nil {
		s.fail(w, r, err)
		return
	}
	host := s.opt.External
	preview, err := host.Resolve(r.Context(), req.Source.source())
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}

	confirmed := make(map[string]bool, len(req.ConfirmPermissions))
	for _, p := range req.ConfirmPermissions {
		confirmed[strings.TrimSpace(p)] = true
	}
	var grant, missing, warnings []string
	for _, perm := range preview.Permissions {
		if perm.Risk == "high" || perm.Risk == "separate" {
			warnings = append(warnings, fmt.Sprintf("高风险权限 %s 本批不授予，用到它的功能会失败（%s）", perm.Name, perm.Reason))
			continue
		}
		grant = append(grant, perm.Name)
		if !perm.Granted && !confirmed[perm.Name] {
			missing = append(missing, perm.Name)
		}
	}
	if len(missing) > 0 {
		s.fail(w, r, validationf("安装外部插件要确认这些权限：%s（插件 %s）",
			strings.Join(missing, "、"), preview.Manifest.ID))
		return
	}

	enable := true
	if req.Enable != nil {
		enable = *req.Enable
	}
	info, err := host.Install(r.Context(), req.Source.source(), nonNil(grant))
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	enabled := false
	if enable {
		if cur, err := host.Enable(r.Context(), info.ID); err != nil {
			warnings = append(warnings, "插件已安装，但启用失败："+err.Error())
			if got, gerr := host.Get(info.ID); gerr == nil {
				info = got
			}
		} else {
			info, enabled = cur, true
		}
	}
	s.auditConfig(r, "install", "external_plugin", info.ID, "安装外部插件 "+info.ID,
		map[string]any{"version": info.Version, "enabled": enabled, "permissions": nonNil(grant)})
	respondData(w, http.StatusOK, map[string]any{
		"plugin":   info,
		"enabled":  enabled,
		"warnings": nonNil(warnings),
	})
}

// handleEnableExternalPlugin：启用并拉起插件进程（可能跑迁移、起后台任务，重活都在宿主里）。
func (s *Server) handleEnableExternalPlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	info, err := s.opt.External.Enable(r.Context(), id)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "enable", "external_plugin", id, "启用外部插件 "+id, nil)
	respondData(w, http.StatusOK, info)
}

// handleDisableExternalPlugin：停用并结束插件进程；数据保留，再启用照旧。
func (s *Server) handleDisableExternalPlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	info, err := s.opt.External.Disable(r.Context(), id)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "disable", "external_plugin", id, "停用外部插件 "+id, nil)
	respondData(w, http.StatusOK, info)
}

type uninstallExternalPluginReq struct {
	// DeleteData 为 true 时连 <DataDir>/external-plugins/data/<id>/ 一起删，默认保留。
	DeleteData bool `json:"delete_data"`
}

// handleUninstallExternalPlugin：卸载（只能从停用状态卸）；默认保留数据。
func (s *Server) handleUninstallExternalPlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req uninstallExternalPluginReq
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	info, err := s.opt.External.Uninstall(r.Context(), id, req.DeleteData)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "uninstall", "external_plugin", id, "卸载外部插件 "+id,
		map[string]any{"data_deleted": req.DeleteData})
	respondData(w, http.StatusOK, info)
}

type callExternalPluginReq struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// handleCallExternalPlugin：把宿主→插件的 request 透传出去（结果原样回）。
// 只放行 plugin.command.run / plugin.health / plugin.event.deliver：
// 其余方法属于生命周期或宿主 broker，不该被 HTTP 层直接调。
func (s *Server) handleCallExternalPlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req callExternalPluginReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	method := strings.TrimSpace(req.Method)
	if method == "" {
		s.fail(w, r, validationf("method 必填：plugin.command.run、plugin.health 或 plugin.event.deliver"))
		return
	}
	params := req.Params
	if len(params) == 0 || strings.TrimSpace(string(params)) == "null" {
		params = nil
	}
	var result json.RawMessage
	var err error
	switch {
	case externalCallMethods[method]:
		result, err = s.opt.External.Call(r.Context(), id, method, params)
	case frontendHostCallMethods[method]:
		result, err = s.opt.External.FrontendCall(r.Context(), id, method, params)
	default:
		s.fail(w, r, validationf("不支持透传 %q：只能调 plugin.command.run、plugin.health、plugin.event.deliver，或 host.objects.*/host.settings.*/host.notify", method))
		return
	}
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	if len(result) == 0 {
		result = json.RawMessage("null")
	}
	respondData(w, http.StatusOK, result)
}

// handleExternalPluginWeb：读插件包里的前端资源（GET .../web/<相对路径>），支持嵌套路径。
// 越界（../、符号链接逃逸）和不存在的文件一律 404，和没这个插件一样，调用方不用区分。
func (s *Server) handleExternalPluginWeb(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rel := r.PathValue("path")
	data, contentType, err := s.externalWebFile(id, rel)
	if err != nil {
		if errors.Is(err, pluginhost.ErrNotFound) || errors.Is(err, pluginhost.ErrValidation) {
			s.fail(w, r, notFoundf("no such plugin file: %s/%s", id, rel))
			return
		}
		s.fail(w, r, err)
		return
	}
	cache := "public, max-age=300"
	if path.Base(rel) == "entry.js" {
		// 入口文件跟着插件版本变，前端会带 ?v=<version>，别让旧入口被缓存住。
		cache = "no-cache"
	}
	writeExternalAsset(w, data, externalAssetType(rel, contentType), cache)
}

// externalWebFile 读插件前端文件，兼容两种 URL 拼法：
//   - 前端按 Info.WebEntry 拼：路径是包内相对路径（例 web/entry.js）；
//   - 验收/手工调用常写成相对前端目录（例 entry.js），这时按清单 web_entry 所在目录补前缀再试一次。
//
// 两种都仍然走宿主的路径安全校验；只有宿主回 ErrNotFound 才做这次重试，不会掩盖其它错误。
func (s *Server) externalWebFile(id, rel string) ([]byte, string, error) {
	data, contentType, err := s.opt.External.WebFile(id, rel)
	if err == nil || !errors.Is(err, pluginhost.ErrNotFound) {
		return data, contentType, err
	}
	info, gerr := s.opt.External.Get(id)
	if gerr != nil || info.WebEntry == "" {
		return data, contentType, err
	}
	dir := path.Dir(info.WebEntry)
	if dir == "." || dir == "/" || strings.HasPrefix(rel, dir+"/") {
		return data, contentType, err
	}
	if retried, ct, rerr := s.opt.External.WebFile(id, dir+"/"+rel); rerr == nil {
		return retried, ct, nil
	}
	return data, contentType, err
}

// handleExternalPluginIcon：插件图标；没有图标或越界就 404（前端回退到默认图标）。
func (s *Server) handleExternalPluginIcon(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	data, contentType, err := s.opt.External.IconFile(id)
	if err != nil {
		if errors.Is(err, pluginhost.ErrNotFound) || errors.Is(err, pluginhost.ErrValidation) {
			s.fail(w, r, notFoundf("no icon for external plugin: %s", id))
			return
		}
		s.fail(w, r, err)
		return
	}
	writeExternalAsset(w, data, externalAssetType("", contentType), "public, max-age=3600")
}

// externalAssetType 选 Content-Type：宿主给的优先，其次按扩展名，最后按内容嗅探
// （插件可能把图标做成 svg，也可能给一个没有扩展名的资源）。
func externalAssetType(rel, fromHost string) string {
	if fromHost != "" {
		return fromHost
	}
	switch ext := strings.ToLower(path.Ext(rel)); ext {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".wasm":
		return "application/wasm"
	}
	if ct := mime.TypeByExtension(path.Ext(rel)); ct != "" {
		return ct
	}
	return ""
}

// writeExternalAsset 直接回文件字节（不套 envelope）。Content-Type 为空时按内容嗅探；
// nosniff 避免浏览器把插件资源当成别的类型执行。
func writeExternalAsset(w http.ResponseWriter, data []byte, contentType, cacheControl string) {
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", cacheControl)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

type externalGrantPermissionReq struct {
	Permission string `json:"permission"`
	Confirm    string `json:"confirm"`
}

// handleGrantExternalPermission 授予一项高风险权限（fs:write:any / network:any / process:spawn）。
// 只接受用户本人在界面上的操作；confirm 要等于插件名；trade:live 一律拒绝。
func (s *Server) handleGrantExternalPermission(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req externalGrantPermissionReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	if err := plugin.RequireUser(r.Context(), "申请 "+strings.TrimSpace(req.Permission)+" 权限"); err != nil {
		writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden", Message: err.Error()}})
		return
	}
	info, err := s.opt.External.Get(id)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	if strings.TrimSpace(req.Confirm) != strings.TrimSpace(info.Name) {
		s.fail(w, r, validationf("申请 %s 要二次确认：confirm 必须填插件名「%s」", req.Permission, info.Name))
		return
	}
	updated, err := s.opt.External.Grant(r.Context(), id, req.Permission)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "grant_permission", "external_plugin", id,
		"授予外部插件 "+id+" 的 "+req.Permission+" 权限", map[string]any{"permission": req.Permission})
	respondData(w, http.StatusOK, updated)
}

type externalRevokePermissionReq struct {
	Permission string `json:"permission"`
}

// handleRevokeExternalPermission 收回高风险权限；收回只会让权限变少，谁调都行，没授予时照样 200。
func (s *Server) handleRevokeExternalPermission(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req externalRevokePermissionReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	updated, err := s.opt.External.Revoke(r.Context(), id, req.Permission)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "revoke_permission", "external_plugin", id,
		"收回外部插件 "+id+" 的 "+req.Permission+" 权限", map[string]any{"permission": req.Permission})
	respondData(w, http.StatusOK, updated)
}

type upgradeExternalPluginReq struct {
	Source             externalSourceBody `json:"source"`
	ConfirmPermissions []string           `json:"confirm_permissions"`
}

// handleUpgradeExternalPlugin 升级到新版本包：重跑校验/权限确认/迁移，成功后按原启用状态拉起。
func (s *Server) handleUpgradeExternalPlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	var req upgradeExternalPluginReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := validateExternalSource(req.Source); err != nil {
		s.fail(w, r, err)
		return
	}
	info, err := s.opt.External.Upgrade(r.Context(), id, req.Source.source(), req.ConfirmPermissions)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "upgrade", "external_plugin", id, "升级外部插件 "+id, map[string]any{"version": info.Version})
	respondData(w, http.StatusOK, info)
}

// handleRollbackExternalPlugin 回到上一版本（代码/清单回滚，数据库迁移不回退）。
func (s *Server) handleRollbackExternalPlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	info, err := s.opt.External.Rollback(r.Context(), id)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	s.auditConfig(r, "rollback", "external_plugin", id, "回滚外部插件 "+id, map[string]any{"version": info.Version})
	respondData(w, http.StatusOK, info)
}

type externalMarketReq struct {
	URL string `json:"url"`
}

// handleFetchExternalMarket 拉取并校验一个市场索引 URL（索引是第三方内容，安装仍走真实包校验）。
func (s *Server) handleFetchExternalMarket(w http.ResponseWriter, r *http.Request) {
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	var req externalMarketReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	view, err := s.opt.External.FetchMarketIndex(r.Context(), req.URL)
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, view)
}

// handleExternalPluginAPI 把 /api/plugins/external/<id>/api/<path> 转给插件的
// plugin.http.request；带 WebSocket Upgrade 的 GET 走 plugin.http.upgrade。
func (s *Server) handleExternalPluginAPI(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	if r.Method == http.MethodGet && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		if err := s.opt.External.ProxyWebSocket(r.Context(), id, w, r); err != nil && !errors.Is(err, context.Canceled) {
			s.externalPluginFail(w, r, err)
		}
		return
	}
	if err := s.opt.External.ProxyHTTP(r.Context(), id, r, w); err != nil {
		s.externalPluginFail(w, r, err)
	}
}

// handleReloadExternalDev 重新扫描 --plugin-dev-dir（开发目录链接安装），返回当前 dev 插件。
func (s *Server) handleReloadExternalDev(w http.ResponseWriter, r *http.Request) {
	if s.opt.External == nil {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		return
	}
	infos, err := s.opt.External.ReloadDev(r.Context())
	if err != nil {
		s.externalPluginFail(w, r, err)
		return
	}
	if infos == nil {
		infos = []pluginhost.Info{}
	}
	respondData(w, http.StatusOK, infos)
}
