package video

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 封面 A/B 测试（VID-05b）：表 video_cover_tests、video_cover_test_arms，接口 /api/video/cover-tests，同原型 CoverTest。
// 判定同原型 coverTestState（COVER.md Part 7）：每组曝光到线、天数到线、点击率第一领先第二到线判出胜者；
// 曝光和天数都到了、差距不够判「没有结论」；还没到的照旧进行中。快照落库后（addSnapshot）和后台任务 cover_tests 每小时重算进行中的测试。
// 判出胜者：胜者设为同组（视频 + 方向 + 封面比例）选用的主封面，其余各组的封面标归档，记录和文件都不删。

// CoverTestModes 同原型 COVER_TEST_MODE 的顺序。
var CoverTestModes = []string{"native", "accounts", "utm"}

// CoverTestStatuses 同原型 COVER_TEST_STATUS 的顺序。
var CoverTestStatuses = []string{"running", "decided", "inconclusive"}

// 默认门槛同原型：至少 7 天、每组至少 1 万曝光、点击率领先 20%。
const (
	defaultMinDays        = 7
	defaultMinImpressions = 10000
	defaultMinGap         = 0.2
)

// coverTestsEvery 是后台任务重算的间隔：天数到线不一定有新快照。
var coverTestsEvery = time.Hour

// 判定一次只跑一个：快照落库、后台任务、接口可能同时重算同一个测试。
var coverTestMu sync.Mutex

// CoverTestArm 同原型 CoverTestArm：小号分发时 publish_id 必填，曝光、点击率从发布记录读；平台原生测试、分链接时记在组上。
type CoverTestArm struct {
	CoverID     string   `json:"cover_id"`
	PublishID   string   `json:"publish_id,omitempty"`
	Impressions *int     `json:"impressions,omitempty"`
	CTR         *float64 `json:"ctr,omitempty"`
}

// CoverTestArmState 是判定时每组实际用的曝光、点击率（小号分发读发布记录最新一次数据）。
type CoverTestArmState struct {
	CoverID     string   `json:"cover_id"`
	Impressions *int     `json:"impressions,omitempty"`
	CTR         *float64 `json:"ctr,omitempty"`
}

// CoverTestState 同原型 coverTestState 的返回：天数、领先比例、到线组数、领先的封面和三条门槛。
type CoverTestState struct {
	Days           int                 `json:"days"`
	Gap            *float64            `json:"gap,omitempty"`
	Reached        int                 `json:"reached"`
	Leader         string              `json:"leader,omitempty"`
	DaysOK         bool                `json:"days_ok"`
	ImpressionsOK  bool                `json:"imp_ok"`
	GapOK          bool                `json:"gap_ok"`
	Arms           []CoverTestArmState `json:"arms"`
	DataIncomplete bool                `json:"data_incomplete,omitempty"`
}

// CoverTest 同原型 CoverTest，多 state（按当前数据算的判定过程）和时间。
type CoverTest struct {
	ID             string         `json:"id"`
	VideoID        string         `json:"video_id"`
	Platform       string         `json:"platform"`
	Mode           string         `json:"mode"`
	Arms           []CoverTestArm `json:"arms"`
	StartedAt      string         `json:"started_at"`
	EndedAt        *string        `json:"ended_at,omitempty"`
	MinDays        int            `json:"min_days"`
	MinImpressions int            `json:"min_impressions"`
	MinGap         float64        `json:"min_gap"`
	WinnerID       string         `json:"winner_id,omitempty"`
	Status         string         `json:"status"`
	State          CoverTestState `json:"state"`
	CreatedAt      string         `json:"created_at"`
	UpdatedAt      string         `json:"updated_at"`
}

const coverTestCols = `id, video_id, platform, mode, started_at, ended_at, min_days, min_impressions, min_gap, winner_id, status, created_at, updated_at`

