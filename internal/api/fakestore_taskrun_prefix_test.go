// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 模块前缀复用与缓存用量（0058）在替身上的实现。
//
// fakeStore 的字段定义在 fakestore_test.go（不归这条线改），模块简报就放在包级表里、
// 按替身实例区分；每个测试用的是各自的 *fakeStore，不会互相串。真正的语义在 sqlite 那边测。

var fakeModulePrefixes = struct {
	sync.Mutex
	m map[*fakeStore]map[string]*domain.ModulePrefix
}{m: map[*fakeStore]map[string]*domain.ModulePrefix{}}

func (f *fakeStore) modulePrefixMap() map[string]*domain.ModulePrefix {
	fakeModulePrefixes.Lock()
	defer fakeModulePrefixes.Unlock()
	m, ok := fakeModulePrefixes.m[f]
	if !ok {
		m = map[string]*domain.ModulePrefix{}
		fakeModulePrefixes.m[f] = m
	}
	return m
}

// GetModulePrefix 同 sqlite：不存在回 (nil, nil)。
func (f *fakeStore) GetModulePrefix(_ context.Context, moduleKey string) (*domain.ModulePrefix, error) {
	m := f.modulePrefixMap()
	p, ok := m[moduleKey]
	if !ok {
		return nil, nil
	}
	c := *p
	return &c, nil
}

// SaveModulePrefix 同 sqlite：按 module_key upsert。
func (f *fakeStore) SaveModulePrefix(_ context.Context, p *domain.ModulePrefix) error {
	if p == nil || p.ModuleKey == "" {
		return domain.ErrValidation
	}
	c := *p
	f.modulePrefixMap()[p.ModuleKey] = &c
	return nil
}

// SetTaskRunUsage 同 sqlite：记录不存在回 ErrNotFound。
func (f *fakeStore) SetTaskRunUsage(_ context.Context, id string, cacheRead, uncached, output int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.runsMap()[id]
	if !ok {
		return domain.ErrNotFound
	}
	r.CacheReadTokens, r.UncachedInputTokens, r.OutputTokens = cacheRead, uncached, output
	return nil
}

// SetTaskRunModule 同 sqlite：记录不存在回 ErrNotFound。
func (f *fakeStore) SetTaskRunModule(_ context.Context, id, moduleKey string, prefixVersion int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.runsMap()[id]
	if !ok {
		return domain.ErrNotFound
	}
	r.ModuleKey, r.PrefixVersion = moduleKey, prefixVersion
	return nil
}
