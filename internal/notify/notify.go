// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package notify 是通知（CORE-07b）：订阅事件总线，把值得提醒人的事件存成通知（0019），
// 供前端列表、标记已读；新通知同时作为 notification.created 推进事件流。
//
// 第一版只从两类内核事件生成：任务提交验收（task.review_requested）、执行结束（run.finished）。
// 消息到达、提醒触发等由插件经 Core.Notify 发（VID-06b），落到 NotifyFromPlugin。
package notify

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Created 是新通知推进事件流时的事件类型，载荷是整条 Notification。
const Created = "notification.created"

// 级别。
const (
	LevelInfo    = "info"
	LevelSuccess = "success"
	LevelError   = "error"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

// DefaultLimit 是不指定条数时的一页长度。
const DefaultLimit = 50

// Notification 是一条通知。
type Notification struct {
	ID       string         `json:"id"`
	At       time.Time      `json:"at"`
	Kind     string         `json:"kind"`
	Level    string         `json:"level"`
	Title    string         `json:"title"`
	Body     string         `json:"body"`
	ObjectID string         `json:"object_id"`
	Data     map[string]any `json:"data"`
	ReadAt   *time.Time     `json:"read_at"`
}

// Filter 是列表条件。
type Filter struct {
	Unread bool
	Limit  int
	Offset int
}

// Lookup 是生成通知时要读的东西，store.Store 满足它。
type Lookup interface {
	GetObject(ctx context.Context, id string) (*domain.Object, error)
	GetTaskRun(ctx context.Context, id string) (*domain.TaskRun, error)
}

// Center 读写 notifications 表。
type Center struct {
	db     *db.DB
	lookup Lookup
	stream *events.Stream
	log    *slog.Logger
	now    func() time.Time

	wg sync.WaitGroup
}

// New 建一个通知中心。lookup 为 nil 时通知标题里没有对象信息；stream 为 nil 时不推送。
func New(d *db.DB, lookup Lookup, stream *events.Stream, log *slog.Logger) *Center {
	if log == nil {
		log = slog.Default()
	}
	return &Center{db: d, lookup: lookup, stream: stream, log: log.With("component", "notify"), now: time.Now}
}

// Handle 是 Bus.Tap 的回调：只挑要提醒的事件，在自己的协程里生成，不拖慢发布方。
func (c *Center) Handle(ev plugin.Event) {
	switch ev.Type {
	case events.TaskReviewRequested, events.RunFinished:
	default:
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		n, err := c.fromEvent(ctx, ev)
		if err != nil {
			c.log.Warn("notification from event failed", "type", ev.Type, "err", err)
			return
		}
		if _, err := c.Create(ctx, n); err != nil {
			c.log.Error("notification create failed", "type", ev.Type, "err", err)
		}
	}()
}

// Wait 等在途的生成处理完，最多等 timeout。进程退出和测试用。
func (c *Center) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (c *Center) fromEvent(ctx context.Context, ev plugin.Event) (Notification, error) {
	var p struct {
		ID       string `json:"id"`
		RunID    string `json:"run_id"`
		ObjectID string `json:"object_id"`
		OK       bool   `json:"ok"`
	}
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return Notification{}, fmt.Errorf("payload: %w", err)
	}
	n := Notification{At: ev.At, Kind: ev.Type, Level: LevelInfo, Data: map[string]any{}}
	switch ev.Type {
	case events.TaskReviewRequested:
		n.ObjectID = p.ID
		n.Title = c.label(ctx, p.ID) + " 提交验收"
	case events.RunFinished:
		n.ObjectID = p.ObjectID
		n.Data["run_id"] = p.RunID
		status := domain.RunFailed
		if p.OK {
			status = domain.RunDone
		} else if c.lookup != nil {
			if r, err := c.lookup.GetTaskRun(ctx, p.RunID); err == nil {
				status = r.Status
			}
		}
		label := c.label(ctx, p.ObjectID)
		switch status {
		case domain.RunDone:
			n.Level, n.Title = LevelSuccess, label+" 执行完成"
		case domain.RunCanceled:
			n.Title = label + " 执行已取消"
		default:
			n.Level, n.Title = LevelError, label+" 执行失败"
		}
	}
	n.Body = c.objectTitle(ctx, n.ObjectID)
	return n, nil
}

// label 是通知标题里的对象称呼：有编号用编号，没有用「任务」。
func (c *Center) label(ctx context.Context, id string) string {
	if o := c.object(ctx, id); o != nil && o.Ref != "" {
		return o.Ref
	}
	return "任务"
}

func (c *Center) objectTitle(ctx context.Context, id string) string {
	if o := c.object(ctx, id); o != nil {
		return o.Title
	}
	return ""
}

