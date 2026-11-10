// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 已过期（IM-07）：待处理的消息发出后超过 expire_days 天还没处理，后台任务把它标成已过期（expired_at），
// 不再算待处理（不进待处理视图、今日待办、红点）。稍后提醒还没到点的不过期。
// 改回待处理、处理完、忽略时清掉；改回待处理时从当时重新起算（expire_from）。调短天数马上按新天数标，调长不会把已过期的改回来。
// 设置在 im_settings（0005），GET / PATCH /api/im/settings；expire_days 为 0 时不过期。

const (
	defaultExpireDays = 7
	maxExpireDays     = 365
	settingExpireDays = "expire_days"
)

// expireEvery 是多久标一次过期；测试里调小。
var expireEvery = 10 * time.Minute

func (in *inbox) expireDays(ctx context.Context) (int, error) {
	var v string
	err := in.c.Store().QueryRow(ctx, `SELECT value FROM im_settings WHERE key = ?`, settingExpireDays).Scan(&v)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return defaultExpireDays, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return defaultExpireDays, nil
	}
	return n, nil
}

func (in *inbox) expireJob(ctx context.Context, _ plugin.Core) error {
	days, err := in.expireDays(ctx)
	if err != nil || days <= 0 {
		return err
	}
	now := in.clock().UTC()
	_, err = in.c.Store().Exec(ctx, `UPDATE im_messages SET expired_at = ?
		WHERE status = 'pending' AND expired_at IS NULL AND coalesce(expire_from, sent_at) < ? AND (snooze_until IS NULL OR snooze_until <= ?)`,
		now.Format(timeLayout), now.AddDate(0, 0, -days).Format(timeLayout), now.Format(timeLayout))
	return err
}

type imSettings struct {
	ExpireDays   int          `json:"expire_days"`
	QuickReplies []quickReply `json:"quick_replies"`
	// FDEForward 是手动转任务后发起「FDE 反馈转发」（TSK-0468，fdeforward.go），默认关
	FDEForward bool `json:"fde_forward"`
}

func (in *inbox) getSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	days, err := in.expireDays(ctx)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	qr, err := in.quickReplies(ctx)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	fde, err := in.fdeEnabled(ctx)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": imSettings{ExpireDays: days, QuickReplies: qr, FDEForward: fde}})
}

func (in *inbox) patchSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		ExpireDays   *int          `json:"expire_days"`
		QuickReplies *[]quickReply `json:"quick_replies"`
		FDEForward   *bool         `json:"fde_forward"`
	}
	if err := decode(r, &body, 64<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	// 先校验快捷回复，免得天数存了、回复报错，改一半
	var replies []quickReply
	if body.QuickReplies != nil {
		var err error
		if replies, err = cleanQuickReplies(*body.QuickReplies); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	if body.ExpireDays != nil {
		d := *body.ExpireDays
		if d < 0 || d > maxExpireDays {
			fail(w, r, in.c, apiErr(errValidation, "expire_days must be between 0 and %d", maxExpireDays))
			return
		}
		old, err := in.expireDays(ctx)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			settingExpireDays, strconv.Itoa(d), in.clock().UTC().Format(timeLayout)); err != nil {
			fail(w, r, in.c, err)
			return
		}
		if old != d {
			in.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "im_settings", TargetID: settingExpireDays,
				Summary: "消息过期天数 " + strconv.Itoa(old) + " → " + strconv.Itoa(d), Detail: map[string]any{"from": old, "to": d}}, plugin.WriteMeta{})
		}
		// 调短了马上按新天数标一次，不用等下一轮
		if err := in.expireJob(ctx, in.c); err != nil {
			in.c.Log().Warn("im expire after settings change failed", "err", err)
		}
	}
	if body.QuickReplies != nil {
		if err := in.saveQuickReplies(ctx, replies); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	if body.FDEForward != nil {
		old, err := in.fdeEnabled(ctx)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if err := in.setFDEEnabled(ctx, *body.FDEForward); err != nil {
			fail(w, r, in.c, err)
			return
		}
		if old != *body.FDEForward {
			sum := "关闭 FDE 反馈转发"
			if *body.FDEForward {
				sum = "打开 FDE 反馈转发"
			}
			in.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "im_settings", TargetID: settingFDEForward,
				Summary: sum, Detail: map[string]any{"from": old, "to": *body.FDEForward}}, plugin.WriteMeta{})
		}
	}
	in.getSettings(w, r)
}
