// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// providerTestTimeout 是「测试连接」的总超时。这是一次交互式点击，用户在界面上等着，
// 超过十秒就该告诉他连不上，而不是继续挂着。
const providerTestTimeout = 10 * time.Second

// providerTestClient 只服务于探测请求，独立于任何全局默认客户端，超时是硬的。
var providerTestClient = &http.Client{Timeout: providerTestTimeout}

// --- 增删改查 ---

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListProviders(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// createProviderReq 的 api_key 是只写字段：它只会往 store 里去，
// 响应体走的是 store 返回的 domain.AgentProvider，那里只有脱敏串。
type createProviderReq struct {
	Name    string         `json:"name"`
	Kind    string         `json:"kind"`
	BaseURL string         `json:"base_url"`
	Model   string         `json:"model"`
	Enabled *bool          `json:"enabled"`
	APIKey  string         `json:"api_key"`
	Extra   map[string]any `json:"extra"`
}

func (s *Server) handleCreateProvider(w http.ResponseWriter, r *http.Request) {
	var req createProviderReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	// 新建的供应商默认启用：特地建一个再去开一次开关没有意义。
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	// kind 合法性、base_url 默认值、哪种 kind 必须有密钥，全在 store 里判。
	out, err := s.st.CreateProvider(r.Context(), &domain.AgentProvider{
		Name:    req.Name,
		Kind:    req.Kind,
		BaseURL: req.BaseURL,
		Model:   req.Model,
		Enabled: enabled,
		Extra:   req.Extra,
	}, req.APIKey)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	d := providerDetail(out)
	if req.APIKey != "" {
		d["api_key"] = audit.SecretSet
	}
	s.auditConfig(r, "create", "agent_provider", out.ID, "新建服务商 "+out.Name, d)
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	in, err := parseProviderInput(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.UpdateProvider(r.Context(), r.PathValue("id"), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	d := providerDetail(out)
	d["fields"] = givenFields(map[string]bool{
		"name": in.Name != nil, "kind": in.Kind != nil, "base_url": in.BaseURL != nil, "model": in.Model != nil,
		"enabled": in.Enabled != nil, "api_key": in.APIKey != nil, "extra": in.Extra != nil,
	})
	// 密钥只记提示，不记值、长度和脱敏尾号
	if in.APIKey != nil {
		d["api_key"] = audit.SecretUpdated
		if *in.APIKey == "" {
			d["api_key"] = audit.SecretCleared
		}
	}
	s.auditConfig(r, "update", "agent_provider", out.ID, "修改服务商 "+out.Name, d)
	respondData(w, http.StatusOK, out)
}

// providerDetail 是服务商审计的公共字段；刻意不带 api_key_masked。
func providerDetail(p *domain.AgentProvider) map[string]any {
	return map[string]any{"name": p.Name, "kind": p.Kind, "model": p.Model}
}

// parseProviderInput 里 api_key 的三态靠 patchField 的「缺失 -> nil」实现：
// 不传即不改，传空串即清除，传 null 会被拒（免得手滑的 null 静默清掉密钥）。
func parseProviderInput(body []byte) (domain.AgentProviderInput, error) {
	var in domain.AgentProviderInput
	raw, err := patchKeys(body)
	if err != nil {
		return in, err
	}
	if in.Name, err = patchField[string](raw, "name", "a string"); err != nil {
		return in, err
	}
	if in.Kind, err = patchField[string](raw, "kind", "a string"); err != nil {
		return in, err
	}
	if in.BaseURL, err = patchField[string](raw, "base_url", "a string"); err != nil {
		return in, err
	}
	if in.Model, err = patchField[string](raw, "model", "a string"); err != nil {
		return in, err
	}
	if in.Enabled, err = patchField[bool](raw, "enabled", "a boolean"); err != nil {
		return in, err
	}
	if in.APIKey, err = patchField[string](raw, "api_key", "a string"); err != nil {
		return in, err
	}
	if in.Extra, err = patchField[map[string]any](raw, "extra", "a JSON object"); err != nil {
		return in, err
	}
	return in, nil
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	label, d := id, map[string]any{}
	if p, err := s.st.GetProvider(r.Context(), id); err == nil {
		label, d = p.Name, providerDetail(p)
	}
	if err := s.st.DeleteProvider(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "delete", "agent_provider", id, "删除服务商 "+label, d)
	respondData(w, http.StatusOK, nil)
}

// handleSetDefaultProvider 设完再读一次，让前端拿到 is_default 已翻转的那条记录。
func (s *Server) handleSetDefaultProvider(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.st.SetDefaultProvider(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.GetProvider(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "set_default", "agent_provider", id, "设为默认服务商 "+out.Name, providerDetail(out))
	respondData(w, http.StatusOK, out)
}

// --- 测试连接 ---

// handleTestProvider 探测一次上游，顺带把可用模型列表带回来（前端据此做下拉，
// 省得用户手打模型名）。探测本身失败不是 HTTP 错误：连不上是一个正常的业务结果，
// 一律 200 + OK=false，前端只需看 ok 字段。
func (s *Server) handleTestProvider(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, err := s.st.GetProvider(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 明文密钥在这里取出，只往 http.Request 里去，绝不进响应体、日志或错误文本。
	key, err := s.st.ProviderAPIKey(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	res := probeProvider(r.Context(), p, key)
	// 只记分类后的结论和供应商 id：探测用的 URL 里可能带着 key（Gemini 就是这么传的）。
	if !res.OK {
		s.log.Warn("provider test failed", "provider", p.ID, "kind", p.Kind, "reason", res.Message)
	}
	// 结论落库（0046），离开设置页、刷新后卡片仍显示；存失败不影响这次的结果。
	if _, err := s.st.RecordProviderTest(r.Context(), p.ID, *res); err != nil {
		s.log.Warn("provider test not recorded", "provider", p.ID, "err", err)
	}
	respondData(w, http.StatusOK, res)
}

// probeProvider 按 kind 走各自的「列模型」端点：这是四家都有、且只读、
// 又能同时验证「地址对不对」和「密钥认不认」的最轻探针。
func probeProvider(ctx context.Context, p *domain.AgentProvider, key string) *domain.ProviderTestResult {
	if providerNeedsKey(p.Kind) && key == "" {
		return &domain.ProviderTestResult{Message: "尚未配置 API Key"}
	}

	endpoint, headers := probeTarget(p, key)
	ctx, cancel := context.WithTimeout(ctx, providerTestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		// err 里带着完整 URL（含 query 上的 key），只能丢掉，用归类后的说法。
		return &domain.ProviderTestResult{Message: "base_url 不是合法的地址"}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	start := time.Now()
	resp, err := providerTestClient.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return &domain.ProviderTestResult{Latency: latency, Message: transportMessage(ctx, err)}
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode/100 != 2 {
		return &domain.ProviderTestResult{Latency: latency, Message: statusMessage(resp.StatusCode)}
	}

	models, err := decodeModels(p.Kind, resp.Body)
	if err != nil {
		return &domain.ProviderTestResult{
			Latency: latency,
			Message: "连接成功，但返回的内容不是预期的模型列表，请确认 base_url 指向的是兼容端点",
		}
	}
	return &domain.ProviderTestResult{OK: true, Latency: latency, Message: "连接成功", Models: models}
}

// probeTarget 返回探测地址和鉴权头。
// Gemini 的密钥走 query（官方就这么设计），所以这个 URL 本身是敏感的，
// 任何时候都不能出现在返回值、日志或错误里。
func probeTarget(p *domain.AgentProvider, key string) (endpoint string, headers map[string]string) {
	base := strings.TrimRight(p.BaseURL, "/")
	switch p.Kind {
	case domain.ProviderOpenAI:
		return base + "/models", map[string]string{"Authorization": "Bearer " + key}
	case domain.ProviderAnthropic:
		// 默认一页只回 20 个，limit 给到上限，一次拉全。
		return agent.AnthropicEndpoint(base, "/models?limit=1000"),
			map[string]string{"x-api-key": key, "anthropic-version": agent.AnthropicVersion}
	case domain.ProviderGemini:
		return base + "/models?" + url.Values{"key": {key}}.Encode(), nil
	default: // ollama：本机服务，无鉴权
		return base + "/api/tags", nil
	}
}

// transportMessage 把传输层错误归类成人话。原始 error 一律丢弃：
// net/http 的 *url.Error 会把整个请求 URL 拼进 Error()，Gemini 的密钥就在那上面。
func transportMessage(ctx context.Context, err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded:
		return "连接超时（10 秒内未响应）"
	case errors.Is(err, context.Canceled):
		return "请求已取消"
	default:
		return "无法连接到该地址，请检查 base_url 与网络"
	}
}

// statusMessage 只用状态码说话，不碰响应体——上游的错误体常把请求 URL 原样回显。
func statusMessage(code int) string {
	switch {
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return "认证失败，请检查 API Key"
	case code == http.StatusNotFound:
		return "端点不存在，请检查 base_url"
	case code == http.StatusTooManyRequests:
		return "上游限流，请稍后再试"
	case code/100 == 5:
		return "上游服务异常（HTTP " + strconv.Itoa(code) + "）"
	default:
		return "请求被拒绝（HTTP " + strconv.Itoa(code) + "）"
	}
}

// decodeModels 各家的模型列表结构不同：OpenAI 和 Anthropic 是 data[].id，
// Gemini 和 Ollama 都是 models[].name（Gemini 的 name 带 models/ 前缀，去掉后才是模型名）。
func decodeModels(kind string, body io.Reader) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		return nil, err
	}

	out := []string{}
	if kind == domain.ProviderOpenAI || kind == domain.ProviderAnthropic {
		for _, m := range payload.Data {
			if m.ID != "" {
				out = append(out, m.ID)
			}
		}
		return out, nil
	}
	for _, m := range payload.Models {
		name := strings.TrimPrefix(m.Name, "models/")
		if name != "" {
			out = append(out, name)
		}
	}
	return out, nil
}

// providerNeedsKey 与 store 侧同名规则的一份镜像：这里要在发请求前就判掉，
// 不然会拿着空 Bearer 打一次注定 401 的请求。
func providerNeedsKey(kind string) bool { return kind != domain.ProviderOllama }
