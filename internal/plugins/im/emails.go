package im

// 从渠道资料补联系人邮箱：联系人经 IM 身份（渠道 + 编号）认到渠道里的人，渠道资料里有邮箱（Slack 的 profile.email，
// 要 users:read.email）时补进联系人的 email。只在联系人 email 为空时填，不覆盖已有值；邮箱不同时不改，列进结果的 conflicts。
// 两个入口：
//   - 一次性补齐：POST /api/im/connectors/{id}/backfill-emails，查这个渠道的全部身份（已有邮箱的也查，好列出差异）。
//   - 顺带补：后台任务 backfill_emails 每 emailEvery 看一次，只查邮箱为空、最近 emailRecheck 里没查过的身份，
//     每个实例每轮至多 emailAutoBudget 个；新登记的身份、新消息的发送人登记成身份后，下一轮就会查到。
//     缺权限的实例 emailScopeBackoff 里不再自动查，手动补齐时重来。
// 写联系人走 ContactWriter().Merge（操作者 im#email_backfill，记审计），不直接写内核表。

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	emailEvery        = 2 * time.Minute  // 后台多久看一次有没有要补的
	emailAutoBudget   = 20               // 后台每个实例每轮最多查几个人，免得撞限流
	emailManualLimit  = 200              // 手动补齐一次最多查几个人，没查完再点一次
	emailRecheck      = 24 * time.Hour   // 查过的身份多久内不再自动查
	emailScopeBackoff = 6 * time.Hour    // 缺权限的实例多久内不再自动查
	emailSession      = "email_backfill" // 写联系人时的操作者后缀：im#email_backfill
)

// EmailLooker 是可选接口：按渠道里的用户编号查资料里的邮箱。没实现的渠道补邮箱时回 409 unsupported。
type EmailLooker interface {
	Adapter
	LookupEmails(ctx context.Context, connectorID string, ids []string) (EmailLookup, error)
}

// EmailLookup 是一次查邮箱的结果。
type EmailLookup struct {
	// Found 是查到的人：编号 -> 资料里的邮箱，没有邮箱的为空串；查不到（不在这个工作区）的不在里面
	Found map[string]string
	// MissingScope 为真表示 Token 没有读邮箱的权限，Hint 是给人看的提示
	MissingScope bool
	Hint         string
	// Pending 是被限流没查完的个数
	Pending int
}

// EmailConflict 是联系人已有邮箱、和渠道资料里的不一样的一项，不改，给人看。
type EmailConflict struct {
	StakeholderID string `json:"stakeholder_id"`
	Name          string `json:"name"`
	ExternalID    string `json:"external_id"`
	Current       string `json:"current"`
	Found         string `json:"found"`
}

// EmailFilled 是补上邮箱的一项。
type EmailFilled struct {
	StakeholderID string `json:"stakeholder_id"`
	Name          string `json:"name"`
	ExternalID    string `json:"external_id"`
	Email         string `json:"email"`
}

// EmailBackfillResult 是 POST /api/im/connectors/{id}/backfill-emails 的结果。
// Checked 是查了几个身份，Filled 补上了几个，Skipped 是没补也不算差异的（已一致、资料里没邮箱、不在这个工作区、没查完）。
type EmailBackfillResult struct {
	ConnectorID  string          `json:"connector_id"`
	Checked      int             `json:"checked"`
	Filled       int             `json:"filled"`
	Skipped      int             `json:"skipped"`
	Conflicts    []EmailConflict `json:"conflicts"`
	FilledList   []EmailFilled   `json:"filled_contacts"`
	MissingScope bool            `json:"missing_scope"`
	Hint         string          `json:"hint"`
	Pending      int             `json:"pending"`
}

// emailFiller 管补邮箱的状态：查过的身份、缺权限的实例，都只在内存里，重启后重新查一遍。
type emailFiller struct {
	in *inbox
	mu sync.Mutex // 手动补齐和后台任务不同时跑，免得同一个人查两次、写两次

	checked map[string]time.Time // 连接器 id + "/" + 身份 id -> 上次查的时间
	noScope map[string]time.Time // 连接器 id -> 发现缺权限的时间
}

func newEmailFiller(in *inbox) *emailFiller {
	return &emailFiller{in: in, checked: map[string]time.Time{}, noScope: map[string]time.Time{}}
}

func (f *emailFiller) lookerFor(tool string) EmailLooker {
	for _, a := range f.in.adapters {
		if l, ok := a.(EmailLooker); ok && a.Key() == tool {
			return l
		}
	}
	return nil
}

