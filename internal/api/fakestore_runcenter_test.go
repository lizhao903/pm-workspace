// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"slices"
	"sort"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// fakeStore 的 task 执行全量读法，供运行中心（GET /api/runs/all）的接口测试用。
//
// 语义和 sqlite 实现同构，因为 handler 的行为直接压在它们上面：
//   - statuses 为空不过滤，否则只留这些状态；
//   - started_at 倒序；时间戳撞车时按插入顺序倒序（sqlite 那边是 rowid DESC）；
//   - total 是过滤后的全部命中数，不受 limit/offset 影响；
//   - 分页在这里就切好（sqlite 在 SQL 里切）；
//   - 空集回空切片而不是 nil，否则响应会从 [] 变成 null。
//
// ref/title 从 f.objs 里补，handler 拼「编号 标题」的逻辑才测得到；对象不在时留空。
func (f *fakeStore) ListAllTaskRuns(_ context.Context, statuses []string, limit, offset int) ([]*store.RunCenterTaskRun, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	out := []*store.RunCenterTaskRun{}
	for _, r := range f.runsMap() {
		if len(statuses) > 0 && !slices.Contains(statuses, r.Status) {
			continue
		}
		c := *r
		item := &store.RunCenterTaskRun{Run: &c}
		if o, ok := f.objs[c.ObjectID]; ok {
			item.ObjectRef, item.ObjectTitle = o.Ref, o.Title
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Run.StartedAt.Equal(out[j].Run.StartedAt) {
			return f.taskRunSeq[out[i].Run.ID] > f.taskRunSeq[out[j].Run.ID]
		}
		return out[i].Run.StartedAt.After(out[j].Run.StartedAt)
	})

	total := len(out)
	if limit <= 0 {
		limit = store.DefaultRunLimit
	}
	if offset < 0 {
		offset = 0
	}
	if offset >= len(out) {
		return []*store.RunCenterTaskRun{}, total, nil
	}
	out = out[offset:]
	if len(out) > limit {
		out = out[:limit]
	}
	return out, total, nil
}
