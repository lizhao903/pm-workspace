package video

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 平台账号（VID-05a）：表 video_accounts，接口 /api/video/accounts，同原型 PlatformAccount。
// 一个连接器实例一个账号，打角色（主号、A/B 小号、客户号）；没接连接器的手动登记，数据靠回填。
// 发布记录用 account_id 挂账号，经连接器投稿、拉数据时没指定 connector_id 就用账号挂的连接器。

// AccountRoles 同原型 AccountRole。
var AccountRoles = []string{"main", "ab", "client"}

// AccountCaps 同原型 ContentPlatformCap。
var AccountCaps = []string{"upload", "schedule", "metrics", "comments", "reply", "dm"}

// PlatformAccount 同原型 PlatformAccount，多时间；connector_id、followers 没有就不返回。
type PlatformAccount struct {
	ID          string   `json:"id"`
	ConnectorID string   `json:"connector_id,omitempty"`
	Platform    string   `json:"platform"`
	Handle      string   `json:"handle"`
	UID         string   `json:"uid"`
	Role        string   `json:"role"`
	Caps        []string `json:"caps"`
	Followers   *int     `json:"followers,omitempty"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

const accountCols = `id, connector_id, platform, handle, uid, role, caps, followers, created_at, updated_at`

var accountFields = []string{"connector_id", "platform", "handle", "uid", "role", "caps", "followers"}

func scanAccount(row plugin.Row) (PlatformAccount, error) {
	var a PlatformAccount
	var caps string
	var followers *int64
	if err := row.Scan(&a.ID, &a.ConnectorID, &a.Platform, &a.Handle, &a.UID, &a.Role, &caps, &followers, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return PlatformAccount{}, err
	}
	if json.Unmarshal([]byte(caps), &a.Caps) != nil || a.Caps == nil {
		a.Caps = []string{}
	}
	if followers != nil {
		n := int(*followers)
		a.Followers = &n
	}
	return a, nil
}

func (h *handler) getAccount(ctx context.Context, id string) (PlatformAccount, error) {
	a, err := scanAccount(h.c.Store().QueryRow(ctx, `SELECT `+accountCols+` FROM video_accounts WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return PlatformAccount{}, apiErr(errNotFound, "平台账号不存在")
	}
	return a, err
}

