package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 进展与领取：开发任务闭环里 Claude Code 往工作台写回的那一半。
//
// 存储复用 revisions（field='progress'），不另建表，理由见 domain.FieldProgress。
// 这样做的直接收益是不需要迁移：真实库停在 0012，这套接口换上去就能用。

const (
	progressLimitMax = 500
	// progressTextMax 按字节算。进展是「做了什么」的摘要，不是日志转储——
	// 真要贴大段输出应当登记成产物，这里拦一道防止一条进展把详情页撑爆。
	progressTextMax = 32 << 10
	// progressRefsMax 是 commits / files 各自的条数上限，理由同上。
	progressRefsMax = 100
)

// claimKindExpr 取进展行元数据里的 kind。先判 json_valid：revisions.old_value 在别的
// field 上是普通旧值，虽然这里已经按 field 过滤了，但 json_extract 碰到非 JSON 会直接报错，
// 一条坏数据就能让领取接口整体 500。
const claimKindExpr = `CASE WHEN json_valid(old_value) THEN json_extract(old_value, '$.kind') END`

func (s *Store) ListProgress(ctx context.Context, objectID string, limit int) ([]*domain.Progress, error) {
	// 先确认对象存在：不存在的对象回空列表的话，调用方会读成「还没有进展」。
	if _, err := s.GetObject(ctx, objectID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = store.DefaultProgressLimit
	}
	if limit > progressLimitMax {
		limit = progressLimitMax
	}
	// 排序和 ListRevisions 一致：created_at 是秒级，同秒的两条靠 rowid 定先后。
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, object_id, old_value, new_value, actor, source, created_at
		 FROM revisions WHERE object_id = ? AND field = ?
		 ORDER BY created_at DESC, rowid DESC LIMIT ?`,
		objectID, domain.FieldProgress, limit)
	if err != nil {
		return nil, fmt.Errorf("list progress: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*domain.Progress{}
	for rows.Next() {
		var id, oid, meta, text, actor, source, created string
		if err := rows.Scan(&id, &oid, &meta, &text, &actor, &source, &created); err != nil {
			return nil, err
		}
		out = append(out, decodeProgress(id, oid, meta, text, actor, source, created))
	}
	return out, rows.Err()
}

// decodeProgress 把一行进展修订还原成 Progress。
// 元数据解不开时当作没有元数据：正文比它的附加信息重要，不能因为一段坏 JSON 丢掉整条。
func decodeProgress(id, objectID, meta, text, actor, source, created string) *domain.Progress {
	var m domain.ProgressMeta
	if meta != "" {
		_ = json.Unmarshal([]byte(meta), &m)
	}
	if m.Kind == "" {
		m.Kind = domain.ProgressNote
	}
	p := &domain.Progress{
		ID: id, ObjectID: objectID, Kind: m.Kind, Text: text,
		Commits: nonNilStrings(m.Commits), Files: nonNilStrings(m.Files), Status: m.Status,
		Actor: actor, Source: source, CreatedAt: parseTime(created),
	}
	p.ActorName, p.SessionID = domain.SplitActor(actor)
	return p
}

func nonNilStrings(ss []string) []string {
	if ss == nil {
		return []string{}
	}
	return ss
}

// cleanRefs 去空白、去重、保序，并限制条数。
func cleanRefs(field string, in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) > progressRefsMax {
		return nil, validation(field, fmt.Sprintf("must have at most %d entries", progressRefsMax))
	}
	return out, nil
}

func normalizeProgress(in domain.ProgressInput, allowClaim bool) (domain.ProgressInput, error) {
	in.Kind = strings.TrimSpace(in.Kind)
	if in.Kind == "" {
		in.Kind = domain.ProgressNote
	}
	switch in.Kind {
	case domain.ProgressNote, domain.ProgressReview:
	case domain.ProgressClaim:
		// claim 只能经由 ClaimObject 写：它要先做占用检查。
		// 让追加接口也能写 claim 的话，「谁领了这条任务」就能被绕过检查伪造。
		if !allowClaim {
			return in, validation("kind", "claim is written by the claim endpoint only")
		}
	default:
		return in, validation("kind", "must be one of note, review")
	}
	in.Text = strings.TrimSpace(in.Text)
	if in.Text == "" && in.Kind != domain.ProgressClaim {
		return in, validation("text", "is required")
	}
	if len(in.Text) > progressTextMax || !utf8.ValidString(in.Text) {
		return in, validation("text", fmt.Sprintf("must be valid UTF-8 and at most %d bytes", progressTextMax))
	}
	var err error
	if in.Commits, err = cleanRefs("commits", in.Commits); err != nil {
		return in, err
	}
	if in.Files, err = cleanRefs("files", in.Files); err != nil {
		return in, err
	}
	in.Status = strings.TrimSpace(in.Status)
	return in, nil
}

// objectInTx 在写事务里读对象。领取的占用检查必须读事务内的快照：
// 用读连接读的话，两个会话会同时看到「没人领」然后都写进去。
func objectInTx(ctx context.Context, tx *sql.Tx, id string) (*domain.Object, error) {
	o, err := scanObject(tx.QueryRowContext(ctx, objectSelect+` WHERE o.id = ?`, id))
	if noRows(err) {
		return nil, notFound("object")
	}
	if err != nil {
		return nil, fmt.Errorf("get object: %w", err)
	}
	// 回收站里的对象对调用方来说就是不存在的，往里面记进展只会产生没人看得到的记录。
	if o.DeletedAt != nil {
		return nil, notFound("object")
	}
	return o, nil
}

// switchStatusTx 在事务里把对象切到 st，并记一条 status 修订。状态没变时什么都不做。
func switchStatusTx(ctx context.Context, tx *sql.Tx, t *domain.ObjectType, cur *domain.Object, st domain.Status, a store.Actor, now string) error {
	if st.Key == cur.Status {
		return nil
	}
	sets := []string{"status = ?"}
	args := []any{st.Key}
	ss, sa := statusTimestamps(t, cur, st, now)
	sets = append(sets, ss...)
	args = append(args, sa...)
	args = append(args, cur.ID)
	if _, err := tx.ExecContext(ctx,
		`UPDATE objects SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return fmt.Errorf("update status: %w", err)
	}
	return addRevision(ctx, tx, cur.ID, "status", cur.Status, st.Key, a, now)
}

