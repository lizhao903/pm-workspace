package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 收件（TASK-02b，0024）：验签、按映射建任务、过滤、去重，每次投递留一条记录。
// 流程和原型 ingest 一致：停用 -> 过滤 -> 去重 -> 标题取不到 -> 建任务。

const (
	ResultCreated = "created"
	ResultSkipped = "skipped"
	ResultFailed  = "failed"

	// MaxPayload 是单次推送请求体的上限
	MaxPayload = 256 << 10
	// SignatureHeader 带用接收密钥对请求体算的 HMAC-SHA256（十六进制，可带 sha256= 前缀）
	SignatureHeader = "X-PMW-Signature"
	// DeliveryHeader 是对方给的投递 id，可选；同一个 id 重放只建一条
	DeliveryHeader = "X-PMW-Delivery"

	maxExternalID = 200

	DefaultDeliveryLimit = 50
	MaxDeliveryLimit     = 200

	// ActorName 是建任务时记的操作者，会话是 Webhook id
	ActorName = "webhook"
)

// ErrBadSignature 是签名对不上或密钥没设置：直接拒收，不留记录。
var ErrBadSignature = errors.New("webhook signature mismatch")

// Delivery 是一次投递的记录。
type Delivery struct {
	ID         string          `json:"id"`
	HookID     string          `json:"hook_id"`
	At         time.Time       `json:"at"`
	Payload    json.RawMessage `json:"payload"`
	Result     string          `json:"result"`
	Reason     string          `json:"reason"`
	TaskID     *string         `json:"task_id"`
	ExternalID string          `json:"external_id"`
	DedupeKey  string          `json:"dedupe_key"`
	// Mapped 是映射出来的字段值，失败时也留着
	Mapped Mapping `json:"mapped"`
	// 以下读时现查：任务的编号，任务已删（含软删）为 true
	TaskRef     string `json:"task_ref"`
	TaskDeleted bool   `json:"task_deleted"`
}

// Tasks 是建任务用的，传外层包装过的 store，事件和审计照常。
type Tasks interface {
	CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error)
}

// resolver 是取密钥明文，*vault.Vault 天然满足它
type resolver interface {
	Resolve(ctx context.Context, id string) (string, error)
}

