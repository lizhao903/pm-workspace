// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 真实行情源共用的出网工具（TRD-01b、TRD-01c）：只发 GET、只读公开接口、不带任何 Key。
// 出网客户端由插件在 Register 时注入 Core.HTTP("market-data")，域名清单由内核守着（internal/plugin/network.go）。

// HTTPDoer 回出网客户端；每次请求时现取，权限被收回立刻生效。
type HTTPDoer func(ctx context.Context) (*http.Client, error)

// httpBinder 是要出网的源实现的接口，Register 时接上受控客户端。
type httpBinder interface{ BindHTTP(fn HTTPDoer) }

// connectorSource 是登记了连接器的源：连接器 tool 名和一次连通测试（Test 用）。
type connectorSource interface {
	ConnectorTool() string
	Ping(ctx context.Context) error
}

// UpstreamError 是交易所回的非 2xx 或业务错误码。RateLimited 为真表示被限频（429、418 或交易所的限频错误码）。
type UpstreamError struct {
	Source      string
	Status      int
	Code        string
	Msg         string
	RateLimited bool
	RetryAfter  time.Duration
}

func (e *UpstreamError) Error() string {
	s := fmt.Sprintf("%s 返回 %d", e.Source, e.Status)
	if e.Code != "" {
		s += " " + e.Code
	}
	if e.Msg != "" {
		s += "：" + e.Msg
	}
	if e.RateLimited {
		s += "（被限频）"
	}
	return s
}

// maxUpstreamBody 是一个响应最多读多少；Binance 现货 exchangeInfo 约 2.5MB。
const maxUpstreamBody = 16 << 20

// getJSON 发一个 GET，2xx 时把 body 解进 out；非 2xx 交给 decodeErr 认交易所自己的错误体。
func getJSON(ctx context.Context, doer HTTPDoer, source, url string, out any, decodeErr func(status int, body []byte) error) error {
	if doer == nil {
		return fmt.Errorf("%s 还没接上出网客户端", source)
	}
	hc, err := doer(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "pm-workspace-trade/0.2")
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody+1))
	if err != nil {
		return fmt.Errorf("读 %s 响应失败：%w", source, err)
	}
	if len(body) > maxUpstreamBody {
		return fmt.Errorf("%s 响应超过 %d 字节", source, maxUpstreamBody)
	}
	if resp.StatusCode/100 != 2 {
		e := decodeErr(resp.StatusCode, body)
		var ue *UpstreamError
		if errors.As(e, &ue) {
			if ue.Status == http.StatusTooManyRequests || ue.Status == http.StatusTeapot {
				ue.RateLimited = true
			}
			if ue.RetryAfter == 0 {
				ue.RetryAfter = retryAfter(resp.Header.Get("Retry-After"))
			}
		}
		return e
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("%s 响应不是预期的 JSON：%w", source, err)
	}
	return nil
}

func retryAfter(v string) time.Duration {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(min(n, 3600)) * time.Second
}

// num 把交易所的字符串数字转成 float64；空串、解析失败为 0。
func num(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return f
}

// digitsOf 是步长（tickSize、stepSize）的小数位：0.01000000 -> 2，1 -> 0。
func digitsOf(step string) int {
	s := strings.TrimSpace(step)
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		// 科学计数法少见，按数值算
		f := num(s)
		if f <= 0 {
			return 0
		}
		return max(0, int(math.Ceil(-math.Log10(f)-1e-9)))
	}
	_, frac, ok := strings.Cut(s, ".")
	if !ok {
		return 0
	}
	return len(strings.TrimRight(frac, "0"))
}

// msTime 把毫秒时间戳（数字或字符串）转成 UTC 时间；0 为零值。
func msTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

func msOf(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

// levels 把 [["价","量",...], ...] 转成盘口档位；mult 把量换算成标的币数量（OKX 永续是张数乘面值）。
func levels(raw [][]string, depth int, mult float64) []Level {
	out := make([]Level, 0, min(depth, len(raw)))
	for _, x := range raw {
		if len(out) >= depth {
			break
		}
		if len(x) < 2 {
			continue
		}
		size := num(x[1])
		if mult != 1 {
			// 张数乘面值会带出 6.988300000000001 这种尾巴，按 12 位有效数字收一下
			size, _ = strconv.ParseFloat(strconv.FormatFloat(size*mult, 'g', 12, 64), 64)
		}
		out = append(out, Level{Price: num(x[0]), Size: size})
	}
	return out
}

// codeOf 是 symbol 冒号后的代码：BINANCE:BTCUSDT.P -> BTCUSDT.P。
func codeOf(symbol string) (venue, code string) {
	v, c, _ := strings.Cut(symbol, ":")
	return v, c
}
