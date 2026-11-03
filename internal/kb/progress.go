package kb

import (
	"sync"
	"time"
)

// SyncProgress 是一个知识库正在跑的同步到了哪一步，给界面轮询显示进度。
//   - Dir：正在同步的目录，空串是在收文档分类；
//   - Listed：这个目录已经列出的、要收的文本文件数；Listing 为 true 表示还在往下列，总数还会涨；
//   - Done：这个目录已经处理完的文件数（新收、重新索引、内容没变跳过的都算）。
type SyncProgress struct {
	KbID      string    `json:"kb_id"`
	Dir       string    `json:"dir"`
	Listed    int       `json:"listed"`
	Done      int       `json:"done"`
	Listing   bool      `json:"listing"`
	StartedAt time.Time `json:"started_at"`
}

// Tracker 记各知识库正在跑的同步：同一个知识库同时只跑一次，进度只在内存里，服务重启就没了。
// 方法对 nil 安全，Service 没配 Tracker 时什么也不做。
type Tracker struct {
	mu sync.Mutex
	m  map[string]*SyncProgress
}

func NewTracker() *Tracker { return &Tracker{m: map[string]*SyncProgress{}} }

func (t *Tracker) begin(kbID string) bool {
	if t == nil {
		return true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m[kbID] != nil {
		return false
	}
	t.m[kbID] = &SyncProgress{KbID: kbID, StartedAt: time.Now().UTC()}
	return true
}

func (t *Tracker) end(kbID string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	delete(t.m, kbID)
	t.mu.Unlock()
}

func (t *Tracker) update(kbID string, fn func(p *SyncProgress)) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if p := t.m[kbID]; p != nil {
		fn(p)
	}
}

// Get 回这个知识库正在跑的同步的进度副本，没在同步回 nil。
func (t *Tracker) Get(kbID string) *SyncProgress {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	p := t.m[kbID]
	if p == nil {
		return nil
	}
	c := *p
	return &c
}