func (h *handler) listAccounts(w http.ResponseWriter, r *http.Request) {
	q, args := `SELECT `+accountCols+` FROM video_accounts`, []any{}
	if s := r.URL.Query().Get("platform"); s != "" {
		q, args = q+` WHERE platform = ?`, append(args, s)
	}
	rows, err := h.c.Store().Query(r.Context(), q+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []PlatformAccount{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handler) showAccount(w http.ResponseWriter, r *http.Request) {
	a, err := h.getAccount(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": a})
}

// applyAccount 按请求改账号；connector_id 要是这个平台的连接器实例，并且没挂在别的账号上。
func (h *handler) applyAccount(ctx context.Context, a *PlatformAccount, raw map[string]json.RawMessage) error {
	if err := enumField(raw, "platform", "platform", &a.Platform, Platforms); err != nil {
		return err
	}
	if err := enumField(raw, "role", "role", &a.Role, AccountRoles); err != nil {
		return err
	}
	_, connGiven := raw["connector_id"]
	if b, ok := raw["connector_id"]; ok && isNull(b) {
		a.ConnectorID = ""
	} else if err := strField(raw, "connector_id", "connector_id", &a.ConnectorID, 100); err != nil {
		return err
	}
	if err := strField(raw, "handle", "昵称", &a.Handle, 100); err != nil {
		return err
	}
	if err := strField(raw, "uid", "uid", &a.UID, 100); err != nil {
		return err
	}
	if _, ok := raw["caps"]; ok {
		caps, err := stringList(raw, "caps", len(AccountCaps))
		if err != nil {
			return err
		}
		out := []string{}
		for _, c := range AccountCaps {
			if slices.Contains(caps, c) {
				out = append(out, c)
			}
		}
		for _, c := range caps {
			if !slices.Contains(AccountCaps, c) {
				return apiErr(errValidation, "caps 只能是 %s", strings.Join(AccountCaps, "、"))
			}
		}
		a.Caps = out
	}
	if b, ok := raw["followers"]; ok {
		if isNull(b) {
			a.Followers = nil
		} else {
			var n int
			if err := intField(raw, "followers", "粉丝数", &n, 0, 1<<53); err != nil {
				return err
			}
			a.Followers = &n
		}
	}
	if a.Platform == "" {
		return apiErr(errValidation, "platform 必填")
	}
	if a.ConnectorID != "" && (connGiven || raw["platform"] != nil) {
		cn, err := h.c.Connectors().Get(ctx, a.ConnectorID)
		if errors.Is(err, plugin.ErrNoRows) {
			return apiErr(errValidation, "连接器 %s 不存在", a.ConnectorID)
		} else if err != nil {
			return err
		}
		if ad := h.platforms[a.Platform]; ad == nil || ad.ConnectorDef().Tool != cn.Tool {
			return apiErr(errValidation, "连接器「%s」不是%s的", cn.Name, PlatformLabels[a.Platform])
		}
		if a.Handle == "" {
			a.Handle = cn.Account
		}
		var other string
		rows, err := h.c.Store().Query(ctx, `SELECT id FROM video_accounts WHERE connector_id = ? AND id != ? LIMIT 1`, a.ConnectorID, a.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
			_ = rows.Scan(&other)
		}
		_ = rows.Close()
		if other != "" {
			return apiErr(errConflict, "连接器「%s」已经挂在别的账号上了", cn.Name)
		}
	}
	if a.Handle == "" {
		return apiErr(errValidation, "昵称必填")
	}
	return nil
}

func (h *handler) addAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, accountFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a := PlatformAccount{Role: "main", Caps: []string{}}
	if err := h.applyAccount(ctx, &a, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	a.ID = idgen.Prefixed("pa")
	now := nowStr()
	caps, _ := json.Marshal(a.Caps)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_accounts (`+accountCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.ConnectorID, a.Platform, a.Handle, a.UID, a.Role, string(caps), a.Followers, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getAccount(ctx, a.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *handler) updateAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, accountFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.getAccount(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if v, ok := raw["platform"]; ok {
		var s string
		if json.Unmarshal(v, &s) != nil || s != a.Platform {
			if n, err := h.accountUses(ctx, id); err != nil {
				fail(w, r, h.c, err)
				return
			} else if n > 0 {
				fail(w, r, h.c, apiErr(errConflict, "这个账号挂了 %d 条发布记录，不能换平台", n))
				return
			}
		}
	}
	if err := h.applyAccount(ctx, &a, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	caps, _ := json.Marshal(a.Caps)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_accounts SET connector_id = ?, platform = ?, handle = ?, uid = ?, role = ?, caps = ?, followers = ?,
		updated_at = ? WHERE id = ?`, a.ConnectorID, a.Platform, a.Handle, a.UID, a.Role, string(caps), a.Followers, nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getAccount(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *handler) accountUses(ctx context.Context, id string) (int, error) {
	var n int
	err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_publishes WHERE account_id = ?`, id).Scan(&n)
	return n, err
}

// removeAccount：挂着发布记录的 409，先把发布记录改挂别的账号或清掉 account_id。
func (h *handler) removeAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.getAccount(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n, err := h.accountUses(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	} else if n > 0 {
		fail(w, r, h.c, apiErr(errConflict, "这个账号挂了 %d 条发布记录，先改挂别的账号", n))
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_accounts WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// checkPublishAccount：挂了账号的，账号要在、和发布记录同一个平台。
func (h *handler) checkPublishAccount(ctx context.Context, p Publish) error {
	if p.AccountID == "" {
		return nil
	}
	a, err := h.getAccount(ctx, p.AccountID)
	if errors.Is(err, errNotFound) {
		return apiErr(errValidation, "平台账号 %s 不存在", p.AccountID)
	} else if err != nil {
		return err
	}
	if a.Platform != p.Platform {
		return apiErr(errValidation, "账号「%s」是%s的，这条发布是%s", a.Handle, PlatformLabels[a.Platform], PlatformLabels[p.Platform])
	}
	return nil
}

// accountConnector 是发布记录挂的账号的连接器 id，没挂或账号没接连接器回空串。
func (h *handler) accountConnector(ctx context.Context, p Publish) string {
	if p.AccountID == "" {
		return ""
	}
	a, err := h.getAccount(ctx, p.AccountID)
	if err != nil {
		return ""
	}
	return a.ConnectorID
}
