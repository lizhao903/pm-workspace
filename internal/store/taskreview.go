// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package store

import (
	"context"
	"fmt"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 执行完成改待验收（TSK-0861，SPEC-tasks-6.42）。
//
// 任务交给执行器（后台 Claude Code / DeepSeek、工作台 Agent、终端交接、SOP 的执行任务节点）成功完成后，
// 任务状态自动改成「待验收」（domain.TaskStatusReview）。判断放在这里一处，内核各条收尾路径和插件运行共用，
// 口径不会各写各的。

// RunReviewStore 是判断和改状态要用的 store 方法，store.Store 和插件拿到的外层 store 都满足。
type RunReviewStore interface {
	GetObject(ctx context.Context, id string) (*domain.Object, error)
	GetObjectType(ctx context.Context, id string) (*domain.ObjectType, error)
	ListTaskRuns(ctx context.Context, objectID string, limit int) ([]*domain.TaskRun, error)
	AppendProgress(ctx context.Context, objectID string, in domain.ProgressInput, a Actor) (*domain.Progress, error)
}

// runReviewPeerLimit 是查「同一任务还有没有别的执行没结束」看的最近执行条数。
const runReviewPeerLimit = 20

// RunReviewStatus 判断执行 runID 成功完成后，任务 objectID 该不该改成待验收：该改回待验收的 key 和空原因，
// 不该改回空 key 和原因（写给日志看）。只读，不写。
//
// expect 是交出去时任务的状态（内核路径发起时已改成进行中，就是 doing；插件运行是发起那一刻读到的状态），
// 为空不比。规则：
//   - 不是任务、已删的不改；
//   - 已经是待验收的不改；当前状态是终态（已完成、已取消，按类型状态集的 terminal 算）的不倒退；
//   - 类型状态集里没有 review 的不改（用户在设置里删了这个状态）；
//   - 执行期间状态被改过（当前状态不等于 expect）的不改：人手动改的、执行者经 MCP 自己改的都以那次改动为准；
//   - 同一任务还有别的执行没结束（在跑、等人确认）的不改，等最后一个收尾时再判断。
func RunReviewStatus(ctx context.Context, st RunReviewStore, objectID, runID, expect string) (string, string, error) {
	o, err := st.GetObject(ctx, objectID)
	if err != nil {
		return "", "", err
	}
	if o.TypeID != "task" {
		return "", "不是任务", nil
	}
	if o.DeletedAt != nil {
		return "", "任务已删除", nil
	}
	switch o.Status {
	case domain.TaskStatusReview:
		return "", "已经是待验收", nil
	case "done", "cancelled":
		// 内置的终态 key 直接认（同发起时 markDoing 的口径），不依赖状态集里 terminal 标没标
		return "", fmt.Sprintf("任务已经是终态 %s，不倒退", o.Status), nil
	}
	ot, err := st.GetObjectType(ctx, o.TypeID)
	if err != nil {
		return "", "", err
	}
	hasReview := false
	for _, s := range ot.Statuses {
		if s.Key == o.Status && s.Terminal {
			return "", fmt.Sprintf("任务已经是终态 %s，不倒退", o.Status), nil
		}
		if s.Key == domain.TaskStatusReview {
			hasReview = true
		}
	}
	if !hasReview {
		return "", "任务类型的状态集里没有 review", nil
	}
	if expect != "" && o.Status != expect {
		return "", fmt.Sprintf("执行期间状态从 %s 改成了 %s，以那次改动为准", expect, o.Status), nil
	}
	runs, err := st.ListTaskRuns(ctx, objectID, runReviewPeerLimit)
	if err != nil {
		return "", "", err
	}
	for _, r := range runs {
		if r.ID != runID && r.FinishedAt == nil {
			return "", "同一任务还有执行 " + r.ID + " 没结束", nil
		}
	}
	return domain.TaskStatusReview, "", nil
}

// MarkRunReview 判断后把任务改成待验收，并记一条进展（kind=note，正文 text，和状态一次写）。
// 回改没改和不改的原因。
func MarkRunReview(ctx context.Context, st RunReviewStore, objectID, runID, expect, text string, a Actor) (bool, string, error) {
	key, why, err := RunReviewStatus(ctx, st, objectID, runID, expect)
	if err != nil || key == "" {
		return false, why, err
	}
	if _, err := st.AppendProgress(ctx, objectID, domain.ProgressInput{Kind: domain.ProgressNote, Text: text, Status: key}, a); err != nil {
		return false, "", err
	}
	return true, "", nil
}

// RunReviewNote 是执行完成改待验收时记的那条进展：「<执行者>执行完成（执行记录 <id 后 8 位>），状态改为待验收」。
func RunReviewNote(executor, runID string) string {
	return fmt.Sprintf("%s 执行完成（执行记录 %s），状态改为待验收", executor, ShortRunID(runID))
}

// ShortRunID 是执行记录 id 的后 8 位，进展里给人看的写法。
func ShortRunID(id string) string {
	if len(id) > 8 {
		return id[len(id)-8:]
	}
	return id
}
