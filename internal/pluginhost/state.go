// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// stateRow 是内核库 external_plugins 表的一行（表由 internal/db/migrations/0059 建）。
type stateRow struct {
	ID            string
	Name          string
	Version       string
	Description   string
	SourceType    string
	SourceRef     string
	PackageSHA256 string
	InstallDir    string
	ManifestJSON  string
	Permissions   []string
	Granted       []string
	Enabled       bool
	InstalledAt   time.Time
	UpdatedAt     time.Time
	LastError     string

	// 上一版本（升级/回滚用）；PreviousVersion 为空表示没有可回滚版本。
	PreviousVersion      string
	PreviousInstallDir   string
	PreviousManifestJSON string
	PreviousPermissions  []string
	PreviousGranted      []string
	PreviousSHA256       string
	PreviousSourceType   string
	PreviousSourceRef    string

	// 发布者身份与验签结果（P2）。
	PublisherID       string
	PublisherVerified bool
}

const stateTable = `external_plugins`

// stateTimeLayout 定长毫秒 UTC，字符串比较即时间比较（同 internal/db 迁移风格）。
const stateTimeLayout = "2006-01-02T15:04:05.000Z"

func formatStateTime(t time.Time) string { return t.UTC().Format(stateTimeLayout) }

func parseStateTime(s string) time.Time {
	for _, layout := range []string{stateTimeLayout, time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

// noStateTable 判断错误是不是「表不存在」：A2 的 0059 迁移还没跑时，
// 宿主按「没有已安装插件」处理，而不是让整个 PMW 起不来。
func noStateTable(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}

// loadState 读一个插件的安装记录；没有记录/没有表时返回 ErrNotFound。
func (h *Host) loadState(ctx context.Context, id string) (*stateRow, error) {
	if h.opts.DB == nil {
		return nil, wrap(ErrNotFound, "插件 %s 没有安装记录（宿主未配置状态库）", id)
	}
	row := h.opts.DB.R.QueryRowContext(ctx, `
		SELECT id, name, version, description, source_type, source_ref, package_sha256,
		       install_dir, manifest, permissions, granted, enabled, installed_at, updated_at, last_error,
		       previous_version, previous_install_dir, previous_manifest, previous_permissions,
		       previous_granted, previous_package_sha256, previous_source_type, previous_source_ref,
		       publisher_id, publisher_verified
		FROM `+stateTable+` WHERE id = ?`, id)
	r, err := scanStateRow(row)
	if errors.Is(err, sql.ErrNoRows) || noStateTable(err) {
		return nil, wrap(ErrNotFound, "插件 %s 没有安装记录", id)
	}
	if err != nil {
		return nil, fmt.Errorf("读取插件 %s 状态失败：%w", id, err)
	}
	return r, nil
}

// listState 读全部安装记录，按安装时间排序。
func (h *Host) listState(ctx context.Context) ([]*stateRow, error) {
	if h.opts.DB == nil {
		return nil, nil
	}
	rows, err := h.opts.DB.R.QueryContext(ctx, `
		SELECT id, name, version, description, source_type, source_ref, package_sha256,
		       install_dir, manifest, permissions, granted, enabled, installed_at, updated_at, last_error,
		       previous_version, previous_install_dir, previous_manifest, previous_permissions,
		       previous_granted, previous_package_sha256, previous_source_type, previous_source_ref,
		       publisher_id, publisher_verified
		FROM `+stateTable+` ORDER BY installed_at, id`)
	if noStateTable(err) {
		h.log.Debug("external_plugins 表还不存在，按空列表处理")
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("列出插件状态失败：%w", err)
	}
	defer rows.Close()
	var out []*stateRow
	for rows.Next() {
		r, err := scanStateRow(rows)
		if err != nil {
			return nil, fmt.Errorf("扫描插件状态失败：%w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanStateRow(s rowScanner) (*stateRow, error) {
	var (
		r                              stateRow
		permsJSON, grantedJSON         string
		prevPermsJSON, prevGrantedJSON string
		enabled                        int
		installedAt, updated           string
		publisherVerified              int
	)
	err := s.Scan(
		&r.ID, &r.Name, &r.Version, &r.Description, &r.SourceType, &r.SourceRef,
		&r.PackageSHA256, &r.InstallDir, &r.ManifestJSON, &permsJSON, &grantedJSON,
		&enabled, &installedAt, &updated, &r.LastError,
		&r.PreviousVersion, &r.PreviousInstallDir, &r.PreviousManifestJSON,
		&prevPermsJSON, &prevGrantedJSON, &r.PreviousSHA256, &r.PreviousSourceType, &r.PreviousSourceRef,
		&r.PublisherID, &publisherVerified,
	)
	if err != nil {
		return nil, err
	}
	r.Enabled = enabled != 0
	r.PublisherVerified = publisherVerified != 0
	r.InstalledAt = parseStateTime(installedAt)
	r.UpdatedAt = parseStateTime(updated)
	if err := json.Unmarshal([]byte(permsJSON), &r.Permissions); err != nil {
		return nil, fmt.Errorf("解析 permissions 失败：%w", err)
	}
	if err := json.Unmarshal([]byte(grantedJSON), &r.Granted); err != nil {
		return nil, fmt.Errorf("解析 granted 失败：%w", err)
	}
	if r.Permissions == nil {
		r.Permissions = []string{}
	}
	if r.Granted == nil {
		r.Granted = []string{}
	}
	if prevPermsJSON != "" {
		if err := json.Unmarshal([]byte(prevPermsJSON), &r.PreviousPermissions); err != nil {
			return nil, fmt.Errorf("解析 previous_permissions 失败：%w", err)
		}
	}
	if prevGrantedJSON != "" {
		if err := json.Unmarshal([]byte(prevGrantedJSON), &r.PreviousGranted); err != nil {
			return nil, fmt.Errorf("解析 previous_granted 失败：%w", err)
		}
	}
	return &r, nil
}

// saveState 写入（或整行覆盖）一条安装记录。
func (h *Host) saveState(ctx context.Context, r *stateRow) error {
	if h.opts.DB == nil {
		return wrap(ErrValidation, "宿主未配置状态库，无法保存插件状态")
	}
	perms, err := json.Marshal(r.Permissions)
	if err != nil {
		return err
	}
	granted, err := json.Marshal(r.Granted)
	if err != nil {
		return err
	}
	prevPerms, err := json.Marshal(nonNilStrings(r.PreviousPermissions))
	if err != nil {
		return err
	}
	prevGranted, err := json.Marshal(nonNilStrings(r.PreviousGranted))
	if err != nil {
		return err
	}
	enabled := 0
	if r.Enabled {
		enabled = 1
	}
	_, err = h.opts.DB.W.ExecContext(ctx, `
		INSERT INTO `+stateTable+` (id, name, version, description, source_type, source_ref,
			package_sha256, install_dir, manifest, permissions, granted, enabled,
			installed_at, updated_at, last_error,
			previous_version, previous_install_dir, previous_manifest, previous_permissions,
			previous_granted, previous_package_sha256, previous_source_type, previous_source_ref,
			publisher_id, publisher_verified)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name, version = excluded.version, description = excluded.description,
			source_type = excluded.source_type, source_ref = excluded.source_ref,
			package_sha256 = excluded.package_sha256, install_dir = excluded.install_dir,
			manifest = excluded.manifest, permissions = excluded.permissions,
			granted = excluded.granted, enabled = excluded.enabled,
			installed_at = excluded.installed_at, updated_at = excluded.updated_at,
			last_error = excluded.last_error,
			previous_version = excluded.previous_version, previous_install_dir = excluded.previous_install_dir,
			previous_manifest = excluded.previous_manifest, previous_permissions = excluded.previous_permissions,
			previous_granted = excluded.previous_granted, previous_package_sha256 = excluded.previous_package_sha256,
			previous_source_type = excluded.previous_source_type, previous_source_ref = excluded.previous_source_ref,
			publisher_id = excluded.publisher_id, publisher_verified = excluded.publisher_verified`,
		r.ID, r.Name, r.Version, r.Description, r.SourceType, r.SourceRef,
		r.PackageSHA256, r.InstallDir, r.ManifestJSON, string(perms), string(granted),
		enabled, formatStateTime(r.InstalledAt), formatStateTime(r.UpdatedAt), r.LastError,
		r.PreviousVersion, r.PreviousInstallDir, r.PreviousManifestJSON, string(prevPerms),
		string(prevGranted), r.PreviousSHA256, r.PreviousSourceType, r.PreviousSourceRef,
		r.PublisherID, publisherVerifiedInt(r.PublisherVerified))
	if err != nil {
		return fmt.Errorf("保存插件 %s 状态失败：%w", r.ID, err)
	}
	return nil
}

// setEnabled 只改 enabled/updated_at 两列。
func (h *Host) setEnabled(ctx context.Context, id string, enabled bool) error {
	if h.opts.DB == nil {
		return nil
	}
	v := 0
	if enabled {
		v = 1
	}
	_, err := h.opts.DB.W.ExecContext(ctx,
		`UPDATE `+stateTable+` SET enabled = ?, updated_at = ?, last_error = '' WHERE id = ?`,
		v, formatStateTime(time.Now()), id)
	if err != nil && !noStateTable(err) {
		return fmt.Errorf("更新插件 %s 启用状态失败：%w", id, err)
	}
	return nil
}

// setGranted 只改 granted/updated_at 两列（高风险权限的单独授予/收回）。
func (h *Host) setGranted(ctx context.Context, id string, granted []string) error {
	if h.opts.DB == nil {
		return wrap(ErrValidation, "宿主未配置状态库，无法保存权限")
	}
	data, err := json.Marshal(granted)
	if err != nil {
		return err
	}
	_, err = h.opts.DB.W.ExecContext(ctx,
		`UPDATE `+stateTable+` SET granted = ?, updated_at = ? WHERE id = ?`,
		string(data), formatStateTime(time.Now()), id)
	if err != nil && !noStateTable(err) {
		return fmt.Errorf("更新插件 %s 权限失败：%w", id, err)
	}
	return nil
}

// setLastError 记录最近一次失败原因（成功启动/停用后清空）。
func (h *Host) setLastError(ctx context.Context, id, msg string) error {
	if h.opts.DB == nil {
		return nil
	}
	_, err := h.opts.DB.W.ExecContext(ctx,
		`UPDATE `+stateTable+` SET last_error = ?, updated_at = ? WHERE id = ?`,
		msg, formatStateTime(time.Now()), id)
	if err != nil && !noStateTable(err) {
		return fmt.Errorf("更新插件 %s 错误状态失败：%w", id, err)
	}
	return nil
}

// deleteState 删除安装记录。
func (h *Host) deleteState(ctx context.Context, id string) error {
	if h.opts.DB == nil {
		return nil
	}
	_, err := h.opts.DB.W.ExecContext(ctx, `DELETE FROM `+stateTable+` WHERE id = ?`, id)
	if err != nil && !noStateTable(err) {
		return fmt.Errorf("删除插件 %s 状态失败：%w", id, err)
	}
	return nil
}

// decodeManifest 解析库里存的清单原文。
func decodeManifest(raw string) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("解析已存清单失败：%w", err)
	}
	return &m, nil
}

// infoFromRow 把状态行组装成对外的 Info。
func (h *Host) infoFromRow(r *stateRow) Info {
	info := Info{
		ID:              r.ID,
		Name:            r.Name,
		Description:     r.Description,
		Version:         r.Version,
		Enabled:         r.Enabled,
		InstalledAt:     r.InstalledAt,
		Source:          sourceFromRow(r),
		PackageSHA256:   r.PackageSHA256,
		Permissions:     append([]string{}, r.Permissions...),
		Granted:         append([]string{}, r.Granted...),
		Provides:        map[string][]string{},
		Error:           r.LastError,
		InstallDir:      r.InstallDir,
		DataDir:         h.dataDir(r.ID),
		PreviousVersion: r.PreviousVersion,
		Tier:            tierOf(r.PublisherVerified),
		PublisherID:     r.PublisherID,
	}
	info.Running = h.isRunning(r.ID)
	if m, err := decodeManifest(r.ManifestJSON); err == nil {
		info.API = m.API
		info.PMW = m.PMW
		info.License = m.License
		info.Repository = m.Repository
		info.Icon = m.Icon
		info.Provides = providesMap(m.Provides)
		if m.Runtime.Web != nil {
			info.WebEntry = m.Runtime.Web.Entry
			info.WebStyles = append([]string{}, m.Runtime.Web.Styles...)
		}
	}
	return info
}

// sourceFromRow 从状态行还原安装来源：github 用 URL，其余用本地路径。
func sourceFromRow(r *stateRow) Source {
	src := Source{Type: r.SourceType, SHA256: r.PackageSHA256}
	if r.SourceType == "github" {
		src.URL = r.SourceRef
	} else {
		src.Path = r.SourceRef
	}
	return src
}

// providesMap 把 Manifest.Provides 转成外部可读的 map，空分组不出现。
func providesMap(p Provides) map[string][]string {
	out := map[string][]string{}
	add := func(k string, v []string) {
		if len(v) > 0 {
			out[k] = append([]string{}, v...)
		}
	}
	add("modules", p.Modules)
	add("settings", p.Settings)
	add("object_types", p.ObjectTypes)
	add("connectors", p.Connectors)
	add("skills", p.Skills)
	add("agent_tools", p.AgentTools)
	add("sop_nodes", p.SOPNodes)
	add("today_cards", p.TodayCards)
	add("commands", p.Commands)
	add("search", p.Search)
	add("schedule_actions", p.ScheduleActions)
	return out
}

func nonNilStrings(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func publisherVerifiedInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func tierOf(verified bool) string {
	if verified {
		return "verified"
	}
	return "community"
}
