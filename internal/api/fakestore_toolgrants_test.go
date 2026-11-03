package api

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// 工具授权的接口测试用真库（toolgrants_test.go），替身只为满足 store.Store：没有授权、没有待确认的调用。

var errFakeGrants = errors.New("tool grants are not implemented in fakeStore")

func (f *fakeStore) AgentGrants(context.Context, string) (map[string]string, error) {
	return map[string]string{}, nil
}
func (f *fakeStore) SetAgentGrants(context.Context, string, map[string]string) error {
	return errFakeGrants
}
func (f *fakeStore) DetachConnector(context.Context, string) ([]string, error) { return nil, nil }
func (f *fakeStore) CreateAgentToolCall(context.Context, *store.AgentToolCall) (*store.AgentToolCall, error) {
	return nil, errFakeGrants
}
func (f *fakeStore) GetAgentToolCall(context.Context, string) (*store.AgentToolCall, error) {
	return nil, notFoundf("tool call not found")
}
func (f *fakeStore) DecideAgentToolCall(context.Context, string, string) (*store.AgentToolCall, error) {
	return nil, errFakeGrants
}
func (f *fakeStore) SetAgentToolCallResult(context.Context, string, string) error {
	return errFakeGrants
}
func (f *fakeStore) CountPendingToolCalls(context.Context, string) (int, error) { return 0, nil }
