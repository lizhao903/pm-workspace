// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 外部插件升级/回滚（P1-b，docs/plugin-spec-v2.md 6.5/6.6）：
//   - Upgrade：解析新版本包 → 校验 id/版本/兼容/权限 → 复制到 packages/<id>/<新版本> →
//     在插件私有库上应用新 migrations → 停旧进程 → 写状态（当前版本换新，旧版本进 previous_*）→ 按原启用状态拉起；
//     任一步失败回滚状态并尽量恢复旧进程。
//   - Rollback：交换当前/previous_*（代码与清单回滚），数据库迁移不回退（只记日志/警告）。
// P1-b 只保留上一版本；`Options.MaxVersions` 默认 2。

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Upgrade 把已安装插件升级到新版本包（同 id、版本必须大于当前）。
func (h *Host) Upgrade(ctx context.Context, id string, src Source, confirm []string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	cur, err := h.loadState(ctx, id)
	if err != nil {
		return Info{}, err
	}
	pkg, err := h.resolvePackage(ctx, src)
	if err != nil {
		return Info{}, err
	}
	defer pkg.cleanup()
	next := pkg.manifest
	if next.ID != cur.ID {
		return Info{}, wrap(ErrConflict, "包里的插件 id 是 %s，和目标插件 %s 不一致", next.ID, cur.ID)
	}
	oldV, okOld := plugin.ParseVersion(cur.Version)
	newV, okNew := plugin.ParseVersion(next.Version)
	if !okOld || !okNew {
		return Info{}, wrap(ErrValidation, "版本不是合法 SemVer：%s -> %s", cur.Version, next.Version)
	}
	if newV == oldV {
		return Info{}, wrap(ErrConflict, "插件 %s 已经是版本 %s，不需要升级", cur.ID, cur.Version)
	}
	if !plugin.Satisfies(next.Version, ">"+cur.Version) {
		return Info{}, wrap(ErrConflict, "插件 %s 不能从 %s 降级到 %s（回滚请用 rollback）", cur.ID, cur.Version, next.Version)
	}
	if err := CheckCompatibility(next, h.opts.Version); err != nil {
		return Info{}, wrap(ErrIncompatible, "新版本与当前宿主不兼容：%s", err)
	}
	confirmed := map[string]bool{}
	for _, p := range confirm {
		confirmed[p] = true
	}
	for _, perm := range next.Permissions {
		if grantableOnInstall(perm) && !confirmed[perm] && !containsString(cur.Granted, perm) {
			return Info{}, wrap(ErrValidation, "升级要确认权限 %s（用户还没确认过）", perm)
		}
	}

	installDir := h.packageDir(next.ID, next.Version)
	if _, statErr := os.Stat(installDir); statErr == nil {
		return Info{}, wrap(ErrConflict, "插件 %s 的版本 %s 安装目录已存在", next.ID, next.Version)
	}
	if err := copyPackageDir(pkg.root, installDir); err != nil {
		return Info{}, err
	}

	// 先跑迁移：失败时不影响旧版本运行。
	privDB, err := h.openPluginDB(next.ID)
	if err != nil {
		_ = safeRemoveAll(h.packagesDir, installDir)
		return Info{}, err
	}
	applyErr := applyPluginMigrations(ctx, privDB, installDir, next, h.log.With("plugin", next.ID))
	_ = privDB.Close()
	if applyErr != nil {
		_ = safeRemoveAll(h.packagesDir, installDir)
		return Info{}, applyErr
	}

	running := h.lookupProc(cur.ID) != nil
	if p := h.lookupProc(cur.ID); p != nil {
		p.stop(ctx, true)
	}
	newGranted := mergeGranted(cur, next, confirm)
	manifestJSON, err := json.Marshal(next)
	if err != nil {
		_ = safeRemoveAll(h.packagesDir, installDir)
		return Info{}, err
	}
	tier, err := h.trustPublisher(ctx, next, pkg.publisherVerified)
	if err != nil {
		_ = safeRemoveAll(h.packagesDir, installDir)
		return Info{}, err
	}
	nextRow := &stateRow{
		ID:                   cur.ID,
		PublisherID:          publisherIDOf(next),
		PublisherVerified:    tier == "verified",
		Name:                 next.Name,
		Version:              next.Version,
		Description:          next.Description,
		SourceType:           src.Type,
		SourceRef:            sourceRef(src),
		PackageSHA256:        pkg.sha256,
		InstallDir:           installDir,
		ManifestJSON:         string(manifestJSON),
		Permissions:          append([]string{}, next.Permissions...),
		Granted:              newGranted,
		Enabled:              cur.Enabled,
		InstalledAt:          cur.InstalledAt,
		UpdatedAt:            nowUTC(),
		PreviousVersion:      cur.Version,
		PreviousInstallDir:   cur.InstallDir,
		PreviousManifestJSON: cur.ManifestJSON,
		PreviousPermissions:  append([]string{}, cur.Permissions...),
		PreviousGranted:      append([]string{}, cur.Granted...),
		PreviousSHA256:       cur.PackageSHA256,
		PreviousSourceType:   cur.SourceType,
		PreviousSourceRef:    cur.SourceRef,
	}
	if err := h.saveState(ctx, nextRow); err != nil {
		_ = safeRemoveAll(h.packagesDir, installDir)
		if running {
			_ = h.startPlugin(ctx, cur)
		}
		return Info{}, err
	}
	h.pruneOldVersions(next.ID, next.Version, cur.Version)
	if cur.Enabled {
		if err := h.startPlugin(ctx, nextRow); err != nil {
			_ = h.setLastError(ctx, cur.ID, "升级后启动失败，已回滚："+err.Error())
			_ = h.saveState(ctx, cur)
			if running {
				_ = h.startPlugin(ctx, cur)
			}
			_ = safeRemoveAll(h.packagesDir, installDir)
			return Info{}, err
		}
	}
	h.log.Info("外部插件已升级", "plugin", cur.ID, "from", cur.Version, "to", next.Version)
	return h.Get(cur.ID)
}

