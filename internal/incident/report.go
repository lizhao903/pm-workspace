// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package incident

import (
	"crypto/sha1"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

// 前端上报（POST /api/incidents/report）的口径。
const (
	// ReportMaxBytes 是单条上报的请求体上限。
	ReportMaxBytes = 32 << 10
	// ReportLimit 是整体每分钟最多收几条，超了回 429。
	ReportLimit = 60
)

// AllowReport 占一个上报名额；整体每分钟超过 ReportLimit 时回 false。
func (s *Store) AllowReport() bool { return s.reports.allow(s.now()) }

// FrontendFingerprint 是前端上报没给指纹时后端算的：front: 加模块、标题、堆栈第一帧的摘要。
func FrontendFingerprint(module, title, stack string) string {
	h := sha1.Sum([]byte(strings.TrimSpace(module) + "\x00" + strings.TrimSpace(title) + "\x00" + FirstFrame(stack)))
	return "front:" + hex.EncodeToString(h[:8])
}

// FirstFrame 是堆栈里第一帧：Chrome 的「    at f (file:1:2)」或 Firefox、Safari 的「f@file:1:2」；没有帧时为空。
func FirstFrame(stack string) string {
	for _, line := range strings.Split(stack, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "at ") || (strings.Contains(l, "@") && strings.Contains(l, ":")) {
			return l
		}
	}
	return ""
}

// limiter 是滑动窗口计数：窗口里最多 n 次。
type limiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	hits   []time.Time
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window}
}

func (l *limiter) allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now.Add(-l.window)
	i := 0
	for i < len(l.hits) && !l.hits[i].After(cut) {
		i++
	}
	l.hits = l.hits[i:]
	if len(l.hits) >= l.n {
		return false
	}
	l.hits = append(l.hits, now)
	return true
}
