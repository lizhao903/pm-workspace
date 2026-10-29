package domains

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 原型联动（DOM-02a）：订阅项目插件的原型启停删事件（插件之间不互读表），
// 运行中的原型和端口记在内存，auto_proto 打开时按名字建自动路由（auto，跟着原型走，原型删了它也删）。
// 服务重启后原型进程都会停，内存表从空开始正好对得上。

const (
	evStarted = "projects.prototype_started"
	evStopped = "projects.prototype_stopped"
	evDeleted = "projects.prototype_deleted"
)

// protoEvent 是项目插件三个事件的载荷。
type protoEvent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	Port        int    `json:"port"`
}

// protoState 是一个原型最近一次事件之后的样子；deleted 留着挡住晚到的启动事件。
type protoState struct {
	ev      protoEvent
	port    int
	running bool
	deleted bool
	at      time.Time
}

// protoTable 是原型的运行情况。事件是异步投递的，先后可能乱，按事件时间只认更新的。
type protoTable struct {
	mu sync.Mutex
	m  map[string]protoState
}

func newProtoTable() *protoTable { return &protoTable{m: map[string]protoState{}} }

// set 记一条事件，比已记的旧就丢掉，返回是否记上了。
func (t *protoTable) set(id string, st protoState) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if old, ok := t.m[id]; ok && st.at.Before(old.at) {
		return false
	}
	t.m[id] = st
	return true
}

// runningEvents 是在运行的原型最近一次启动事件，auto_proto 刚打开时补建路由用。
func (t *protoTable) runningEvents() []protoEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []protoEvent
	for _, st := range t.m {
		if st.running {
			out = append(out, st.ev)
		}
	}
	slices.SortFunc(out, func(a, b protoEvent) int { return strings.Compare(a.ID, b.ID) })
	return out
}

// running 回原型在运行时的端口。
func (t *protoTable) running(id string) (int, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.m[id]
	if !ok || !st.running || st.port <= 0 {
		return 0, false
	}
	return st.port, true
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// slugHost 同原型：名字转小写，非字母数字换成连字符；剩不到两个字符（比如全是中文）用 proto-<端口>。
func slugHost(name string, port int) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 50 {
		s = strings.Trim(s[:50], "-")
	}
	if len(s) < 2 {
		return "proto-" + strconv.Itoa(port)
	}
	return s
}

func decodeProto(e plugin.Event) (protoEvent, error) {
	var ev protoEvent
	if err := json.Unmarshal(e.Payload, &ev); err != nil {
		return ev, fmt.Errorf("%s: %w", e.Type, err)
	}
	if ev.ID == "" {
		return ev, fmt.Errorf("%s: 载荷没有 id", e.Type)
	}
	return ev, nil
}

func (h *handlers) onStarted(ctx context.Context, _ plugin.Core, e plugin.Event) error {
	ev, err := decodeProto(e)
	if err != nil {
		return err
	}
	if !h.p.protos.set(ev.ID, protoState{ev: ev, port: ev.Port, running: true, at: e.At}) {
		return nil
	}
	defer h.p.snap.invalidate()
	return h.ensureAuto(ctx, ev)
}

func (h *handlers) onStopped(_ context.Context, _ plugin.Core, e plugin.Event) error {
	ev, err := decodeProto(e)
	if err != nil {
		return err
	}
	h.p.protos.set(ev.ID, protoState{port: ev.Port, at: e.At})
	return nil
}

func (h *handlers) onDeleted(ctx context.Context, _ plugin.Core, e plugin.Event) error {
	ev, err := decodeProto(e)
	if err != nil {
		return err
	}
	h.p.protos.set(ev.ID, protoState{deleted: true, at: e.At})
	h.p.autoMu.Lock()
	defer h.p.autoMu.Unlock()
	defer h.p.snap.invalidate()
	_, err = h.c.Store().Exec(ctx, `DELETE FROM domains_routes WHERE auto = 1 AND target_kind = 'proto' AND proto_id = ?`, ev.ID)
	return err
}

// ensureAuto：auto_proto 打开、还没有指向这个原型的路由（手动的、自动的、停用的都算）时建一条自动路由。
// 子域名按 slugHost，重名接 -<端口>，再重名接序号。
func (h *handlers) ensureAuto(ctx context.Context, ev protoEvent) error {
	h.p.autoMu.Lock()
	defer h.p.autoMu.Unlock()
	s, err := h.loadSettings(ctx)
	if err != nil || !s.AutoProto {
		return err
	}
	var n int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM domains_routes WHERE target_kind = 'proto' AND proto_id = ?`, ev.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	base := slugHost(ev.Name, ev.Port)
	host := base
	for i := 1; ; i++ {
		taken, err := h.hostTaken(ctx, s, host)
		if err != nil {
			return err
		}
		if !taken {
			break
		}
		switch {
		case i == 1:
			host = base + "-" + strconv.Itoa(ev.Port)
		case i < 100:
			host = base + "-" + strconv.Itoa(ev.Port) + "-" + strconv.Itoa(i)
		default:
			return fmt.Errorf("原型 %s 分不到空闲的子域名", ev.ID)
		}
	}
	note := "自动分配：" + ev.Name
	if ev.ProjectName != "" {
		note = "自动分配：" + ev.ProjectName + " / " + ev.Name
	}
	if r := []rune(note); len(r) > 200 {
		note = string(r[:200])
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = h.c.Store().Exec(ctx, `INSERT INTO domains_routes (`+routeCols+`) VALUES (?, ?, 'proto', ?, '', 1, 1, ?, ?, ?)`,
		idgen.Prefixed("dm"), host, ev.ID, note, now, now)
	return err
}

// hostTaken：别的路由（含停用的）用了这个子域名，或者完整域名和工作台别名撞了。
func (h *handlers) hostTaken(ctx context.Context, s Settings, host string) (bool, error) {
	var n int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM domains_routes WHERE host = ?`, host).Scan(&n); err != nil {
		return false, err
	}
	return n > 0 || contains(s.Aliases, fqdn(host, s.Suffix)), nil
}
