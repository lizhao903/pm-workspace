// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// 服务商熔断（TSK-0392）：同一个服务商短时间内连续出服务商级故障（5xx、连不上）后先停一阵，期间直接快速失败、
// 不再打出去；冷却到点后放一次请求过去探测（半开），通了就恢复，不通冷却翻倍（有上限）再等。
// 只认服务商级故障：限流、认证失败、4xx 说明服务商是通的，算成功；调用方自己取消的不计。
// 状态在内存里，按服务商 id 记；服务重启后从头算。

// BreakerConfig 是熔断的几个数，零值用 DefaultBreakerConfig。
type BreakerConfig struct {
	// Threshold 是 Window 内连续失败几次后熔断
	Threshold int
	Window    time.Duration
	// Cooldown 是第一次熔断后等多久探测；探测仍失败翻倍，最多 MaxCooldown
	Cooldown    time.Duration
	MaxCooldown time.Duration
	// ProbeWait 是正在探测时别的调用被挡下后，建议多久再来
	ProbeWait time.Duration
}

// DefaultBreakerConfig：5 分钟内连续 5 次（一次补全最多打 3 次，约两次补全）熔断，30 秒后探测，最长 10 分钟探一次。
var DefaultBreakerConfig = BreakerConfig{Threshold: 5, Window: 5 * time.Minute, Cooldown: 30 * time.Second,
	MaxCooldown: 10 * time.Minute, ProbeWait: 30 * time.Second}

// probeStale 是一次探测过了多久还没回来就当它丢了，再放一次。
const probeStale = 3 * time.Minute

// UnavailableError 是服务商不可用：熔断中被挡下，或者重试用完仍是服务商级故障。
// SOP 等调用方按它判断「等服务商恢复后再跑」，而不是当成这一步本身出错。
type UnavailableError struct {
	ProviderID string
	Provider   string
	// Cause 是最近一次的原始失败，比如「模型服务异常（HTTP 503）」
	Cause string
	// Open 为真表示服务商已经熔断；RetryAt 是下次探测的时间（没熔断时为零值）
	Open    bool
	RetryAt time.Time
	// Fallback 是试过的备用服务商名（也失败了），没有为空
	Fallback string
	msg      string
	cause    error
}

func (e *UnavailableError) Error() string { return e.msg }
func (e *UnavailableError) Unwrap() error { return e.cause }

// AsUnavailable 取出 err 里的服务商不可用。
func AsUnavailable(err error) (*UnavailableError, bool) {
	var u *UnavailableError
	if errors.As(err, &u) {
		return u, true
	}
	return nil, false
}

// Breaker 是按服务商的熔断器，零值可用（DefaultBreakerConfig、time.Now）。
type Breaker struct {
	Config BreakerConfig
	// Now 换掉取当前时间的函数，测试用
	Now func() time.Time

	mu sync.Mutex
	m  map[string]*breakerState
}

type breakerState struct {
	fails    []time.Time // 连续失败的时间，成功就清空
	lastErr  string
	open     bool
	until    time.Time
	cooldown time.Duration
	probing  bool
	probeAt  time.Time
}

func (b *Breaker) cfg() BreakerConfig {
	c := b.Config
	d := DefaultBreakerConfig
	if c.Threshold <= 0 {
		c.Threshold = d.Threshold
	}
	if c.Window <= 0 {
		c.Window = d.Window
	}
	if c.Cooldown <= 0 {
		c.Cooldown = d.Cooldown
	}
	if c.MaxCooldown < c.Cooldown {
		c.MaxCooldown = max(d.MaxCooldown, c.Cooldown)
	}
	if c.ProbeWait <= 0 {
		c.ProbeWait = d.ProbeWait
	}
	return c
}

func (b *Breaker) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

func (b *Breaker) state(id string) *breakerState {
	if b.m == nil {
		b.m = map[string]*breakerState{}
	}
	st := b.m[id]
	if st == nil {
		st = &breakerState{}
		b.m[id] = st
	}
	return st
}