// Receive 收一次推送。token 不对回 ErrNotFound；签名不对回 ErrBadSignature，都不留记录。
// 签名对上之后不管建没建任务都记一条投递，建出来的任务在 Delivery.TaskID。
func (s *Store) Receive(ctx context.Context, token string, body []byte, signature, externalID string, tasks Tasks) (*Delivery, error) {
	wh, err := scan(s.db.R.QueryRowContext(ctx, selectCols+` WHERE w.token = ?`, token))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: webhook", domain.ErrNotFound)
	}
	if err != nil {
		return nil, err
	}
	if err := s.verify(ctx, wh, body, signature); err != nil {
		return nil, err
	}

	// 去重要先查后建，同一时刻只处理一个投递，免得两次重试同时到达都建出任务
	s.mu.Lock()
	defer s.mu.Unlock()

	d := &Delivery{ID: idgen.Prefixed("dl"), HookID: wh.ID, At: s.now().UTC().Truncate(time.Millisecond),
		Payload: body, ExternalID: cleanExternalID(externalID)}
	payload := json.RawMessage(bytes.TrimSpace(body))
	if len(payload) == 0 || payload[0] != '{' || !json.Valid(payload) {
		d.Result, d.Reason = ResultFailed, "推送内容不是 JSON 对象"
		return d, s.insertDelivery(ctx, d)
	}
	d.Mapped = MapFields(wh.Mapping, payload)
	key, dupReason := dedupeKey(wh, payload, d.ExternalID, body)
	d.DedupeKey = key

	if !wh.Enabled {
		d.Result, d.Reason = ResultSkipped, "Webhook 已停用，只记录不建任务"
		return d, s.insertDelivery(ctx, d)
	}
	if ok, reason := PassFilter(wh.Filter, payload); !ok {
		d.Result, d.Reason = ResultSkipped, reason
		return d, s.insertDelivery(ctx, d)
	}
	dup, dupRef, err := s.aliveTask(ctx, wh.ID, key)
	if err != nil {
		return nil, err
	}
	if dup != "" {
		d.Result, d.Reason, d.TaskID, d.TaskRef = ResultSkipped, dupReason, &dup, dupRef
		return d, s.insertDelivery(ctx, d)
	}
	title := cutTitle(d.Mapped.Title)
	if title == "" {
		d.Result = ResultFailed
		if wh.Mapping.Title != "" {
			d.Reason = "标题路径 " + wh.Mapping.Title + " 取不到值"
		} else {
			d.Reason = "没有配置标题映射"
		}
		return d, s.insertDelivery(ctx, d)
	}

	o := &domain.Object{
		TypeID:   "task",
		Title:    title,
		Body:     d.Mapped.Desc,
		Priority: ToPriority(d.Mapped.Priority, wh.Defaults.Priority),
		Source:   domain.TaskSourceWebhook,
		Props:    map[string]any{domain.PropSourceRef: map[string]any{"hook_id": wh.ID, "delivery_id": d.ID}},
	}
	if day := dueDay(d.Mapped.Due); day != "" {
		if t, err := time.ParseInLocation("2006-01-02", day, time.Local); err == nil {
			o.DueAt = &t
		}
	}
	assignee := strings.TrimSpace(d.Mapped.Assignee)
	if assignee == "" {
		assignee = wh.Defaults.Assignee
	}
	note := ""
	if assignee != "" {
		if id := s.stakeholder(ctx, assignee); id != "" {
			o.OwnerID = &id
		} else {
			note = "负责人「" + assignee + "」不在干系人名册里，没设负责人"
		}
	}
	out, err := tasks.CreateObject(ctx, o, store.Actor{Name: ActorName, Source: domain.TaskSourceWebhook, Session: wh.ID})
	if err != nil {
		d.Result, d.Reason = ResultFailed, "没建成任务："+err.Error()
		return d, s.insertDelivery(ctx, d)
	}
	d.Result, d.Reason, d.TaskID, d.TaskRef = ResultCreated, note, &out.ID, out.Ref
	if err := s.insertDelivery(ctx, d); err != nil {
		// 任务已经建了，记录没写进去：下次重放会再建一条，留日志好查
		s.log.Error("webhook task created but delivery not recorded", "webhook", wh.ID, "task", out.ID, "err", err)
		return nil, err
	}
	return d, nil
}

// verify 用保险箱里的密钥核对签名。密钥被单独删了（版本为 0）时一律拒收，轮换一次补上。
func (s *Store) verify(ctx context.Context, wh *Webhook, body []byte, signature string) error {
	if wh.SecretVersion == 0 {
		return fmt.Errorf("%w: webhook secret is not set; rotate it first", ErrBadSignature)
	}
	r, ok := s.sec.(resolver)
	if !ok {
		return errors.New("vault is not configured: cannot verify webhook signature")
	}
	secret, err := r.Resolve(ctx, wh.SecretID)
	if err != nil {
		return fmt.Errorf("resolve webhook secret: %w", err)
	}
	got := strings.TrimPrefix(strings.TrimSpace(signature), "sha256=")
	sig, err := hex.DecodeString(got)
	if err != nil || len(sig) != sha256.Size {
		return fmt.Errorf("%w: %s must be the hex HMAC-SHA256 of the body", ErrBadSignature, SignatureHeader)
	}
	if !hmac.Equal(sig, Sign(secret, body)) {
		return fmt.Errorf("%w: %s does not match", ErrBadSignature, SignatureHeader)
	}
	return nil
}

// Sign 是对方该带的签名：用接收密钥对请求体做 HMAC-SHA256。
func Sign(secret string, body []byte) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return m.Sum(nil)
}

func cleanExternalID(v string) string {
	v = strings.TrimSpace(v)
	if !utf8.ValidString(v) {
		return ""
	}
	if utf8.RuneCountInString(v) > maxExternalID {
		v = string([]rune(v)[:maxExternalID])
	}
	return v
}

// dedupeKey 依次取 dedupe 路径的值、投递 id、请求体哈希；reason 是重复时记的原因。
func dedupeKey(wh *Webhook, payload json.RawMessage, externalID string, body []byte) (key, reason string) {
	const dup = "已经建过任务，按重复推送忽略"
	if wh.Dedupe != "" {
		if v := AsText(GetPath(payload, wh.Dedupe)); v != "" {
			return "p:" + wh.Dedupe + "=" + v, wh.Dedupe + " = " + v + " " + dup
		}
	}
	if externalID != "" {
		return "id:" + externalID, "投递 id " + externalID + " " + dup
	}
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:]), "同样的推送内容" + dup
}

