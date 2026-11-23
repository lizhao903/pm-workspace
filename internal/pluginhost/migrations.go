// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 插件私有库与迁移（brief §3，docs/plugin-spec-v2.md 5.1 / 7.5）：
// 每个插件一个 SQLite 库 <data>/external-plugins/data/<id>/data.db，插件只能经
// host.store.* 访问；包内 migrations/*.sql 在启用时按文件名顺序应用，记录到
// _pmw_migrations(name, checksum, applied_at)，任一文件失败整次启用失败。

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/db"
)

const (
	migrationsTable = "_pmw_migrations"
	settingsTable   = "_pmw_settings"
)

// openPluginDB 打开（必要时创建）插件私有库，并确保内核内部表存在。
func (h *Host) openPluginDB(id string) (*db.DB, error) {
	dir := h.dataDir(id)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("创建插件数据目录失败：%w", err)
	}
	path := filepath.Join(dir, "data.db")
	d, err := db.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开插件私有库失败：%w", err)
	}
	_, err = d.W.Exec(`
		CREATE TABLE IF NOT EXISTS ` + migrationsTable + ` (
			name       TEXT PRIMARY KEY,
			checksum   TEXT NOT NULL DEFAULT '',
			applied_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS ` + settingsTable + ` (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`)
	if err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("初始化插件私有库失败：%w", err)
	}
	// 只读连接池加 query_only，作为 host.store.query 的第二道锁：即使语句校验漏了，
	// 也不能通过 R 连接写库。
	d.R.SetMaxOpenConns(1)
	if _, err := d.R.Exec(`PRAGMA query_only=ON`); err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("设置插件私有库只读模式失败：%w", err)
	}
	return d, nil
}

// applyPluginMigrations 按文件名顺序应用包内 migrations/*.sql（同一事务 per file）。
func applyPluginMigrations(ctx context.Context, d *db.DB, installDir string, m *Manifest, log *slog.Logger) error {
	if strings.TrimSpace(m.Migrations) == "" {
		return nil
	}
	dir, err := safeJoin(installDir, m.Migrations)
	if err != nil {
		return wrap(ErrValidation, "清单 migrations 路径不合法：%s", m.Migrations)
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return wrap(ErrValidation, "清单 migrations 目录不存在：%s", m.Migrations)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("读取迁移目录失败：%w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".sql") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("读取迁移 %s 失败：%w", name, err)
		}
		// 迁移允许 DDL，但不允许 ATTACH/DETACH：插件只能碰自己的库，不能借迁移挂别的库。
		if cleaned, cerr := stripSQLComments(string(body)); cerr == nil {
			tokens := sqlTokens(cleaned)
			if hasToken(tokens, "ATTACH", "DETACH") {
				return wrap(ErrValidation, "插件迁移 %s 不允许 ATTACH/DETACH", name)
			}
		} else {
			return wrap(ErrValidation, "插件迁移 %s 不是合法 SQL：%v", name, cerr)
		}
		sum := sha256Hex(body)

		var recorded string
		err = d.W.QueryRowContext(ctx,
			`SELECT checksum FROM `+migrationsTable+` WHERE name = ?`, name).Scan(&recorded)
		switch {
		case err == nil:
			if recorded != sum {
				return wrap(ErrConflict, "插件迁移 %s 应用后被修改（记录 %s，当前 %s）",
					name, shortHash(recorded), shortHash(sum))
			}
			continue
		case !errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("读取迁移记录失败：%w", err)
		}

		tx, err := d.W.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("开始迁移事务失败：%w", err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return wrap(ErrValidation, "应用插件迁移 %s 失败：%v", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO `+migrationsTable+` (name, checksum, applied_at) VALUES (?, ?, ?)`,
			name, sum, formatStateTime(nowUTC())); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("记录插件迁移 %s 失败：%w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("提交插件迁移 %s 失败：%w", name, err)
		}
		if log != nil {
			log.Info("已应用插件迁移", "migration", name)
		}
	}
	return nil
}

func shortHash(s string) string {
	if len(s) <= 12 {
		return s
	}
	return s[:12]
}
