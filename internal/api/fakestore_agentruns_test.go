package api

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// 执行记录的接口测试用真库（agentruns_test.go），替身只为满足 store.Store：没有执行记录。

var errFakeRuns = errors.New("agent runs are not implemented in fakeStore")

func (f *fakeStore) CreateAgentRun(context.Context, *store.AgentRun) (*store.AgentRun, error) {
	return nil, errFakeRuns
}
func (f *fakeStore) GetAgentRun(context.Context, string) (*store.AgentRun, error) {
	return nil, notFoundf("agent run not found")
}
func (f *fakeStore) ListAgentRuns(context.Context, store.AgentRunFilter) ([]*store.AgentRun, int, error) {
	return []*store.AgentRun{}, 0, nil
}
func (f *fakeStore) SetAgentRunSession(context.Context, string, string) error { return errFakeRuns }
func (f *fakeStore) FinishAgentRun(context.Context, string, string, string) (*store.AgentRun, error) {
	return nil, errFakeRuns
}
func (f *fakeStore) ListRunToolCalls(context.Context, string) ([]*store.AgentToolCall, error) {
	return []*store.AgentToolCall{}, nil
}
func (f *fakeStore) FailInterruptedAgentRuns(context.Context, string) (int, error) { return 0, nil }
