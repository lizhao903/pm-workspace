// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"time"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// 知识库的接口测试用真库（knowledge_test.go），替身只为满足 store.Store：列表回空，其余回错。

var errFakeKb = errors.New("knowledge bases are not implemented in fakeStore")

func (f *fakeStore) ListKnowledgeBases(context.Context) ([]*store.KnowledgeBase, error) {
	return []*store.KnowledgeBase{}, nil
}
func (f *fakeStore) GetKnowledgeBase(context.Context, string) (*store.KnowledgeBase, error) {
	return nil, notFoundf("knowledge base not found")
}
func (f *fakeStore) CreateKnowledgeBase(context.Context, store.KbInput) (*store.KnowledgeBase, error) {
	return nil, errFakeKb
}
func (f *fakeStore) UpdateKnowledgeBase(context.Context, string, store.KbInput) (*store.KnowledgeBase, error) {
	return nil, errFakeKb
}
func (f *fakeStore) DeleteKnowledgeBase(context.Context, string) (*store.KnowledgeBase, []string, error) {
	return nil, nil, errFakeKb
}
func (f *fakeStore) SetKbDirSynced(context.Context, string, string, time.Time) error {
	return errFakeKb
}
func (f *fakeStore) KbCounts(context.Context) (map[string]store.KbCounts, error) {
	return map[string]store.KbCounts{}, nil
}
func (f *fakeStore) ListKbDocs(context.Context, string) ([]*store.KbDoc, error) {
	return []*store.KbDoc{}, nil
}
func (f *fakeStore) GetKbDoc(context.Context, string, string) (*store.KbDoc, error) {
	return nil, notFoundf("knowledge base doc not found")
}
func (f *fakeStore) CreateKbDoc(context.Context, *store.KbDoc) (*store.KbDoc, error) {
	return nil, errFakeKb
}
func (f *fakeStore) UpdateKbDoc(context.Context, *store.KbDoc) (*store.KbDoc, error) {
	return nil, errFakeKb
}
func (f *fakeStore) IndexKbDoc(context.Context, string, string, string, []store.KbChunk) (*store.KbDoc, error) {
	return nil, errFakeKb
}
func (f *fakeStore) DeleteKbDocs(context.Context, string, []string) error { return errFakeKb }
func (f *fakeStore) KbSearchCandidates(context.Context, []string, []string) ([]*store.KbCandidate, error) {
	return []*store.KbCandidate{}, nil
}
