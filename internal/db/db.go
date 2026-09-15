// Package db 负责 SQLite 连接与 schema 迁移。驱动用纯 Go 的 modernc.org/sqlite，免 CGO 交叉编译。
package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB 把读写拆成两个连接池：SQLite 同一时刻只允许一个 writer，
// 写池锁死单连接可以把「database is locked」挡在应用层排队，读池并发放开。
type DB struct {
	W    *sql.DB
	R    *sql.DB
	Path string
}

// dsn 用 _pragma 参数让每条新连接自带同样的 PRAGMA，
// 否则 Exec 出去的 PRAGMA 只落在连接池里碰巧拿到的那一条上。
func dsn(path string) string {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(ON)")
	q.Add("_pragma", "synchronous(NORMAL)")
	return "file:" + path + "?" + q.Encode()
}

// Open 打开（必要时创建）数据库文件，父目录不存在会自动补齐。
func Open(path string) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve db path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	w, err := sql.Open("sqlite", dsn(abs))
	if err != nil {
		return nil, fmt.Errorf("open write conn: %w", err)
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)

	r, err := sql.Open("sqlite", dsn(abs))
	if err != nil {
		_ = w.Close()
		return nil, fmt.Errorf("open read conn: %w", err)
	}
	r.SetMaxOpenConns(4)
	r.SetMaxIdleConns(4)

	d := &DB{W: w, R: r, Path: abs}
	if err := d.Ping(context.Background()); err != nil {
		_ = d.Close()
		return nil, err
	}
	// WAL 是写进文件头的持久设置，这里显式跑一次保证老库也切过去。
	if _, err := w.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("enable wal: %w", err)
	}
	return d, nil
}

func (d *DB) Ping(ctx context.Context) error {
	if err := d.W.PingContext(ctx); err != nil {
		return fmt.Errorf("ping write conn: %w", err)
	}
	if err := d.R.PingContext(ctx); err != nil {
		return fmt.Errorf("ping read conn: %w", err)
	}
	return nil
}

func (d *DB) Close() error {
	var first error
	if err := d.R.Close(); err != nil {
		first = err
	}
	if err := d.W.Close(); err != nil && first == nil {
		first = err
	}
	return first
}
