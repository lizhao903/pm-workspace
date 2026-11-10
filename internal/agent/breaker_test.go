// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// TSK-0392：服务商挂掉时按服务商熔断，熔断期间不再打出去；到点半开探测一次，通了恢复、不通冷却翻倍；
// 设了「失败时改用」的改用备用服务商。用假的模型服务端（httptest）返回 503 或直接断连。

// fakeModel 是假的 Ollama 服务端：mode 为 down 回 503，drop 直接断连，其余正常回一句话。
type fakeModel struct {
	srv  *httptest.Server
	hits atomic.Int32
	mu   sync.Mutex
	mode string
}

func newFakeModel(t *testing.T, mode, reply string) *fakeModel {
	t.Helper()
	f := &fakeModel{mode: mode}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.mu.Lock()
		m := f.mode
		f.mu.Unlock()
		switch m {
		case "down":
			w.WriteHeader(http.StatusServiceUnavailable)
		case "drop":
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Error("不能断连")
				return
			}
			c, _, _ := hj.Hijack()
			_ = c.Close()
		default:
			_, _ = w.Write([]byte(`{"message":{"content":"` + reply + `"},"done":true}` + "\n"))
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeModel) set(mode string) {
	f.mu.Lock()
	f.mode = mode
	f.mu.Unlock()
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// realService 是真走 HTTP 的 Service（NewChat 为空用 New），重试等待很短，熔断用假时钟。
func realService(t *testing.T) (*Service, *sqlite.Store, *fakeClock) {
	t.Helper()
	s, st, _ := newService(t, nil)
	s.NewChat = nil
	s.RetryDelays = []time.Duration{time.Millisecond, time.Millisecond}
	clk := &fakeClock{t: time.Date(2026, 11, 2, 14, 0, 0, 0, time.UTC)}
	s.Breaker.Now = clk.now
	return s, st, clk
}

func addOllama(t *testing.T, st *sqlite.Store, name, url string, isDefault bool, extra map[string]any) *domain.AgentProvider {
	t.Helper()
	p, err := st.CreateProvider(t.Context(), &domain.AgentProvider{Name: name, Kind: domain.ProviderOllama,
		BaseURL: url, Model: "m0", Enabled: true, IsDefault: isDefault, Extra: extra}, "")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBreakerStopsHammeringDownProvider(t *testing.T) {
	for _, mode := range []string{"down", "drop"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			fm := newFakeModel(t, mode, "恢复了")
			s, st, clk := realService(t)
			p := addOllama(t, st, "NewAPI", fm.srv.URL, true, nil)

			// 来 10 条消息，每条都要调一次：没有熔断时每次打 3 次，一共 30 次
			var last error
			for range 10 {
				_, last = s.Complete(ctx, CompleteRequest{Prompt: "属于哪个项目"})
				if last == nil {
					t.Fatal("服务商挂着应当失败")
				}
			}
			if n := fm.hits.Load(); n > 5 {
				t.Fatalf("连续失败 5 次后应当熔断、不再打出去，实际打了 %d 次", n)
			}
			ue, ok := AsUnavailable(last)
			if !ok || !ue.Open || ue.ProviderID != p.ID || ue.Provider != "NewAPI" || ue.RetryAt.IsZero() {
				t.Fatalf("熔断中应当回服务商不可用并带探测时间：%#v %v", ue, last)
			}
			for _, want := range []string{"「NewAPI」", "熔断", "base_url", "失败时改用", ue.RetryAt.Local().Format("15:04:05")} {
				if !strings.Contains(last.Error(), want) {
					t.Fatalf("熔断原因应写明 %q：%v", want, last)
				}
			}

			// 到探测时间但服务商还没好：只放一次探测，冷却翻倍
			before := fm.hits.Load()
			clk.add(31 * time.Second)
			_, err := s.Complete(ctx, CompleteRequest{Prompt: "x"})
			if fm.hits.Load() != before+1 {
				t.Fatalf("半开只该探测一次：打了 %d 次", fm.hits.Load()-before)
			}
			ue2, ok := AsUnavailable(err)
			if !ok || !ue2.Open || ue2.RetryAt.Sub(clk.now()) != time.Minute {
				t.Fatalf("探测失败应当重新熔断、冷却翻倍到 1 分钟：%#v", ue2)
			}

			// 服务商好了，到点探测通了就恢复
			fm.set("ok")
			clk.add(61 * time.Second)
			out, err := s.Complete(ctx, CompleteRequest{Prompt: "x"})
			if err != nil || out != "恢复了" {
				t.Fatalf("探测通了应当恢复：%q %v", out, err)
			}
			if s.Breaker.Status(p.ID).Open {
				t.Fatal("恢复后不该还在熔断")
			}
		})
	}
}

// 熔断期间改用「失败时改用」的备用服务商，用它自己的模型；原服务商不再打出去。
func TestBreakerFallbackProvider(t *testing.T) {
	ctx := t.Context()
	down := newFakeModel(t, "down", "")
	up := newFakeModel(t, "ok", "备用回的")
	s, st, _ := realService(t)
	fb := addOllama(t, st, "备用", up.srv.URL, false, nil)
	addOllama(t, st, "NewAPI", down.srv.URL, true, map[string]any{FallbackKey: fb.ID})

	for i := range 5 {
		out, err := s.Complete(ctx, CompleteRequest{Prompt: "x", Model: "主服务商的模型"})
		if err != nil || out != "备用回的" {
			t.Fatalf("第 %d 次应当改用备用服务商：%q %v", i+1, out, err)
		}
	}
	if n := down.hits.Load(); n > 5 {
		t.Fatalf("熔断后原服务商不该再打出去：%d 次", n)
	}
	if n := up.hits.Load(); n != 5 {
		t.Fatalf("备用服务商应当每次都用上：%d 次", n)
	}

	// 备用也挂了：回原服务商的不可用，写明备用也没成功
	up.set("down")
	_, err := s.Complete(ctx, CompleteRequest{Prompt: "x"})
	ue, ok := AsUnavailable(err)
	if !ok || ue.Fallback != "备用" || !strings.Contains(err.Error(), "备用服务商「备用」也没成功") {
		t.Fatalf("备用也失败时应当说清楚：%v", err)
	}
}

// 限流、认证失败说明服务商是通的，不计熔断。
func TestBreakerIgnoresNonOutage(t *testing.T) {
	b := &Breaker{}
	for range 20 {
		ok, probe, _, _, _ := b.allow("p")
		if !ok {
			t.Fatal("限流、4xx 不该熔断")
		}
		b.done("p", probe, false, true, "模型服务限流")
		b.done("p", probe, false, false, "模型服务认证失败")
	}
	// 中间有一次成功，连续失败从头算
	for range 4 {
		b.done("p", false, true, false, "503")
	}
	b.done("p", false, false, false, "")
	for range 4 {
		b.done("p", false, true, false, "503")
	}
	if b.Status("p").Open {
		t.Fatal("没连续失败 5 次不该熔断")
	}
}