// handle：POST /api/im/connectors/{id}/backfill-emails。连接器不在 404；渠道不支持、暂停、断开 409；渠道出错 502。
// 缺读邮箱的权限不算失败：200，missing_scope 为真，hint 写要做什么。
func (f *emailFiller) handle(w http.ResponseWriter, r *http.Request) {
	in := f.in
	ctx := r.Context()
	id := r.PathValue("id")
	cn, err := in.c.Connectors().Get(ctx, id)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		fail(w, r, in.c, apiErr(errNotFound, "connector %s not found", id))
		return
	case err != nil:
		fail(w, r, in.c, err)
		return
	}
	l := f.lookerFor(cn.Tool)
	switch {
	case l == nil:
		fail(w, r, in.c, blocked("unsupported", "连接器「"+cn.Name+"」不支持从渠道资料补联系人邮箱"))
		return
	case cn.Status == "paused":
		fail(w, r, in.c, blocked("connector_paused", "连接器「"+cn.Name+"」已暂停"))
		return
	case cn.Status == "disconnected":
		fail(w, r, in.c, blocked("connector_disconnected", "连接器「"+cn.Name+"」已断开"))
		return
	}
	res, err := f.run(ctx, l, id, false)
	if err != nil {
		in.c.Log().Warn("im email backfill failed", "connector", id, "err", err)
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "backfill_failed", msg: "补邮箱失败：" + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

// job 是后台的顺带补：每个能查邮箱的渠道、每个在用的实例，查邮箱为空且最近没查过的身份。
func (f *emailFiller) job(ctx context.Context, _ plugin.Core) error {
	for _, a := range f.in.adapters {
		l, ok := a.(EmailLooker)
		if !ok {
			continue
		}
		list, err := instancesOf(ctx, f.in.c, a.Key())
		if err != nil {
			return err
		}
		for _, cn := range list {
			if inactive(cn) || cn.Status == "error" {
				continue
			}
			if _, err := f.run(ctx, l, cn.ID, true); err != nil {
				f.in.c.Log().Info("im auto email backfill skipped", "connector", cn.ID, "err", err)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
		}
	}
	return nil
}

// target 是一个要查的身份和它的联系人。
type emailTarget struct {
	ident   plugin.IdentityInfo
	contact plugin.ContactInfo
}

// run 补一个实例。auto 时只查邮箱为空、最近没查过的，至多 emailAutoBudget 个，缺权限的实例退避；
// 手动时查全部身份（至多 emailManualLimit 个），已有邮箱的也查，好列出差异。
func (f *emailFiller) run(ctx context.Context, l EmailLooker, connID string, auto bool) (EmailBackfillResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	res := EmailBackfillResult{ConnectorID: connID, Conflicts: []EmailConflict{}, FilledList: []EmailFilled{}}
	now := f.in.clock()
	if auto {
		if at, ok := f.noScope[connID]; ok && now.Sub(at) < emailScopeBackoff {
			return res, nil
		}
	} else {
		delete(f.noScope, connID)
	}
	idents, err := f.in.c.Identities().List(ctx, l.Channel())
	if err != nil {
		return res, err
	}
	limit := emailManualLimit
	if auto {
		limit = emailAutoBudget
	}
	var targets []emailTarget
	contacts := map[string]plugin.ContactInfo{}
	for _, idn := range idents {
		if len(targets) >= limit {
			if !auto {
				res.Pending++
			}
			continue
		}
		if auto {
			if at, ok := f.checked[connID+"/"+idn.ID]; ok && now.Sub(at) < emailRecheck {
				continue
			}
		}
		ct, ok := contacts[idn.StakeholderID]
		if !ok {
			ct, err = f.in.c.Contacts().Get(ctx, idn.StakeholderID)
			if errors.Is(err, plugin.ErrNoRows) {
				continue
			}
			if err != nil {
				return res, err
			}
			contacts[ct.ID] = ct
		}
		if auto && strings.TrimSpace(ct.Email) != "" {
			continue
		}
		targets = append(targets, emailTarget{ident: idn, contact: ct})
	}
	res.Checked = len(targets)
	if len(targets) == 0 {
		return res, nil
	}
	ids := make([]string, 0, len(targets))
	for _, t := range targets {
		ids = append(ids, t.ident.ExternalID)
	}
	got, err := l.LookupEmails(ctx, connID, ids)
	if err != nil {
		return res, err
	}
	res.Pending += got.Pending
	if got.MissingScope {
		f.noScope[connID] = now
		res.MissingScope, res.Hint = true, got.Hint
		res.Skipped = res.Checked
		return res, nil
	}
	for _, t := range targets {
		email, found := got.Found[t.ident.ExternalID]
		if found || got.Pending == 0 {
			// 限流没查到的下一轮还要查，别记成查过
			f.checked[connID+"/"+t.ident.ID] = now
		}
		email = strings.TrimSpace(email)
		if !found || email == "" {
			res.Skipped++
			continue
		}
		// 写之前再读一次：同一个联系人的上一个身份可能刚补上，或者人刚在界面里改过
		ct, err := f.in.c.Contacts().Get(ctx, t.contact.ID)
		if err != nil {
			res.Skipped++
			continue
		}
		cur := strings.TrimSpace(ct.Email)
		switch {
		case strings.EqualFold(cur, email):
			res.Skipped++
		case cur != "":
			res.Conflicts = append(res.Conflicts, EmailConflict{StakeholderID: ct.ID, Name: ct.Name,
				ExternalID: t.ident.ExternalID, Current: cur, Found: email})
		default:
			meta := plugin.WriteMeta{Session: emailSession, Detail: map[string]any{"connector_id": connID,
				"identity_id": t.ident.ID, "channel": t.ident.Channel, "auto": auto}}
			if _, err := f.in.c.ContactWriter().Merge(ctx, ct.ID, plugin.ContactPatch{Email: &email}, meta); err != nil {
				f.in.c.Log().Warn("im email backfill write failed", "stakeholder", ct.ID, "err", err)
				res.Skipped++
				continue
			}
			res.Filled++
			res.FilledList = append(res.FilledList, EmailFilled{StakeholderID: ct.ID, Name: ct.Name,
				ExternalID: t.ident.ExternalID, Email: email})
		}
	}
	if res.Filled > 0 {
		f.in.c.Log().Info("im email backfill", "connector", connID, "filled", res.Filled, "auto", auto)
	}
	return res, nil
}
