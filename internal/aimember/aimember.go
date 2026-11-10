// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package aimember 维护名册里的「AI 成员」（TSK-0500）：每个工作台 Agent、每种 CLI 执行器
// 在干系人名册里各有一条，任务交给它们执行时负责人就设成这一条。
//
// 负责人仍只指向名册（objects.owner_id → stakeholders），不另开一种引用：负责人筛选、
// 统计、MCP 按名字传 owner 都原样可用。这里只算「应该有哪些」，对齐交给 store.SyncAIMembers。
package aimember

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// CLIs 是命令行执行器对应的成员，Ref 是 task_runs.harness 的取值。
// 「Claude Code」和 pmw-mcp 领任务时找的名字一致（cmd/pmw-mcp defaultAgentOwner），
// 名册里已有 pmw-mcp 自建的那条时直接收编，不另建。
var CLIs = []domain.AIMember{
	{Kind: domain.AIKindCLI, Ref: domain.RunHarnessClaude, Name: "Claude Code",
		Note: "本机 Claude Code：后台执行、切换到终端、经 MCP 领任务时设为负责人。由工作台自动维护"},
	{Kind: domain.AIKindCLI, Ref: domain.RunHarnessDeepSeek, Name: "DeepSeek",
		Note: "deepseek-harness（dsh）：交给 DeepSeek 执行时设为负责人。由工作台自动维护"},
}

// Want 算出名册里应有的 AI 成员：全部 CLI 加全部 Agent（停用的也算，停用不等于删掉）。
func Want(ctx context.Context, st store.Store) ([]domain.AIMember, error) {
	agents, err := st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := append([]domain.AIMember{}, CLIs...)
	for _, a := range agents {
		out = append(out, domain.AIMember{Kind: domain.AIKindAgent, Ref: a.ID, Name: a.Name, Color: a.Color,
			Note: "工作台 Agent：交给它执行时设为负责人。名字跟着 Agent 改，删掉 Agent 时归档。由工作台自动维护"})
	}
	return out, nil
}

// Sync 让名册和当前的 Agent、CLI 对齐。启动时和 Agent 增删改后各调一次。
func Sync(ctx context.Context, st store.Store) error {
	want, err := Want(ctx, st)
	if err != nil {
		return err
	}
	return st.SyncAIMembers(ctx, want)
}

// For 取某个执行器对应的成员；名册里还没有（比如 Agent 刚从别处建出来）就先同步一次再取。
func For(ctx context.Context, st store.Store, kind, ref string) (*domain.Stakeholder, error) {
	sh, err := st.GetAIMember(ctx, kind, ref)
	if !errors.Is(err, domain.ErrNotFound) {
		return sh, err
	}
	if err := Sync(ctx, st); err != nil {
		return nil, err
	}
	return st.GetAIMember(ctx, kind, ref)
}