// BreakerStatus 是一个服务商当前的熔断状态。
type BreakerStatus struct {
	Open    bool
	Fails   int
	LastErr string
	RetryAt time.Time
}

// Status 看一个服务商的熔断状态，不改状态。
func (b *Breaker) Status(id string) BreakerStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.m[id]
	if st == nil {
		return BreakerStatus{}
	}
	return BreakerStatus{Open: st.open, Fails: len(st.fails), LastErr: st.lastErr, RetryAt: st.until}
}

// allow 问能不能打出去：没熔断放行；熔断中到了探测时间放一次（probe 为真），其余挡下回 RetryAt。
func (b *Breaker) allow(id string) (ok, probe bool, retryAt time.Time, lastErr string, fails int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state(id)
	if !st.open {
		return true, false, time.Time{}, "", 0
	}
	now := b.now()
	if now.Before(st.until) {
		return false, false, st.until, st.lastErr, len(st.fails)
	}
	if st.probing && now.Sub(st.probeAt) < probeStale {
		return false, false, now.Add(b.cfg().ProbeWait), st.lastErr, len(st.fails)
	}
	st.probing, st.probeAt = true, now
	return true, true, time.Time{}, st.lastErr, len(st.fails)
}

// done 记一次打出去的结果。outage 为真是服务商级故障；neutral 为真（调用方取消）不计，只放掉探测名额。
func (b *Breaker) done(id string, probe, outage, neutral bool, errText string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state(id)
	c := b.cfg()
	now := b.now()
	if probe {
		st.probing = false
	}
	switch {
	case neutral:
		return
	case !outage:
		*st = breakerState{}
		return
	}
	st.lastErr = errText
	if st.open {
		if !probe {
			// 熔断前已经打出去的请求后回来的失败：不改冷却
			return
		}
		st.cooldown = min(st.cooldown*2, c.MaxCooldown)
		st.until = now.Add(st.cooldown)
		return
	}
	keep := st.fails[:0]
	for _, t := range st.fails {
		if now.Sub(t) < c.Window {
			keep = append(keep, t)
		}
	}
	st.fails = append(keep, now)
	if len(st.fails) < c.Threshold {
		return
	}
	st.open, st.cooldown = true, c.Cooldown
	st.until = now.Add(st.cooldown)
}

// guardedChat 把一个服务商的模型客户端包上熔断：熔断中直接回 UnavailableError，打出去的结果计入熔断。
type guardedChat struct {
	inner Chat
	b     *Breaker
	id    string
	name  string
}

func (g *guardedChat) Stream(ctx context.Context, req Request, on func(Event)) error {
	ok, probe, retryAt, lastErr, fails := g.b.allow(g.id)
	if !ok {
		return openError(g.id, g.name, lastErr, fails, retryAt)
	}
	err := g.inner.Stream(ctx, req, on)
	var t transientError
	isT := errors.As(err, &t)
	neutral := err != nil && ctx.Err() != nil
	outage := err != nil && !neutral && isT && t.outage
	if err != nil && isT && !t.outage && !neutral {
		// 限流：服务商是通的但也不算恢复，探测名额放掉、不改状态
		neutral = true
	}
	g.b.done(g.id, probe, outage, neutral, errText(err))
	return err
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// openError 是熔断中被挡下时回的错误，写清哪个服务商、什么错误、什么时候探测、去哪修。
func openError(id, name, lastErr string, fails int, retryAt time.Time) *UnavailableError {
	cause := lastErr
	if cause == "" {
		cause = "服务商级故障"
	}
	return &UnavailableError{ProviderID: id, Provider: name, Cause: cause, Open: true, RetryAt: retryAt,
		msg: fmt.Sprintf("服务商「%s」暂停调用（熔断）：连续 %d 次失败，最后一次是「%s」；%s 自动探测一次，通了就恢复。"+
			"请到 设置 → 模型服务商 检查它的 base_url 能否访问、服务是否启动，或给它设「失败时改用」的备用服务商",
			name, fails, cause, retryAt.Local().Format("15:04:05")),
	}
}
