// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package domain

import "context"

type runOriginKey struct{}

// WithRunOrigin 标记接下来收尾的任务执行是谁发起的（如 "plugin:sop"）。
// task_runs 表不记发起方，收尾时经 ctx 带到 run.finished 的 origin 字段：
// 订阅方据此区分「人交给 CLI 的执行」和「插件流程里的一步」（IM 任务回执只认前者）。
func WithRunOrigin(ctx context.Context, origin string) context.Context {
	return context.WithValue(ctx, runOriginKey{}, origin)
}

// RunOrigin 取 WithRunOrigin 标的发起方，没标回空串（人发起的执行）。
func RunOrigin(ctx context.Context) string {
	s, _ := ctx.Value(runOriginKey{}).(string)
	return s
}
