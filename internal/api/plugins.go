package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// pluginRoutes 挂插件管理接口（CORE-04b）和插件在启动时登记的路由。插件停用时同一路径回 404，
// 和不存在的接口一模一样，前端不用区分「没装」和「停用」。
// 插件路由一样要写进 docs/api-contract.md，契约测试按 routes() 收到的模式比对。
// 插件 id 不能是 plugins，所以 /api/plugins/ 不会和插件自己的 /api/<id>/ 撞。
func (s *Server) pluginRoutes(m routeRegistrar) {
	m.HandleFunc("GET /api/plugins", s.handleListPlugins)
	m.HandleFunc("POST /api/plugins/{id}/install", s.handleInstallPlugin)
	m.HandleFunc("POST /api/plugins/{id}/enable", s.handleEnablePlugin)
	m.HandleFunc("POST /api/plugins/{id}/disable", s.handleDisablePlugin)
	m.HandleFunc("POST /api/plugins/{id}/uninstall", s.handleUninstallPlugin)

	if s.opt.Plugins == nil {
		return
	}
	notFound := func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
	}
	for _, rt := range s.opt.Plugins.Routes(notFound) {
		m.HandleFunc(rt.Pattern, rt.Handler)
	}
}

// pluginView 是插件管理接口里的一个插件。二进制里带的全部插件都列出来，没装的 installed 为 false（即可装）。
type pluginView struct {
	ID                   string            `json:"id"`
	Name                 string            `json:"name"`
	Description          string            `json:"description"`
	Version              string            `json:"version"` // 二进制里的版本
	Installed            bool              `json:"installed"`
	Enabled              bool              `json:"enabled"`
	Running              bool              `json:"running"`
	InstalledVersion     string            `json:"installed_version"` // 安装或上次升级时的版本，没装过为空
	Upgradable           bool              `json:"upgradable"`
	InstalledAt          *time.Time        `json:"installed_at"`
	Depends              map[string]string `json:"depends"`
	OptionalDepends      map[string]string `json:"optional_depends"`
	Dependents           []string          `json:"dependents"`
	Permissions          []string          `json:"permissions"`
	PermissionsConfirmed []string          `json:"permissions_confirmed"`
	PermissionsAt        *time.Time        `json:"permissions_at"`
	PendingMigrations    int               `json:"pending_migrations"`
	Jobs                 int               `json:"jobs"`
	Provides             plugin.Provides   `json:"provides"`
}

