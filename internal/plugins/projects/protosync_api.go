package projects

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 原型同步的接口（AUTO-11）：概况与触发开关、同步历史、手动发起或设基线、单条、作废。

type protoSyncAPI struct {
	*stakeholders
	s *protoSyncService
}

// stateOf 是项目的原型同步概况；取不到 HEAD 不算错，写进 head_error。
func (a *protoSyncAPI) stateOf(ctx context.Context, pid string) (ProtoSyncState, error) {
	o, err := a.s.project(ctx, pid)
	if err != nil {
		return ProtoSyncState{}, err
	}
	st, err := a.s.settings(ctx, o.ID)
	if err != nil {
		return ProtoSyncState{}, err
	}
	out := ProtoSyncState{ProjectID: o.ID, Settings: st}
	if _, branch, head, herr := a.s.codeHead(ctx, o); herr != nil {
		out.HeadError = apiMessage(herr)
	} else {
		out.Branch, out.Head = branch, head
	}
	if out.Point, err = a.s.point(ctx, o.ID); err != nil {
		return ProtoSyncState{}, err
	}
	if list, err := a.s.list(ctx, o.ID, 1); err != nil {
		return ProtoSyncState{}, err
	} else if len(list) > 0 {
		out.Last = &list[0]
	}
	if act, err := a.s.activeOf(ctx, o.ID); err == nil {
		out.Active = &act
	}
	return out, nil
}

func (a *protoSyncAPI) state(w http.ResponseWriter, r *http.Request) {
	out, err := a.stateOf(r.Context(), r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

type protoSyncSettingsPatch struct {
	OnRelease *bool   `json:"on_release"`
	OnMerge   *bool   `json:"on_merge"`
	Daily     *bool   `json:"daily"`
	DailyAt   *string `json:"daily_at"`
	Branch    *string `json:"branch"`
}

// saveSettings 改触发开关：只改传了的字段，回概况。
func (a *protoSyncAPI) saveSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	o, err := a.s.project(ctx, r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var in protoSyncSettingsPatch
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	st, err := a.s.settings(ctx, o.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if in.OnRelease != nil {
		st.OnRelease = *in.OnRelease
	}
	if in.OnMerge != nil {
		st.OnMerge = *in.OnMerge
	}
	if in.Daily != nil {
		st.Daily = *in.Daily
	}
	if in.DailyAt != nil {
		st.DailyAt = strings.TrimSpace(*in.DailyAt)
	}
	if in.Branch != nil {
		st.Branch = strings.TrimSpace(*in.Branch)
	}
	if err := checkSettings(st); err != nil {
		a.fail(w, r, err)
		return
	}
	now := a.s.now().UTC().Format(time.RFC3339)
	if _, err := a.s.c.Store().Exec(ctx, `INSERT INTO projects_proto_sync_settings (project_id, on_release, on_merge, daily, daily_at, branch, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET on_release = excluded.on_release, on_merge = excluded.on_merge,
		daily = excluded.daily, daily_at = excluded.daily_at, branch = excluded.branch, updated_at = excluded.updated_at`,
		o.ID, boolInt(st.OnRelease), boolInt(st.OnMerge), boolInt(st.Daily), st.DailyAt, st.Branch, now); err != nil {
		a.fail(w, r, err)
		return
	}
	out, err := a.stateOf(ctx, o.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (a *protoSyncAPI) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	o, err := a.s.project(ctx, r.PathValue("id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	limit := 20
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			a.fail(w, r, apiErr(errValidation, "limit must be between 1 and 200"))
			return
		}
		limit = n
	}
	out, err := a.s.list(ctx, o.ID, limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// trigger 手动发起：mode 为 sync（默认）发起一次同步，回 202；baseline 只把当前 HEAD 记成同步点，回 201。
func (a *protoSyncAPI) trigger(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Mode string `json:"mode"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &in); err != nil {
			a.fail(w, r, err)
			return
		}
	}
	trig, code := trigManual, http.StatusAccepted
	switch strings.TrimSpace(in.Mode) {
	case "", "sync":
	case "baseline":
		trig, code = trigBaseline, http.StatusCreated
	default:
		a.fail(w, r, apiErr(errValidation, "mode must be sync or baseline"))
		return
	}
	ps, err := a.s.Trigger(r.Context(), r.PathValue("id"), trig, "")
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, code, map[string]any{"data": ps})
}

func (a *protoSyncAPI) show(w http.ResponseWriter, r *http.Request) {
	ps, err := a.s.get(r.Context(), r.PathValue("sync_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": ps})
}

// cancel 作废进行中或等裁决的同步：同步点不动，不终止 SOP 执行（到执行页终止），之后流程里的原型同步节点都会失败。
// 已经结束的原样回 200。
func (a *protoSyncAPI) cancel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a.s.mu.Lock()
	defer a.s.mu.Unlock()
	ps, err := a.s.get(ctx, r.PathValue("sync_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if ps.Status == psRunning || ps.Status == psReviewing {
		ps.Status, ps.Error = psCancelled, "手动作废，同步点没动"
		a.s.dropWorktree(ctx, &ps)
		a.s.finish(ctx, &ps)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": ps})
}
