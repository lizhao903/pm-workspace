package api

import (
	"context"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 进展与领取的替身。和整个 fakeStore 一样不复刻业务规则（占用检查、状态校验
// 都在 sqlite 那边有测试），只保证 handler 能跑通、入参和 actor 被原样记下来。

func (f *fakeStore) ListProgress(_ context.Context, objectID string, limit int) ([]*domain.Progress, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.objs[objectID]; !ok {
		return nil, domain.ErrNotFound
	}
	if limit <= 0 {
		limit = store.DefaultProgressLimit
	}
	out := []*domain.Progress{}
	for i := len(f.progress) - 1; i >= 0 && len(out) < limit; i-- {
		if f.progress[i].ObjectID == objectID {
			out = append(out, f.progress[i])
		}
	}
	return out, nil
}

func (f *fakeStore) appendProgressLocked(objectID string, in domain.ProgressInput, a store.Actor) *domain.Progress {
	kind := in.Kind
	if kind == "" {
		kind = domain.ProgressNote
	}
	actor := domain.ComposeActor(a.Name, a.Session)
	p := &domain.Progress{
		ID: idgen.Prefixed("rev"), ObjectID: objectID, Kind: kind, Text: in.Text,
		Commits: nonNil(in.Commits), Files: nonNil(in.Files), Status: in.Status,
		Actor: actor, ActorName: a.Name, SessionID: a.Session, Source: a.Source,
		CreatedAt: time.Now().UTC(),
	}
	f.progress = append(f.progress, p)
	return p
}

func (f *fakeStore) AppendProgress(_ context.Context, objectID string, in domain.ProgressInput, a store.Actor) (*domain.Progress, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastActor = a
	o, ok := f.objs[objectID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if in.Text == "" {
		return nil, domain.ErrValidation
	}
	if in.Status != "" {
		o.Status = in.Status
	}
	return f.appendProgressLocked(objectID, in, a), nil
}

func (f *fakeStore) ClaimObject(_ context.Context, objectID string, in domain.ClaimInput, a store.Actor) (*domain.ClaimResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastActor = a
	o, ok := f.objs[objectID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if in.OwnerID == "" {
		return nil, domain.ErrValidation
	}
	if o.OwnerID != nil && *o.OwnerID != "" && *o.OwnerID != in.OwnerID && !in.Takeover {
		return nil, domain.ErrConflict
	}
	status := in.Status
	if status == "" {
		status = "doing"
	}
	o.Status = status
	owner := in.OwnerID
	o.OwnerID = &owner
	p := f.appendProgressLocked(objectID, domain.ProgressInput{Kind: domain.ProgressClaim, Text: in.Text, Status: status}, a)
	return &domain.ClaimResult{Object: o, Progress: p}, nil
}
