// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// reviewAfterRun 是内核收尾路径共用的「执行完成改待验收」（TSK-0861，SPEC-tasks-6.42）：
// 只在执行成功完成（done）时调。发起时任务已经改成进行中（markDoing），所以 expect 是 doing；
// 判断规则见 store.RunReviewStatus。改不成只记日志：执行已经收尾了，状态没改上不该让收尾报错。
// executor 是进展里的执行者（「Claude Code」「工作台 Agent「名称」」），a 是这次改状态的操作者。
func (s *Server) reviewAfterRun(ctx context.Context, objectID, runID, executor string, a store.Actor) {
	changed, why, err := store.MarkRunReview(ctx, s.st, objectID, runID, taskDoing, store.RunReviewNote(executor, runID), a)
	switch {
	case err != nil:
		s.log.Warn("mark task review after run failed", "run", runID, "object", objectID, "err", err)
	case !changed:
		s.log.Info("task not moved to review after run", "run", runID, "object", objectID, "reason", why)
	}
}
