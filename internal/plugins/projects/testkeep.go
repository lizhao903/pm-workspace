// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 测试环境保留给人工验收（AUTO-09），见 testenv.go 文件头。
//
// 保留：执行协程在全部通过、要求了保留时调 keepEnv，测试环境的进程不杀，登记在 s.kept，记 env_state = kept、到点时间。
// 回收（release）：先用条件更新把 kept 改成 released（只有一个调用方能改成，并发回收只杀一次），再杀进程组。
// 本进程管着的按 bgProc 杀（顺手补测试环境那一步的输出尾部）；不归本进程管的（工作台重启前留下的）按记下的进程组杀。

const minEnvKeep = time.Minute

// keepEnv 登记保留的测试环境，回登记上没有：插件正在停用时不保留（回 false，调用方照常杀掉）。
func (s *testService) keepEnv(r *TestRun, bp *bgProc) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	until := s.now().Add(r.keep)
	r.EnvState, r.EnvKeepUntil = envKept, &until
	s.kept[r.ID] = bp
	// 环境自己退出了（崩了、被人杀了）就记成回收；是我们回收时杀的，release 已经改过状态，这里什么都不做
	go func(id string) {
		<-bp.exited
		if _, err := s.release(context.Background(), id, EnvExited); err != nil {
			s.c.Log().Debug("release exited test env", "test", id, "err", err)
		}
	}(r.ID)
	return true
}

// release 回收一次测试保留着的测试环境，回回收后的记录；没保留或已经回收的原样回。
func (s *testService) release(ctx context.Context, id, reason string) (TestRun, error) {
	r, err := s.get(ctx, id)
	if err != nil || r.EnvState != envKept {
		return r, err
	}
	now := s.now()
	res, err := s.c.Store().Exec(ctx, `UPDATE projects_test_runs SET env_state = ?, env_released_at = ?, env_release_reason = ?, env_pgid = 0,
		updated_at = ? WHERE id = ? AND env_state = ?`,
		envReleased, now.Format(time.RFC3339), reason, now.Format(time.RFC3339), id, envKept)
	if err != nil {
		return TestRun{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return s.get(ctx, id) // 别的调用方刚回收了
	}
	s.mu.Lock()
	bp := s.kept[id]
	delete(s.kept, id)
	s.mu.Unlock()
	switch {
	case bp != nil:
		bp.kill()
	case r.envPgid > 0:
		killGroupAsync(r.envPgid)
	}
	r.EnvState, r.EnvReleasedAt, r.EnvReleaseReason, r.envPgid = envReleased, &now, reason, 0
	if bp != nil {
		for i := range r.Steps {
			if r.Steps[i].Key == "test_env" {
				r.Steps[i].Output = bp.buf.tail()
			}
		}
	}
	s.save(ctx, &r)
	s.c.Log().Info("test env released", "test", id, "task", r.TaskID, "reason", reason)
	return r, nil
}

// releaseTask 回收任务全部保留着的测试环境（正常最多一个）。失败只记日志。
func (s *testService) releaseTask(ctx context.Context, taskID, reason string) {
	if taskID == "" {
		return
	}
	rows, err := s.list(ctx, "task_id = ? AND env_state = ?", []any{taskID, envKept}, 20)
	if err != nil {
		s.c.Log().Warn("list kept test envs failed", "task", taskID, "err", err)
		return
	}
	for _, r := range rows {
		if _, err := s.release(ctx, r.ID, reason); err != nil {
			s.c.Log().Warn("release kept test env failed", "test", r.ID, "err", err)
		}
	}
}

// releaseExpired 回收到点的。
func (s *testService) releaseExpired(ctx context.Context) error {
	rows, err := s.list(ctx, "env_state = ? AND env_keep_until <= ?", []any{envKept, s.now().Format(time.RFC3339)}, 50)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := s.release(ctx, r.ID, EnvExpired); err != nil {
			s.c.Log().Warn("release expired test env failed", "test", r.ID, "err", err)
		}
	}
	return nil
}

// onStageChanged：阶段离开「待验收」时验收结束了，回收保留的测试环境；进「待发布」「已上线」算验收通过。
func (s *testService) onStageChanged(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var p struct {
		ID   string `json:"id"`
		From string `json:"from"`
		To   string `json:"to"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" || p.From != acceptingStage || p.To == acceptingStage {
		return nil
	}
	reason := EnvStageChanged
	if p.To == releasingStage || p.To == releasedStage {
		reason = EnvAccepted
	}
	s.releaseTask(ctx, p.ID, reason)
	return nil
}

// onStatusChanged：任务完成或取消时回收。
func (s *testService) onStatusChanged(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var p struct {
		ID string `json:"id"`
		To string `json:"to"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
		return nil
	}
	if _, ok := doneStatuses[p.To]; ok {
		s.releaseTask(ctx, p.ID, EnvTaskDone)
	}
	return nil
}

var keepDurRe = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*(分钟|分|小时|时|天|周)$`)

// keepOf 解析 SOP 节点的 config.keep_env：空、否、no、false、0 不保留；是、yes、true、保留 用设置里的默认时长；
// 也可以写时长「24 小时」「2 天」「30 分钟」或 Go 的写法「90m」「36h」，1 分钟到 168 小时。
func (s *testService) keepOf(ctx context.Context, v string) (time.Duration, error) {
	v = strings.TrimSpace(v)
	switch strings.ToLower(v) {
	case "", "否", "不", "不保留", "no", "false", "0":
		return 0, nil
	case "是", "保留", "yes", "true", "1":
		ps, err := s.wt.settingsOf(ctx)
		if err != nil {
			return 0, err
		}
		return time.Duration(ps.EnvKeepHours) * time.Hour, nil
	}
	var d time.Duration
	if m := keepDurRe.FindStringSubmatch(v); m != nil {
		n, _ := strconv.ParseFloat(m[1], 64)
		unit := map[string]time.Duration{"分钟": time.Minute, "分": time.Minute, "小时": time.Hour, "时": time.Hour, "天": 24 * time.Hour, "周": 7 * 24 * time.Hour}[m[2]]
		d = time.Duration(n * float64(unit))
	} else if pd, err := time.ParseDuration(v); err == nil {
		d = pd
	} else {
		return 0, fmt.Errorf("保留测试环境「%s」写法不对：填「是」用默认时长，或写「24 小时」「2 天」这样的时长", v)
	}
	if d < minEnvKeep || d > maxEnvKeepHours*time.Hour {
		return 0, fmt.Errorf("保留测试环境「%s」超出范围：要在 1 分钟到 %d 小时之间", v, maxEnvKeepHours)
	}
	return d, nil
}

func parseTimePtr(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, *s)
	if err != nil {
		return nil
	}
	return &t
}

func timeCol(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
