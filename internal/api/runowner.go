// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"

	"github.com/lizhao903/pm-workspace/internal/aimember"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// runExecutor 是这次执行交给谁（TSK-0500）：CLI（claude / deepseek）或某个工作台 Agent。
// 发起执行时负责人设成它在名册里的 AI 成员（internal/aimember）。
type runExecutor struct {
	kind string // domain.AIKindCLI / domain.AIKindAgent；空表示不改负责人
	ref  string // harness 或 Agent id
	name string // 进展里「交给 X 执行」的 X
}

func cliExecutor(harness string) runExecutor {
	if harness == "" {
		harness = domain.RunHarnessClaude
	}
	name := "Claude Code"
	for _, m := range aimember.CLIs {
		if m.Ref == harness {
			name = m.Name
		}
	}
	return runExecutor{kind: domain.AIKindCLI, ref: harness, name: name}
}

func agentExecutor(a *domain.Agent) runExecutor {
	if a == nil {
		return runExecutor{}
	}
	return runExecutor{kind: domain.AIKindAgent, ref: a.ID, name: a.Name}
}

func (e runExecutor) label() string { return "交给 " + e.name + " 执行" }

// runOwner 取执行者在名册里的成员；取不到只记日志、不改负责人——执行照常发起。
func (s *Server) runOwner(ctx context.Context, ex runExecutor) *domain.Stakeholder {
	if ex.kind == "" {
		return nil
	}
	sh, err := aimember.For(ctx, s.st, ex.kind, ex.ref)
	if err != nil {
		s.log.Warn("run owner not resolved", "kind", ex.kind, "ref", ex.ref, "err", err)
		return nil
	}
	return sh
}

// syncAIMembers 在 Agent 增删改之后让名册跟上（名字、归档）。失败只记日志：Agent 已经改好了，
// 名册下次启动或下次发起执行时还会再对一次。
func (s *Server) syncAIMembers(ctx context.Context) {
	if err := aimember.Sync(ctx, s.st); err != nil {
		s.log.Warn("sync ai members failed", "err", err)
	}
}