// aliveTask 找同一去重键已经建过、任务还没删的那条，回任务 id 和编号；没有回空串
func (s *Store) aliveTask(ctx context.Context, hookID, key string) (id, ref string, err error) {
	err = s.db.W.QueryRowContext(ctx, `SELECT d.task_id, o.ref FROM webhook_deliveries d
		JOIN objects o ON o.id = d.task_id AND o.deleted_at IS NULL
		WHERE d.hook_id = ? AND d.dedupe_key = ? AND d.result = ?
		ORDER BY d.at DESC LIMIT 1`, hookID, key, ResultCreated).Scan(&id, &ref)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("webhook dedupe: %w", err)
	}
	return id, ref, nil
}

// stakeholder 按 id 或名字找在岗的干系人，找不到回空串
func (s *Store) stakeholder(ctx context.Context, v string) string {
	var id string
	err := s.db.R.QueryRowContext(ctx, `SELECT id FROM stakeholders
		WHERE (id = ? OR name = ?) AND archived_at IS NULL ORDER BY id = ? DESC, sort_order LIMIT 1`, v, v, v).Scan(&id)
	if err != nil {
		return ""
	}
	return id
}

func (s *Store) insertDelivery(ctx context.Context, d *Delivery) error {
	_, err := s.db.W.ExecContext(ctx, `INSERT INTO webhook_deliveries
		(id, hook_id, at, result, reason, task_id, external_id, dedupe_key, payload, mapped)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.HookID, d.At.Format(timeLayout), d.Result, d.Reason, d.TaskID, d.ExternalID, d.DedupeKey,
		string(d.Payload), mustJSON(d.Mapped))
	if err != nil {
		return fmt.Errorf("insert webhook delivery: %w", err)
	}
	d.Payload = payloadJSON(string(d.Payload))
	return nil
}

// payloadJSON 是对外的 payload：是 JSON 就原样给，不是就当字符串给
func payloadJSON(raw string) json.RawMessage {
	if t := strings.TrimSpace(raw); t != "" && json.Valid([]byte(t)) {
		return json.RawMessage(t)
	}
	b, _ := json.Marshal(raw)
	return b
}

// ListDeliveries 是一个 Webhook 的投递记录，新的在前；result 留空不筛。Webhook 不存在回 ErrNotFound。
func (s *Store) ListDeliveries(ctx context.Context, hookID, result string, limit, offset int) ([]Delivery, int, error) {
	if _, err := s.Get(ctx, hookID); err != nil {
		return nil, 0, err
	}
	switch result {
	case "", ResultCreated, ResultSkipped, ResultFailed:
	default:
		return nil, 0, invalid("result must be created, skipped or failed, got %q", result)
	}
	where, args := `WHERE d.hook_id = ?`, []any{hookID}
	if result != "" {
		where += ` AND d.result = ?`
		args = append(args, result)
	}
	var total int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_deliveries d `+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count webhook deliveries: %w", err)
	}
	rows, err := s.db.R.QueryContext(ctx, `SELECT d.id, d.hook_id, d.at, d.result, d.reason, d.task_id, d.external_id,
		d.dedupe_key, d.payload, d.mapped, COALESCE(o.ref, ''), d.task_id IS NOT NULL AND (o.id IS NULL OR o.deleted_at IS NOT NULL)
		FROM webhook_deliveries d LEFT JOIN objects o ON o.id = d.task_id `+where+`
		ORDER BY d.at DESC, d.rowid DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, fmt.Errorf("list webhook deliveries: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Delivery{}
	for rows.Next() {
		var (
			d               Delivery
			at, payload, mj string
			taskID          sql.NullString
		)
		if err := rows.Scan(&d.ID, &d.HookID, &at, &d.Result, &d.Reason, &taskID, &d.ExternalID, &d.DedupeKey,
			&payload, &mj, &d.TaskRef, &d.TaskDeleted); err != nil {
			return nil, 0, err
		}
		d.At, _ = time.Parse(timeLayout, at)
		if taskID.Valid {
			d.TaskID = &taskID.String
		}
		d.Payload = payloadJSON(payload)
		_ = json.Unmarshal([]byte(mj), &d.Mapped)
		out = append(out, d)
	}
	return out, total, rows.Err()
}