func (c *Center) object(ctx context.Context, id string) *domain.Object {
	if c.lookup == nil || id == "" {
		return nil
	}
	o, err := c.lookup.GetObject(ctx, id)
	if err != nil {
		return nil
	}
	return o
}

// Create 落一条通知并推进事件流。ID、At、Level 为空时补默认值。
func (c *Center) Create(ctx context.Context, n Notification) (*Notification, error) {
	if n.Kind == "" || n.Title == "" {
		return nil, fmt.Errorf("%w: notification kind and title are required", domain.ErrValidation)
	}
	if n.ID == "" {
		n.ID = idgen.Prefixed("ntf")
	}
	if n.At.IsZero() {
		n.At = c.now()
	}
	n.At = n.At.UTC().Truncate(time.Millisecond)
	if n.Level == "" {
		n.Level = LevelInfo
	}
	if n.Data == nil {
		n.Data = map[string]any{}
	}
	raw, err := json.Marshal(n.Data)
	if err != nil {
		return nil, fmt.Errorf("notification data: %w", err)
	}
	_, err = c.db.W.ExecContext(context.WithoutCancel(ctx),
		`INSERT INTO notifications (id, at, kind, level, title, body, object_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.At.Format(timeLayout), n.Kind, n.Level, n.Title, n.Body, n.ObjectID, string(raw))
	if err != nil {
		return nil, fmt.Errorf("insert notification: %w", err)
	}
	if c.stream != nil {
		if payload, err := json.Marshal(n); err == nil {
			c.stream.Append(plugin.Event{Type: Created, At: n.At, Payload: payload})
		}
	}
	return &n, nil
}

// NotifyFromPlugin 实现 plugin.Notifier：插件注册表已补好 kind 前缀和 data.source，这里只落库、推送。
func (c *Center) NotifyFromPlugin(ctx context.Context, n plugin.Notification) error {
	_, err := c.Create(ctx, Notification{Kind: n.Kind, Level: n.Level, Title: n.Title, Body: n.Body, ObjectID: n.ObjectID, Data: n.Data})
	return err
}

// List 最近的在前（同一毫秒按写入倒序）；total 不含 Limit/Offset，unread 是全部未读数。
func (c *Center) List(ctx context.Context, f Filter) (items []Notification, total, unread int, err error) {
	cond := ""
	if f.Unread {
		cond = " WHERE read_at IS NULL"
	}
	if err := c.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM notifications`+cond).Scan(&total); err != nil {
		return nil, 0, 0, fmt.Errorf("count notifications: %w", err)
	}
	if err := c.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM notifications WHERE read_at IS NULL`).Scan(&unread); err != nil {
		return nil, 0, 0, fmt.Errorf("count unread: %w", err)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	rows, err := c.db.R.QueryContext(ctx,
		`SELECT id, at, kind, level, title, body, object_id, data, read_at FROM notifications`+cond+
			` ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`, limit, max(f.Offset, 0))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("list notifications: %w", err)
	}
	defer func() { _ = rows.Close() }()
	items = []Notification{}
	for rows.Next() {
		n, err := scan(rows)
		if err != nil {
			return nil, 0, 0, err
		}
		items = append(items, *n)
	}
	return items, total, unread, rows.Err()
}

// MarkRead 标一条已读，已读过的保留原时间；不存在回 ErrNotFound。
func (c *Center) MarkRead(ctx context.Context, id string) (*Notification, error) {
	if _, err := c.db.W.ExecContext(ctx,
		`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`,
		c.now().UTC().Format(timeLayout), id); err != nil {
		return nil, fmt.Errorf("mark notification read: %w", err)
	}
	row := c.db.W.QueryRowContext(ctx,
		`SELECT id, at, kind, level, title, body, object_id, data, read_at FROM notifications WHERE id = ?`, id)
	n, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: notification %s", domain.ErrNotFound, id)
	}
	return n, err
}

// MarkAllRead 把全部未读标成已读，返回标了几条。
func (c *Center) MarkAllRead(ctx context.Context) (int, error) {
	res, err := c.db.W.ExecContext(ctx,
		`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`, c.now().UTC().Format(timeLayout))
	if err != nil {
		return 0, fmt.Errorf("mark all notifications read: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (*Notification, error) {
	var (
		n        Notification
		at, data string
		readAt   sql.NullString
	)
	if err := r.Scan(&n.ID, &at, &n.Kind, &n.Level, &n.Title, &n.Body, &n.ObjectID, &data, &readAt); err != nil {
		return nil, err
	}
	n.At, _ = time.Parse(timeLayout, at)
	if readAt.Valid {
		if t, err := time.Parse(timeLayout, readAt.String); err == nil {
			n.ReadAt = &t
		}
	}
	if err := json.Unmarshal([]byte(data), &n.Data); err != nil || n.Data == nil {
		n.Data = map[string]any{}
	}
	return &n, nil
}
