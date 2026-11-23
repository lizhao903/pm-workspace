// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 开发者模式（--plugin-dev-dir，P1-b/P4）：
//   - 目录下的每个子目录 = 一个插件源码目录（含 plugin.json、bin/、web/）；
//   - 安装是「链接」：不复制到 packages/，卸载不删源码目录；每次启动/Reload 重新读清单与产物；
//   - 开发目录插件标记 source_type=dev，UI 显示「本地开发」；仍需用户确认权限。

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
)

// ReloadDev 重新扫描开发目录：新目录安装、已装的更新清单/版本、消失的移除状态（保留数据）。
func (h *Host) ReloadDev(ctx context.Context) ([]Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	return h.reloadDevLocked(ctx)
}

func (h *Host) reloadDevLocked(ctx context.Context) ([]Info, error) {
	if h.opts.DevDir == "" {
		return nil, wrap(ErrValidation, "没有配置 --plugin-dev-dir")
	}
	entries, err := os.ReadDir(h.opts.DevDir)
	if err != nil {
		return nil, wrap(ErrNotFound, "读取开发目录失败：%v", err)
	}
	seen := map[string]bool{}
	var out []Info
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(h.opts.DevDir, e.Name())
		if _, err := os.Stat(filepath.Join(dir, "plugin.json")); err != nil {
			continue
		}
		pkg, err := h.resolvePackage(ctx, Source{Type: "dev", Path: dir})
		if err != nil {
			h.log.Warn("开发目录插件解析失败", "dir", dir, "err", err)
			continue
		}
		preview, err := h.preview(ctx, pkg)
		if err != nil || !preview.Compatible {
			h.log.Warn("开发目录插件清单不合法或不兼容", "dir", dir, "err", err)
			continue
		}
		granted, gerr := confirmPermissions(pkg.manifest, pkg.manifest.Permissions)
		if gerr != nil {
			// 开发目录插件没有安装确认 UI：普通权限默认授予（开发者本机源码），高风险仍留待单独授权。
			granted = nil
			for _, p := range pkg.manifest.Permissions {
				if grantableOnInstall(p) {
					granted = append(granted, p)
				}
			}
		}
		seen[pkg.manifest.ID] = true
		info, err := h.installDevLocked(ctx, pkg, granted, false)
		if err != nil {
			h.log.Warn("开发目录插件安装/更新失败", "dir", dir, "err", err)
			continue
		}
		out = append(out, info)
	}
	// 开发目录里已经不存在的 dev 插件：清状态（保留数据），不删任何源码。
	rows, _ := h.listState(ctx)
	for _, r := range rows {
		if r.SourceType == "dev" && !seen[r.ID] {
			h.cancelRestart(r.ID)
			if p := h.lookupProc(r.ID); p != nil {
				p.stop(ctx, true)
			}
			_ = h.deleteState(ctx, r.ID)
			h.log.Info("开发目录里的插件已移除，清掉安装状态（数据保留）", "plugin", r.ID)
		}
	}
	return out, nil
}

// installDevLocked 链接安装/更新一个开发目录插件；调用方必须持有 lifecycle。
func (h *Host) installDevLocked(ctx context.Context, pkg *packageData, granted []string, enable bool) (Info, error) {
	m := pkg.manifest
	existing, err := h.loadState(ctx, m.ID)
	if err == nil && existing.SourceType != "dev" {
		return Info{}, wrap(ErrConflict, "插件 %s 已作为正式包安装，先卸载再用开发目录", m.ID)
	}
	if err == nil {
		if p := h.lookupProc(m.ID); p != nil {
			p.stop(ctx, true)
		}
	}
	manifestJSON, err := json.Marshal(m)
	if err != nil {
		return Info{}, err
	}
	now := nowUTC()
	row := &stateRow{
		ID:           m.ID,
		PublisherID:  publisherIDOf(m),
		Name:         m.Name,
		Version:      m.Version,
		Description:  m.Description,
		SourceType:   "dev",
		SourceRef:    pkg.root,
		InstallDir:   pkg.root,
		ManifestJSON: string(manifestJSON),
		Permissions:  append([]string{}, m.Permissions...),
		Granted:      granted,
		Enabled:      enable,
		InstalledAt:  now,
		UpdatedAt:    now,
	}
	if existing != nil {
		row.InstalledAt = existing.InstalledAt
		row.Enabled = existing.Enabled
		row.PreviousVersion = existing.PreviousVersion
		// 保留仍在新清单里、之前已授予的高风险权限。
		grouped := map[string]bool{}
		for _, p := range granted {
			grouped[p] = true
		}
		for _, p := range existing.Granted {
			if !grantableOnInstall(p) && containsString(m.Permissions, p) {
				if !grouped[p] {
					row.Granted = append(row.Granted, p)
					grouped[p] = true
				}
			}
		}
	}
	if err := h.saveState(ctx, row); err != nil {
		return Info{}, err
	}
	if row.Enabled {
		if err := h.startPlugin(ctx, row); err != nil {
			_ = h.setLastError(ctx, m.ID, "开发目录插件启动失败："+err.Error())
			return Info{}, err
		}
	}
	return h.infoFromRow(row), nil
}

// validateDevDir 只给测试/启动前检查用：目录必须存在且至少含一个插件子目录。
func validateDevDir(dir string) error {
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return wrap(ErrValidation, "开发目录不存在：%s", dir)
	}
	return nil
}