func scanCoverTest(row plugin.Row) (CoverTest, error) {
	var t CoverTest
	err := row.Scan(&t.ID, &t.VideoID, &t.Platform, &t.Mode, &t.StartedAt, &t.EndedAt, &t.MinDays, &t.MinImpressions, &t.MinGap,
		&t.WinnerID, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// loadCoverTests 查测试并带上分组（按登记顺序）和判定过程。
func (h *handler) loadCoverTests(ctx context.Context, where string, args ...any) ([]CoverTest, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+coverTestCols+` FROM video_cover_tests `+where+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, err
	}
	out := []CoverTest{}
	for rows.Next() {
		t, err := scanCoverTest(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, t)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Arms, err = h.coverTestArms(ctx, out[i].ID); err != nil {
			return nil, err
		}
		if out[i].State, err = h.coverTestState(ctx, out[i], nowStr()); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (h *handler) coverTestArms(ctx context.Context, testID string) ([]CoverTestArm, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT cover_id, publish_id, impressions, ctr FROM video_cover_test_arms WHERE test_id = ? ORDER BY position`, testID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	arms := []CoverTestArm{}
	for rows.Next() {
		var a CoverTestArm
		var imp *int64
		if err := rows.Scan(&a.CoverID, &a.PublishID, &imp, &a.CTR); err != nil {
			return nil, err
		}
		a.Impressions = intPtr(imp)
		arms = append(arms, a)
	}
	return arms, rows.Err()
}

func (h *handler) getCoverTest(ctx context.Context, id string) (CoverTest, error) {
	xs, err := h.loadCoverTests(ctx, `WHERE id = ?`, id)
	if err != nil {
		return CoverTest{}, err
	}
	if len(xs) == 0 {
		return CoverTest{}, apiErr(errNotFound, "封面测试不存在")
	}
	return xs[0], nil
}

// coverTestState 同原型 coverTestState：天数按开始到结束（没结束按 now）算，满一天算 1，不足一天也算 1。
// 点击率第二名是 0 时没有领先比例（同原型），差距不算到线。
func (h *handler) coverTestState(ctx context.Context, t CoverTest, now string) (CoverTestState, error) {
	end := now
	if t.EndedAt != nil {
		end = *t.EndedAt
	}
	st := CoverTestState{Days: dayAfter(&t.StartedAt, end), Arms: []CoverTestArmState{}}
	for _, a := range t.Arms {
		s := CoverTestArmState{CoverID: a.CoverID, Impressions: a.Impressions, CTR: a.CTR}
		if t.Mode == "accounts" {
			s.Impressions, s.CTR = nil, nil
			p, err := h.getPublish(ctx, a.PublishID)
			if err != nil && !errors.Is(err, errNotFound) {
				return st, err
			}
			if err == nil && p.Metrics != nil {
				s.Impressions, s.CTR = p.Metrics.Impressions, p.Metrics.CTR
			}
		}
		if s.CTR == nil {
			st.DataIncomplete = true
		}
		if s.Impressions != nil && *s.Impressions >= t.MinImpressions {
			st.Reached++
		}
		st.Arms = append(st.Arms, s)
	}
	ranked := []CoverTestArmState{}
	for _, s := range st.Arms {
		if s.CTR != nil {
			ranked = append(ranked, s)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return *ranked[i].CTR > *ranked[j].CTR })
	if len(ranked) > 0 {
		st.Leader = ranked[0].CoverID
	}
	if len(ranked) >= 2 && *ranked[1].CTR > 0 {
		g := *ranked[0].CTR / *ranked[1].CTR - 1
		st.Gap = &g
	}
	st.DaysOK = st.Days >= t.MinDays
	st.ImpressionsOK = len(st.Arms) > 0 && st.Reached == len(st.Arms)
	// 浮点误差：0.06 / 0.05 - 1 算出来比 0.2 小一点点
	st.GapOK = st.Gap != nil && *st.Gap >= t.MinGap-1e-9
	return st, nil
}

// evaluateCoverTest 重算一个进行中的测试：曝光、天数都到线时，差距到线判出胜者，不到线判没有结论；
// 有组还没有点击率的照旧进行中。返回是否判出了结果。
func (h *handler) evaluateCoverTest(ctx context.Context, id string) (bool, error) {
	coverTestMu.Lock()
	defer coverTestMu.Unlock()
	t, err := h.getCoverTest(ctx, id)
	if err != nil || t.Status != "running" {
		return false, err
	}
	now := nowStr()
	st, err := h.coverTestState(ctx, t, now)
	if err != nil {
		return false, err
	}
	if !st.DaysOK || !st.ImpressionsOK || st.DataIncomplete {
		return false, nil
	}
	status, winner := "inconclusive", ""
	if st.GapOK {
		status, winner = "decided", st.Leader
		if err := h.applyCoverWinner(ctx, t, winner); err != nil {
			return false, err
		}
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_cover_tests SET status = ?, winner_id = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
		status, winner, now, now, t.ID); err != nil {
		return false, err
	}
	if err := h.touchVideo(ctx, t.VideoID); err != nil {
		return false, err
	}
	h.c.Log().Info("cover test settled", "test", t.ID, "status", status, "winner", winner)
	return true, nil
}

// applyCoverWinner 把胜者设为同组选用的主封面（同组原来选用的取消），其余各组的封面归档、取消选用；都是幂等的。
func (h *handler) applyCoverWinner(ctx context.Context, t CoverTest, winner string) error {
	if err := h.upgradeLegacy(ctx); err != nil {
		return err
	}
	st, now := h.c.Store(), nowStr()
	var variant, ratio string
	err := st.QueryRow(ctx, `SELECT variant, ratio FROM video_artifacts WHERE id = ? AND kind = 'cover'`, winner).Scan(&variant, &ratio)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		h.c.Log().Warn("cover test winner gone", "test", t.ID, "cover", winner)
	case err != nil:
		return err
	default:
		if _, err := st.Exec(ctx, `UPDATE video_artifacts SET cover_picked = 0, updated_at = ? WHERE video_id = ? AND variant = ? AND ratio = ? AND cover_picked = 1 AND id <> ?`,
			now, t.VideoID, variant, ratio, winner); err != nil {
			return err
		}
		if _, err := st.Exec(ctx, `UPDATE video_artifacts SET cover_picked = 1, cover_archived = 0, updated_at = ? WHERE id = ?`, now, winner); err != nil {
			return err
		}
	}
	for _, a := range t.Arms {
		if a.CoverID == winner {
			continue
		}
		if _, err := st.Exec(ctx, `UPDATE video_artifacts SET cover_archived = 1, cover_picked = 0, updated_at = ? WHERE id = ? AND kind = 'cover'`, now, a.CoverID); err != nil {
			return err
		}
	}
	return nil
}

// evaluateCoverTestsFor 是快照落库后的重算：这条发布挂着的进行中的测试都算一遍，出错只记日志，不影响快照。
func (h *handler) evaluateCoverTestsFor(ctx context.Context, publishID string) {
	ids, err := h.runningCoverTests(ctx, `SELECT DISTINCT t.id FROM video_cover_tests t JOIN video_cover_test_arms a ON a.test_id = t.id
		WHERE a.publish_id = ? AND t.status = 'running' ORDER BY t.created_at, t.rowid`, publishID)
	if err == nil {
		for _, id := range ids {
			if _, err = h.evaluateCoverTest(ctx, id); err != nil {
				break
			}
		}
	}
	if err != nil {
		h.c.Log().Warn("evaluate cover tests", "publish", publishID, "err", err)
	}
}

// coverTestsJob 是后台任务 cover_tests 的一轮：进行中的测试都算一遍，单条出错只记日志。
func (h *handler) coverTestsJob(ctx context.Context, _ plugin.Core) error {
	ids, err := h.runningCoverTests(ctx, `SELECT id FROM video_cover_tests WHERE status = 'running' ORDER BY created_at, rowid`)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return nil
		}
		if _, err := h.evaluateCoverTest(ctx, id); err != nil && ctx.Err() == nil {
			h.c.Log().Warn("evaluate cover test", "test", id, "err", err)
		}
	}
	return nil
}

func (h *handler) runningCoverTests(ctx context.Context, q string, args ...any) ([]string, error) {
	rows, err := h.c.Store().Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// listCoverTests 是 GET /api/video/cover-tests?video_id=&status=。
func (h *handler) listCoverTests(w http.ResponseWriter, r *http.Request) {
	var conds []string
	var args []any
	for _, k := range []string{"video_id", "status"} {
		if v := r.URL.Query().Get(k); v != "" {
			conds, args = append(conds, k+` = ?`), append(args, v)
		}
	}
	where := ""
	if len(conds) > 0 {
		where = `WHERE ` + strings.Join(conds, ` AND `)
	}
	xs, err := h.loadCoverTests(r.Context(), where, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": xs, "meta": map[string]int{"total": len(xs)}})
}

func (h *handler) showCoverTest(w http.ResponseWriter, r *http.Request) {
	t, err := h.getCoverTest(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": t})
}

// parseArmNumbers 读一组的曝光、点击率；传 null 清掉。
func parseArmNumbers(raw map[string]json.RawMessage, a *CoverTestArm) error {
	if b, ok := raw["impressions"]; ok {
		if isNull(b) {
			a.Impressions = nil
		} else {
			var n int
			if err := intField(raw, "impressions", "曝光", &n, 0, 1<<31-1); err != nil {
				return err
			}
			a.Impressions = &n
		}
	}
	if b, ok := raw["ctr"]; ok {
		if isNull(b) {
			a.CTR = nil
		} else {
			var f float64
			if err := json.Unmarshal(b, &f); err != nil || f < 0 || f > 1 {
				return apiErr(errValidation, "点击率 ctr 要是 0 到 1 之间的小数")
			}
			a.CTR = &f
		}
	}
	return nil
}

// applyThresholds 读三条门槛。
func applyThresholds(raw map[string]json.RawMessage, t *CoverTest) error {
	if err := intField(raw, "min_days", "最少天数", &t.MinDays, 1, 365); err != nil {
		return err
	}
	if err := intField(raw, "min_impressions", "最少曝光", &t.MinImpressions, 0, 1<<31-1); err != nil {
		return err
	}
	if b, ok := raw["min_gap"]; ok {
		var f float64
		if err := json.Unmarshal(b, &f); err != nil || f < 0 || f > 10 {
			return apiErr(errValidation, "领先比例 min_gap 要是 0 到 10 之间的小数（0.2 即 20%%）")
		}
		t.MinGap = f
	}
	return nil
}

// checkArms 校验分组：2 到 5 组，封面是这个视频的、没归档、不重复；小号分发每组一条本视频本平台的发布记录、不重复，
// 发布记录用了封面的要和这组的封面一致，曝光、点击率从发布记录读，不能手填；另两种方式的发布记录可选、可以共用一条。
func (h *handler) checkArms(ctx context.Context, t CoverTest) error {
	if n := len(t.Arms); n < 2 || n > 5 {
		return apiErr(errValidation, "一次测试挂 2 到 5 张封面，现在 %d 张", n)
	}
	covers, pubs := map[string]bool{}, map[string]bool{}
	for i, a := range t.Arms {
		if a.CoverID == "" {
			return apiErr(errValidation, "第 %d 组没选封面", i+1)
		}
		if covers[a.CoverID] {
			return apiErr(errValidation, "封面 %s 重复了，每组一张不同的封面", a.CoverID)
		}
		covers[a.CoverID] = true
		c, err := h.getArtifact(ctx, a.CoverID)
		if errors.Is(err, errNotFound) {
			return apiErr(errValidation, "封面 %s 不存在", a.CoverID)
		} else if err != nil {
			return err
		}
		switch {
		case c.Kind != "cover":
			return apiErr(errValidation, "cover_id 要是封面，%s 是%s", c.ID, kindLabel(c.Kind))
		case c.VideoID != t.VideoID:
			return apiErr(errValidation, "封面 %s 不是这个视频的", c.ID)
		case c.Archived != nil && *c.Archived:
			return apiErr(errValidation, "封面 %s 已归档，先取消归档再拿来测试", c.ID)
		}
		if t.Mode == "accounts" {
			if a.PublishID == "" {
				return apiErr(errValidation, "小号分发每组要对应一条发布记录（第 %d 组没有）", i+1)
			}
			if a.Impressions != nil || a.CTR != nil {
				return apiErr(errValidation, "小号分发的曝光、点击率从发布记录读，不用手填")
			}
			if pubs[a.PublishID] {
				return apiErr(errValidation, "发布记录 %s 重复了，小号分发每组一条", a.PublishID)
			}
			pubs[a.PublishID] = true
		}
		if a.PublishID == "" {
			continue
		}
		p, err := h.getPublish(ctx, a.PublishID)
		if errors.Is(err, errNotFound) {
			return apiErr(errValidation, "发布记录 %s 不存在", a.PublishID)
		} else if err != nil {
			return err
		}
		switch {
		case p.VideoID != t.VideoID:
			return apiErr(errValidation, "发布记录 %s 不是这个视频的", p.ID)
		case p.Platform != t.Platform:
			return apiErr(errValidation, "发布记录 %s 发在%s，测试的平台是%s", p.ID, PlatformLabels[p.Platform], PlatformLabels[t.Platform])
		case t.Mode == "accounts" && p.CoverID != "" && p.CoverID != a.CoverID:
			return apiErr(errValidation, "发布记录 %s 用的封面是 %s，和这组的封面 %s 不一致", p.ID, p.CoverID, a.CoverID)
		}
	}
	return nil
}

// addCoverTest 是 POST /api/video/cover-tests：开一次测试，状态是进行中，开完立刻算一遍（数据已经够的直接判出）。
func (h *handler) addCoverTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "video_id", "platform", "mode", "arms", "started_at", "min_days", "min_impressions", "min_gap")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t := CoverTest{MinDays: defaultMinDays, MinImpressions: defaultMinImpressions, MinGap: defaultMinGap, Status: "running"}
	if err := strField(raw, "video_id", "video_id", &t.VideoID, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.getVideo(ctx, t.VideoID); errors.Is(err, errNotFound) {
		fail(w, r, h.c, apiErr(errValidation, "视频不存在"))
		return
	} else if err != nil {
		fail(w, r, h.c, err)
		return
	}
	for _, f := range []struct {
		key    string
		dst    *string
		values []string
	}{{"platform", &t.Platform, Platforms}, {"mode", &t.Mode, CoverTestModes}} {
		if _, ok := raw[f.key]; !ok {
			fail(w, r, h.c, apiErr(errValidation, "%s 必填", f.key))
			return
		}
		if err := enumField(raw, f.key, f.key, f.dst, f.values); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	var start *string
	if err := timeField(raw, "started_at", "started_at", &start); err != nil {
		fail(w, r, h.c, err)
		return
	}
	t.StartedAt = nowStr()
	if start != nil {
		t.StartedAt = *start
	}
	if err := applyThresholds(raw, &t); err != nil {
		fail(w, r, h.c, err)
		return
	}
	var arms []map[string]json.RawMessage
	if b, ok := raw["arms"]; !ok || json.Unmarshal(b, &arms) != nil {
		fail(w, r, h.c, apiErr(errValidation, "arms 必填，是 {cover_id, publish_id?, impressions?, ctr?} 的数组"))
		return
	}
	for _, m := range arms {
		var a CoverTestArm
		for k := range m {
			if !slices.Contains([]string{"cover_id", "publish_id", "impressions", "ctr"}, k) {
				fail(w, r, h.c, apiErr(errValidation, "分组里不认识的字段 %s", k))
				return
			}
		}
		if err := strField(m, "cover_id", "cover_id", &a.CoverID, 100); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if err := strField(m, "publish_id", "publish_id", &a.PublishID, 100); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if err := parseArmNumbers(m, &a); err != nil {
			fail(w, r, h.c, err)
			return
		}
		t.Arms = append(t.Arms, a)
	}
	if err := h.checkArms(ctx, t); err != nil {
		fail(w, r, h.c, err)
		return
	}
	var n int
	if err := h.c.Store().QueryRow(ctx, `SELECT count(*) FROM video_cover_tests WHERE video_id = ? AND platform = ? AND status = 'running'`,
		t.VideoID, t.Platform).Scan(&n); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n > 0 {
		fail(w, r, h.c, apiErr(errConflict, "这个视频在%s已经有一个进行中的封面测试，等它结束或删掉再开", PlatformLabels[t.Platform]))
		return
	}
	t.ID = idgen.Prefixed("vct")
	now := nowStr()
	st := h.c.Store()
	if _, err := st.Exec(ctx, `INSERT INTO video_cover_tests (`+coverTestCols+`) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, '', 'running', ?, ?)`,
		t.ID, t.VideoID, t.Platform, t.Mode, t.StartedAt, t.MinDays, t.MinImpressions, t.MinGap, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	for i, a := range t.Arms {
		if _, err := st.Exec(ctx, `INSERT INTO video_cover_test_arms (test_id, position, cover_id, publish_id, impressions, ctr) VALUES (?, ?, ?, ?, ?, ?)`,
			t.ID, i+1, a.CoverID, a.PublishID, a.Impressions, a.CTR); err != nil {
			_, _ = st.Exec(context.WithoutCancel(ctx), `DELETE FROM video_cover_tests WHERE id = ?`, t.ID)
			fail(w, r, h.c, err)
			return
		}
	}
	h.respondCoverTest(w, r, http.StatusCreated, t.ID)
}

// respondCoverTest 先重算一遍再读回写出。
func (h *handler) respondCoverTest(w http.ResponseWriter, r *http.Request, status int, id string) {
	ctx := r.Context()
	if _, err := h.evaluateCoverTest(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getCoverTest(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": out})
}

// updateCoverTest 是 PATCH /api/video/cover-tests/{id}：只有进行中的能改，能改三条门槛和各组的曝光、点击率（按 cover_id 对上），
// 分组建好后不能增删换；改完立刻算一遍。
func (h *handler) updateCoverTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "min_days", "min_impressions", "min_gap", "arms")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t, err := h.getCoverTest(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if t.Status != "running" {
		fail(w, r, h.c, apiErr(errConflict, "测试已经结束了，不能再改"))
		return
	}
	if err := applyThresholds(raw, &t); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if b, ok := raw["arms"]; ok {
		var arms []map[string]json.RawMessage
		if json.Unmarshal(b, &arms) != nil {
			fail(w, r, h.c, apiErr(errValidation, "arms 是 {cover_id, impressions?, ctr?} 的数组"))
			return
		}
		if t.Mode == "accounts" && len(arms) > 0 {
			fail(w, r, h.c, apiErr(errValidation, "小号分发的曝光、点击率从发布记录读，回填到发布记录上"))
			return
		}
		for _, m := range arms {
			for k := range m {
				if k != "cover_id" && k != "impressions" && k != "ctr" {
					fail(w, r, h.c, apiErr(errValidation, "分组建好后只能改曝光、点击率，不认识的字段 %s", k))
					return
				}
			}
			var cover string
			if err := strField(m, "cover_id", "cover_id", &cover, 100); err != nil {
				fail(w, r, h.c, err)
				return
			}
			i := slices.IndexFunc(t.Arms, func(a CoverTestArm) bool { return a.CoverID == cover })
			if i < 0 {
				fail(w, r, h.c, apiErr(errValidation, "封面 %s 不在这次测试里，分组建好后不能增删", cover))
				return
			}
			if err := parseArmNumbers(m, &t.Arms[i]); err != nil {
				fail(w, r, h.c, err)
				return
			}
		}
	}
	st, now := h.c.Store(), nowStr()
	if _, err := st.Exec(ctx, `UPDATE video_cover_tests SET min_days = ?, min_impressions = ?, min_gap = ?, updated_at = ? WHERE id = ?`,
		t.MinDays, t.MinImpressions, t.MinGap, now, t.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	for i, a := range t.Arms {
		if _, err := st.Exec(ctx, `UPDATE video_cover_test_arms SET impressions = ?, ctr = ? WHERE test_id = ? AND position = ?`,
			a.Impressions, a.CTR, t.ID, i+1); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	h.respondCoverTest(w, r, http.StatusOK, t.ID)
}

// evaluateCoverTestNow 是 POST /api/video/cover-tests/{id}/evaluate：马上按当前数据算一遍；已结束的原样返回。
func (h *handler) evaluateCoverTestNow(w http.ResponseWriter, r *http.Request) {
	if _, err := h.getCoverTest(r.Context(), r.PathValue("id")); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.respondCoverTest(w, r, http.StatusOK, r.PathValue("id"))
}

// decideCoverTest 是 POST /api/video/cover-tests/{id}/decide（VID-05d）：手动判定，门槛不动。
// 给了 winner_id 按它判胜（同自动判出：设主封面、其余归档），不给就结束、不判胜负，封面都不动；已结束的 409。
func (h *handler) decideCoverTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw := map[string]json.RawMessage{}
	if r.ContentLength != 0 {
		var err error
		if raw, err = readBody(r, "winner_id"); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	var winner string
	if b, ok := raw["winner_id"]; ok && !isNull(b) {
		if err := strField(raw, "winner_id", "winner_id", &winner, 100); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if err := h.decideCoverTestAs(ctx, r.PathValue("id"), winner); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getCoverTest(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *handler) decideCoverTestAs(ctx context.Context, id, winner string) error {
	coverTestMu.Lock()
	defer coverTestMu.Unlock()
	t, err := h.getCoverTest(ctx, id)
	if err != nil {
		return err
	}
	if t.Status != "running" {
		return apiErr(errConflict, "测试已经结束了，不能再判")
	}
	status := "inconclusive"
	if winner != "" {
		if !slices.ContainsFunc(t.Arms, func(a CoverTestArm) bool { return a.CoverID == winner }) {
			return apiErr(errValidation, "封面 %s 不在这次测试里", winner)
		}
		if _, err := h.getArtifact(ctx, winner); errors.Is(err, errNotFound) {
			return apiErr(errValidation, "封面 %s 不存在", winner)
		} else if err != nil {
			return err
		}
		status = "decided"
		if err := h.applyCoverWinner(ctx, t, winner); err != nil {
			return err
		}
	}
	now := nowStr()
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_cover_tests SET status = ?, winner_id = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
		status, winner, now, now, t.ID); err != nil {
		return err
	}
	if err := h.touchVideo(ctx, t.VideoID); err != nil {
		return err
	}
	h.c.Log().Info("cover test decided by hand", "test", t.ID, "status", status, "winner", winner)
	return nil
}

// removeCoverTest：只删测试和分组，封面的选用、归档不回退。
func (h *handler) removeCoverTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t, err := h.getCoverTest(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_cover_tests WHERE id = ?`, t.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}