// Rollback 回到上一个版本（交换 current/previous；数据库迁移不回退）。
func (h *Host) Rollback(ctx context.Context, id string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	cur, err := h.loadState(ctx, id)
	if err != nil {
		return Info{}, err
	}
	if cur.PreviousVersion == "" || cur.PreviousManifestJSON == "" {
		return Info{}, wrap(ErrConflict, "插件 %s 没有可回滚的上一版本", id)
	}
	prev, err := decodeManifest(cur.PreviousManifestJSON)
	if err != nil {
		return Info{}, wrap(ErrValidation, "上一版本清单损坏：%v", err)
	}
	if p := h.lookupProc(id); p != nil {
		p.stop(ctx, true)
	}
	prevRow := &stateRow{
		ID:            cur.ID,
		Name:          prev.Name,
		Version:       cur.PreviousVersion,
		Description:   prev.Description,
		SourceType:    cur.PreviousSourceType,
		SourceRef:     cur.PreviousSourceRef,
		PackageSHA256: cur.PreviousSHA256,
		InstallDir:    cur.PreviousInstallDir,
		ManifestJSON:  cur.PreviousManifestJSON,
		Permissions:   cloneStrings(cur.PreviousPermissions),
		Granted:       cloneStrings(cur.PreviousGranted),
		Enabled:       cur.Enabled,
		InstalledAt:   cur.InstalledAt,
		UpdatedAt:     nowUTC(),
		// 回滚后可再次升级：把刚才的版本记为 previous。
		PreviousVersion:      cur.Version,
		PreviousInstallDir:   cur.InstallDir,
		PreviousManifestJSON: cur.ManifestJSON,
		PreviousPermissions:  cloneStrings(cur.Permissions),
		PreviousGranted:      cloneStrings(cur.Granted),
		PreviousSHA256:       cur.PackageSHA256,
		PreviousSourceType:   cur.SourceType,
		PreviousSourceRef:    cur.SourceRef,
	}
	if err := h.saveState(ctx, prevRow); err != nil {
		return Info{}, err
	}
	if cur.Enabled {
		if err := h.startPlugin(ctx, prevRow); err != nil {
			_ = h.setLastError(ctx, id, "回滚后启动失败，已恢复原版本："+err.Error())
			_ = h.saveState(ctx, cur)
			return Info{}, err
		}
	}
	h.pruneOldVersions(id, prevRow.Version, cur.Version)
	h.log.Warn("外部插件已回滚（数据库迁移不回退）", "plugin", id, "from", cur.Version, "to", cur.PreviousVersion)
	return h.Get(id)
}

// mergeGranted 计算升级后的授权集合：普通权限要新确认过（或之前就有），高风险保留仍声明的旧授权，trade:live 永不保留。
func mergeGranted(cur *stateRow, next *Manifest, confirm []string) []string {
	confirmed := map[string]bool{}
	for _, p := range confirm {
		confirmed[p] = true
	}
	out := make([]string, 0, len(next.Permissions))
	for _, perm := range next.Permissions {
		if perm == "trade:live" {
			continue
		}
		switch PermissionRisk(perm) {
		case "normal":
			if confirmed[perm] || containsString(cur.Granted, perm) {
				out = append(out, perm)
			}
		default:
			if containsString(cur.Granted, perm) {
				out = append(out, perm)
			}
		}
	}
	return out
}

// pruneOldVersions 只保留当前版本和上一版本目录，删掉更旧的。
func (h *Host) pruneOldVersions(id, keepA, keepB string) {
	dir := filepath.Join(h.packagesDir, id)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	keep := map[string]bool{keepA: true, keepB: true}
	for _, e := range entries {
		if !e.IsDir() || keep[e.Name()] {
			continue
		}
		_ = safeRemoveAll(dir, filepath.Join(dir, e.Name()))
	}
}

func cloneStrings(v []string) []string { return append([]string{}, v...) }
