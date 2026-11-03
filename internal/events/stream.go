package events

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Stream 是推给前端的事件流（CORE-07b，GET /api/events）：给每条事件发一个递增 id，
// 在内存里留最近 Size 条，断线重连时按 Last-Event-ID 补齐。
//
// id 从启动时刻的微秒数起递增：同一进程内严格递增；重启后新的起点比上次进程发过的都大
// （除非上次每秒发了上百万条或系统时钟回拨），旧的 Last-Event-ID 自然落在窗口之前，按「补不齐」处理。
// 只放内存不落库：补齐只为短暂断线（切网、休眠），补不齐时发 stream.reset 让前端整页重新拉。
type Stream struct {
	mu     sync.Mutex
	size   int
	buf    []Entry // 环形，按 id 升序；满了覆盖最旧的
	start  int     // buf 里最旧一条的下标
	last   int64   // 最近发出的 id；还没有事件时是起点
	subs   map[*sub]struct{}
	closed bool
}

// Entry 是流里的一条，序列化后就是 SSE 的 data。
type Entry struct {
	ID      int64           `json:"-"`
	Type    string          `json:"type"`
	At      time.Time       `json:"at"`
	Payload json.RawMessage `json:"payload"`
}

// 流自己的控制事件，不经过总线。
const (
	// StreamReady 是新连接的第一条，带当前 id，让前端没收到任何事件前断线也能从这里补齐。
	StreamReady = "stream.ready"
	// StreamReset 表示 Last-Event-ID 已不在补齐窗口里（太久或服务重启过），前端应整页重新拉。
	StreamReset = "stream.reset"
)

// DefaultStreamSize 是补齐窗口的条数。一次改动大约两三条事件，1000 条够覆盖几分钟的断线。
const DefaultStreamSize = 1000

// subBuffer 是每个连接的待发队列；写不进去说明客户端太慢，断开它，让它带 Last-Event-ID 重连补齐。
const subBuffer = 256

type sub struct {
	ch chan Entry
}

func NewStream(size int) *Stream {
	if size <= 0 {
		size = DefaultStreamSize
	}
	return &Stream{size: size, last: time.Now().UnixMicro(), subs: map[*sub]struct{}{}}
}

// Append 收一条总线事件（作为 Bus.Tap 的回调），发给所有连接。不阻塞。
func (s *Stream) Append(ev plugin.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.last++
	payload := ev.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}
	e := Entry{ID: s.last, Type: ev.Type, At: ev.At, Payload: payload}
	if len(s.buf) < s.size {
		s.buf = append(s.buf, e)
	} else {
		s.buf[s.start] = e
		s.start = (s.start + 1) % s.size
	}
	for c := range s.subs {
		select {
		case c.ch <- e:
		default:
			delete(s.subs, c)
			close(c.ch)
		}
	}
}

// Last 返回最近发出的 id。
func (s *Stream) Last() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

// Subscription 是一个连接的订阅。
type Subscription struct {
	// Backlog 是要先补发的事件（after 之后、订阅之前的）；Gap 为 true 时补不齐，Backlog 为空。
	Backlog []Entry
	Gap     bool
	// Last 是订阅时刻的最新 id，Gap 时 stream.reset 带这个 id。
	Last int64
	// C 是之后的实时事件；连接太慢被踢或流关闭时关闭。
	C <-chan Entry

	cancel func()
}

// Close 退订，可重复调用。
func (sub *Subscription) Close() { sub.cancel() }

// Subscribe 开一个订阅。hasAfter 为 false 时不补发；否则补发 id 大于 after 的事件，
// after 不在窗口里（早于最旧一条之前、或比最新的还大）时 Gap 为 true。
// 补发和实时事件在同一把锁下切分，中间不会漏也不会重。流已关闭时 C 直接是关闭的。
func (s *Stream) Subscribe(after int64, hasAfter bool) *Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := &sub{ch: make(chan Entry, subBuffer)}
	out := &Subscription{Last: s.last, C: c.ch}
	if hasAfter {
		out.Backlog, out.Gap = s.since(after)
	}
	if s.closed {
		close(c.ch)
		out.cancel = func() {}
		return out
	}
	s.subs[c] = struct{}{}
	var once sync.Once
	out.cancel = func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if _, ok := s.subs[c]; ok {
				delete(s.subs, c)
				close(c.ch)
			}
		})
	}
	return out
}

// since 取 id 大于 after 的事件，调用方持锁。
func (s *Stream) since(after int64) ([]Entry, bool) {
	if after > s.last {
		return nil, true
	}
	if after == s.last {
		return nil, false
	}
	oldest := s.last + 1 // 窗口为空时
	if len(s.buf) > 0 {
		oldest = s.buf[s.start].ID
	}
	// after+1 必须在窗口里，否则中间有丢失
	if after+1 < oldest {
		return nil, true
	}
	out := make([]Entry, 0, s.last-after)
	for i := range len(s.buf) {
		e := s.buf[(s.start+i)%len(s.buf)]
		if e.ID > after {
			out = append(out, e)
		}
	}
	return out, false
}

// Close 关掉所有连接，之后的 Append 丢弃。进程退出时调，让 SSE 连接不拖住 http.Server.Shutdown。
func (s *Stream) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	for c := range s.subs {
		delete(s.subs, c)
		close(c.ch)
	}
}