func (s *Server) pluginView(ctx context.Context, in plugin.Info) (pluginView, error) {
	m, st := in.Manifest, in.State
	v := pluginView{
		ID: m.ID, Name: m.Name, Description: m.Description, Version: m.Version,
		Installed: st.Installed, Enabled: st.Enabled, Running: in.Running,
		InstalledVersion: st.Version, Upgradable: st.Installed && st.Version != "" && st.Version != m.Version,
		InstalledAt: st.InstalledAt, Depends: orEmpty(m.Depends), OptionalDepends: orEmpty(m.OptionalDepends),
		Dependents: in.Dependents, Permissions: m.Permissions, PermissionsConfirmed: st.Permissions,
		PermissionsAt: st.PermissionsAt, Jobs: in.Jobs, Provides: m.Provides,
	}
	if v.Dependents == nil {
		v.Dependents = []string{}
	}
	if v.Permissions == nil {
		v.Permissions = []string{}
	}
	if v.PermissionsConfirmed == nil {
		v.PermissionsConfirmed = []string{}
	}
	steps, err := s.opt.Plugins.MigrationSteps(ctx, m.ID)
	if err != nil && !errors.Is(err, plugin.ErrNotFound) {
		return v, err
	}
	for _, step := range steps {
		if step.Applied == nil {
			v.PendingMigrations++
		}
	}
	return v, nil
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// handleListPlugins：二进制里带的全部插件和它们的状态，按登记顺序。没接注册表时是空列表。
func (s *Server) handleListPlugins(w http.ResponseWriter, r *http.Request) {
	out := []pluginView{}
	if s.opt.Plugins != nil {
		for _, in := range s.opt.Plugins.List() {
			v, err := s.pluginView(r.Context(), in)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			out = append(out, v)
		}
	}
	respondList(w, out, Meta{Total: len(out)})
}

// pluginOr404 取注册表里的插件；没接注册表或没有这个插件都回 404。
func (s *Server) pluginOr404(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if s.opt.Plugins == nil {
		s.fail(w, r, notFoundf("no such plugin: %s", id))
		return "", false
	}
	if _, err := s.opt.Plugins.Get(id); err != nil {
		s.pluginFail(w, r, err)
		return "", false
	}
	return id, true
}

// respondPlugin 回一个插件的最新状态；extra 不为空时和 plugin 一起放进 data。
func (s *Server) respondPlugin(w http.ResponseWriter, r *http.Request, id string, extra map[string]any) {
	in, err := s.opt.Plugins.Get(id)
	if err != nil {
		s.pluginFail(w, r, err)
		return
	}
	v, err := s.pluginView(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if extra == nil {
		respondData(w, http.StatusOK, v)
		return
	}
	extra["plugin"] = v
	respondData(w, http.StatusOK, extra)
}

type installPluginReq struct {
	// Permissions 是用户确认过的权限，必须覆盖清单里的全部权限（plugin-api.md 3.2）
	Permissions []string `json:"permissions"`
}

// handleInstallPlugin：检查依赖和权限确认；有待应用的迁移时先打快照再跑迁移（4.1）。不启用。
func (s *Server) handleInstallPlugin(w http.ResponseWriter, r *http.Request) {
	id, ok := s.pluginOr404(w, r)
	if !ok {
		return
	}
	var req installPluginReq
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	reg := s.opt.Plugins
	if err := reg.CheckInstall(id, req.Permissions); err != nil {
		s.pluginFail(w, r, err)
		return
	}
	var backup *string
	steps, err := reg.MigrationSteps(r.Context(), id)
	if err != nil && !errors.Is(err, plugin.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	for _, step := range steps {
		if step.Applied == nil {
			info, err := s.st.Snapshot(r.Context(), "")
			if err != nil {
				s.fail(w, r, err)
				return
			}
			backup = &info.Path
			break
		}
	}
	if err := reg.Install(r.Context(), id, req.Permissions); err != nil {
		s.pluginFail(w, r, err)
		return
	}
	s.respondPlugin(w, r, id, map[string]any{"backup": backup})
}

func (s *Server) handleEnablePlugin(w http.ResponseWriter, r *http.Request) {
	id, ok := s.pluginOr404(w, r)
	if !ok {
		return
	}
	if err := s.opt.Plugins.Enable(r.Context(), id); err != nil {
		s.pluginFail(w, r, err)
		return
	}
	s.respondPlugin(w, r, id, nil)
}

// handleDisablePlugin：还有已启用的插件强依赖它时 409，error.dependents 列出这些插件（4.3）。
func (s *Server) handleDisablePlugin(w http.ResponseWriter, r *http.Request) {
	id, ok := s.pluginOr404(w, r)
	if !ok {
		return
	}
	if err := s.opt.Plugins.Disable(r.Context(), id); err != nil {
		s.pluginFail(w, r, err)
		return
	}
	s.respondPlugin(w, r, id, nil)
}

type uninstallPluginReq struct {
	DeleteData bool `json:"delete_data"`
	// Confirm 是删数据的二次确认，必须等于插件 id
	Confirm string `json:"confirm"`
}

// handleUninstallPlugin：默认保留数据；delete_data 时 confirm 必须是插件 id，先快照再删（4.4）。
func (s *Server) handleUninstallPlugin(w http.ResponseWriter, r *http.Request) {
	id, ok := s.pluginOr404(w, r)
	if !ok {
		return
	}
	var req uninstallPluginReq
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.DeleteData && req.Confirm != id {
		s.fail(w, r, validationf("删除插件数据要二次确认：confirm 必须填插件 id %q", id))
		return
	}
	res, err := s.opt.Plugins.Uninstall(r.Context(), id, plugin.UninstallOptions{
		DeleteData: req.DeleteData,
		Backup: func(ctx context.Context) (string, error) {
			info, err := s.st.Snapshot(ctx, "")
			if err != nil {
				return "", err
			}
			return info.Path, nil
		},
	})
	if err != nil {
		s.pluginFail(w, r, err)
		return
	}
	var backup *string
	if res.Backup != "" {
		backup = &res.Backup
	}
	s.respondPlugin(w, r, id, map[string]any{
		"data_deleted": res.DataDeleted, "backup": backup, "dropped_tables": res.DroppedTables,
	})
}

// pluginErrBody 是插件管理接口的错误：被依赖时多一个 dependents。
type pluginErrBody struct {
	Error struct {
		Code       string   `json:"code"`
		Message    string   `json:"message"`
		Dependents []string `json:"dependents,omitempty"`
	} `json:"error"`
}

// pluginFail 把注册表的错误映射成契约错误码：没有这个插件 404，权限没确认 400，
// 状态不对、被依赖、插件拒绝停用、依赖或版本不满足 409；其余交给 fail。
func (s *Server) pluginFail(w http.ResponseWriter, r *http.Request, err error) {
	var de *plugin.DependentsError
	var ge *plugin.GuardError
	var ve *plugin.ValidationError
	status, code := 0, ""
	switch {
	case errors.Is(err, plugin.ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, plugin.ErrUnconfirmed):
		status, code = http.StatusBadRequest, "validation"
	case errors.As(err, &de), errors.As(err, &ge), errors.As(err, &ve), errors.Is(err, plugin.ErrState):
		status, code = http.StatusConflict, "conflict"
	default:
		s.fail(w, r, err)
		return
	}
	var b pluginErrBody
	b.Error.Code, b.Error.Message = code, err.Error()
	if de != nil {
		b.Error.Dependents = de.Dependents
	}
	writeJSON(w, status, b)
}