// insertProgressTx 落一条进展并刷新对象的 updated_at。
// 不刷新的话，一条每天都有进展的任务会被「N 天未更新」算成停滞。
func insertProgressTx(ctx context.Context, tx *sql.Tx, objectID string, in domain.ProgressInput, a store.Actor, now string) (*domain.Progress, error) {
	meta, err := json.Marshal(domain.ProgressMeta{
		Kind: in.Kind, Commits: in.Commits, Files: in.Files, Status: in.Status,
	})
	if err != nil {
		return nil, fmt.Errorf("encode progress meta: %w", err)
	}
	id, err := insertRevision(ctx, tx, objectID, domain.FieldProgress, string(meta), in.Text, a, now)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE objects SET updated_at = ? WHERE id = ?`, now, objectID); err != nil {
		return nil, fmt.Errorf("touch object: %w", err)
	}
	name := a.Name
	if name == "" {
		name = store.DefaultActor.Name
	}
	source := a.Source
	if source == "" {
		source = store.DefaultActor.Source
	}
	return decodeProgress(id, objectID, string(meta), in.Text,
		domain.ComposeActor(name, a.Session), source, now), nil
}

func (s *Store) AppendProgress(ctx context.Context, objectID string, in domain.ProgressInput, a store.Actor) (*domain.Progress, error) {
	in, err := normalizeProgress(in, false)
	if err != nil {
		return nil, err
	}
	var out *domain.Progress
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := objectInTx(ctx, tx, objectID)
		if err != nil {
			return err
		}
		now := nowStr()
		if in.Status != "" {
			t, err := s.GetObjectType(ctx, cur.TypeID)
			if err != nil {
				return err
			}
			st, ok := statusOf(t, in.Status)
			if !ok {
				return badStatus(t, in.Status)
			}
			if err := switchStatusTx(ctx, tx, t, cur, st, a, now); err != nil {
				return err
			}
		}
		out, err = insertProgressTx(ctx, tx, objectID, in, a, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// defaultClaimStatus 是没指定状态时领取要切到的状态 key。
// 只认 key，不认中文标签：标签用户随时会改，key 一经创建不变。
const defaultClaimStatus = "doing"

func (s *Store) ClaimObject(ctx context.Context, objectID string, in domain.ClaimInput, a store.Actor) (*domain.ClaimResult, error) {
	in.OwnerID = strings.TrimSpace(in.OwnerID)
	if in.OwnerID == "" {
		return nil, validation("owner_id", "is required")
	}
	claimer, err := s.GetStakeholder(ctx, in.OwnerID)
	if err != nil {
		return nil, err
	}
	pin, err := normalizeProgress(domain.ProgressInput{Kind: domain.ProgressClaim, Text: in.Text}, true)
	if err != nil {
		return nil, err
	}
	if pin.Text == "" {
		pin.Text = "领取了任务"
	}

	res := &domain.ClaimResult{}
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := objectInTx(ctx, tx, objectID)
		if err != nil {
			return err
		}
		if cur.ArchivedAt != nil {
			return conflict(fmt.Sprintf("%s 已归档，不能领取", cur.Ref))
		}
		t, err := s.GetObjectType(ctx, cur.TypeID)
		if err != nil {
			return err
		}

		target := strings.TrimSpace(in.Status)
		if target == "" {
			if _, ok := statusOf(t, defaultClaimStatus); !ok {
				return validation("status", "type "+t.ID+" has no \""+defaultClaimStatus+"\" status; pass status explicitly")
			}
			target = defaultClaimStatus
		}
		st, ok := statusOf(t, target)
		if !ok {
			return badStatus(t, target)
		}
		if st.Terminal {
			return validation("status", "cannot claim into a terminal status: "+target)
		}

		if curSt, ok := statusOf(t, cur.Status); ok && curSt.Terminal && !in.Takeover {
			return conflict(fmt.Sprintf("%s 已是终态「%s」(%s)，不能领取", cur.Ref, curSt.Label, curSt.Key))
		}
		curOwner := derefPtr(cur.OwnerID)
		if curOwner != "" && curOwner != in.OwnerID && !in.Takeover {
			return conflict(fmt.Sprintf("%s 已由「%s」负责，不能领取。要接手，先和用户确认，再带 takeover=true", cur.Ref, cur.OwnerName))
		}

		// 最近一次领取是哪个会话。只有对象仍处在领取时切到的那个状态、且负责人仍是领取者时，
		// 那次领取才算「还占着」：任务被退回 todo、或被提交到验收之后，别的会话可以再领。
		if cur.Status == st.Key && curOwner == in.OwnerID {
			var lastActor string
			err := tx.QueryRowContext(ctx,
				`SELECT actor FROM revisions
				 WHERE object_id = ? AND field = ? AND `+claimKindExpr+` = ?
				 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				cur.ID, domain.FieldProgress, domain.ProgressClaim).Scan(&lastActor)
			if err != nil && !noRows(err) {
				return fmt.Errorf("read last claim: %w", err)
			}
			if err == nil {
				_, lastSession := domain.SplitActor(lastActor)
				if lastSession == a.Session {
					// 同一会话重复领取：幂等，什么都不写。
					res.Already = true
					return nil
				}
				if !in.Takeover {
					who := lastSession
					if who == "" {
						who = "（未带会话标识）"
					}
					return conflict(fmt.Sprintf("%s 已被另一个会话 %s 领取并在进行中。要接手，先和用户确认，再带 takeover=true", cur.Ref, who))
				}
			}
		}

		now := nowStr()
		if err := switchStatusTx(ctx, tx, t, cur, st, a, now); err != nil {
			return err
		}
		if curOwner != in.OwnerID {
			if _, err := tx.ExecContext(ctx, `UPDATE objects SET owner_id = ? WHERE id = ?`, in.OwnerID, cur.ID); err != nil {
				return fmt.Errorf("update owner: %w", err)
			}
			if err := addRevision(ctx, tx, cur.ID, "owner_id", curOwner, in.OwnerID, a, now); err != nil {
				return err
			}
			// 负责人换了在进展里写明（TSK-0500）：接手别人的、或 AI 领走人的任务，翻进展就看得到原来是谁
			if curOwner != "" {
				pin.Text += fmt.Sprintf("\n负责人由「%s」改为「%s」", cur.OwnerName, claimer.Name)
			} else {
				pin.Text += fmt.Sprintf("\n负责人设为「%s」", claimer.Name)
			}
		}
		pin.Status = st.Key
		res.Progress, err = insertProgressTx(ctx, tx, cur.ID, pin, a, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	if res.Object, err = s.GetObject(ctx, objectID); err != nil {
		return nil, err
	}
	return res, nil
}
