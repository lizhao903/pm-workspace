// Package agent 是工作台对话框的服务端：把三种模型供应商收敛成一个流式接口，
// 挂上一组直接操作 store 的工具，再用一个循环把「模型说话 → 调工具 → 把结果喂回去」串起来。
//
// 这里有意没有引入 agent 框架（eino 等），理由见 doc.go。
package agent

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// Message 是送给模型的一轮内容。Role 复用 domain 的常量，另有 system 这一种
// 只存在于请求里、不落库的角色。
type Message struct {
	Role    string
	Content string

	// ToolCalls 只有 assistant 有：模型决定要调哪些工具。
	ToolCalls []ToolCall
	// ToolCallID / ToolName 只有 tool 有：把执行结果对回是哪一次调用。
	ToolCallID string
	ToolName   string
}

const RoleSystem = "system"

// ToolCall 是模型发起的一次工具调用。Args 保留 JSON 原文而不是解析后的 map：
// 各家对参数的编码不同（OpenAI 是字符串、Ollama 和 Gemini 是对象），
// 统一成原文之后，回填给模型时才能原样带回去。
type ToolCall struct {
	ID   string
	Name string
	Args string
}

// ToolDef 是一个工具的声明。Parameters 是 JSON Schema，三家都认这个格式。
type ToolDef struct {
	Name        string
	Description string
	Parameters  map[string]any
}

type Request struct {
	Model    string
	Messages []Message
	Tools    []ToolDef
}

// EventKind 只有两种：文本增量，和一次完整的工具调用。
// 工具调用不做增量透出——参数是 JSON，拼到一半的 JSON 对调用方没有任何用处。
type EventKind string

const (
	EventDelta    EventKind = "delta"
	EventToolCall EventKind = "tool_call"
)

type Event struct {
	Kind EventKind
	Text string
	Call ToolCall
}

type Chat interface {
	// Stream 发起一次带工具的对话，通过 callback 吐出增量。
	Stream(ctx context.Context, req Request, on func(Event)) error
}

// streamClient 的 Timeout 必须留空：那是「从建连到读完 body」的总时长，
// 对流式响应等同于给整段生成设了硬上限，长回答会在中途被拦腰截断。
// 取消一律交给 ctx，连接与响应头这两段有限的握手则单独设超时。
var streamClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		ResponseHeaderTimeout: 60 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	},
}

// New 按 kind 返回对应的实现。apiKey 到此为止只会进请求头或 query，
// 绝不进返回的 error——上游的错误体常把整个请求 URL 回显出来，Gemini 的密钥就在那上面。
func New(kind, baseURL, apiKey string) (Chat, error) {
	switch kind {
	case domain.ProviderOpenAI:
		return &openAIChat{baseURL: baseURL, apiKey: apiKey}, nil
	case domain.ProviderGemini:
		return &geminiChat{baseURL: baseURL, apiKey: apiKey}, nil
	case domain.ProviderOllama:
		return &ollamaChat{baseURL: baseURL}, nil
	default:
		return nil, fmt.Errorf("不支持的供应商类型 %q", kind)
	}
}

// upstreamError 把上游的失败归类成人话。响应体一概不回显：
// 里面可能带着被原样反射回来的请求 URL 或请求头。
func upstreamError(status int) error {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return fmt.Errorf("模型服务认证失败，请检查该供应商的 API Key")
	case status == http.StatusNotFound:
		return fmt.Errorf("模型服务返回 404，请检查 base_url 与模型名是否正确")
	case status == http.StatusTooManyRequests:
		return fmt.Errorf("模型服务限流，请稍后再试")
	case status/100 == 5:
		return fmt.Errorf("模型服务异常（HTTP %d）", status)
	default:
		return fmt.Errorf("模型服务拒绝了这次请求（HTTP %d）", status)
	}
}

// transportError 同理：net/http 的 *url.Error 会把完整 URL 拼进 Error()，
// 不能直接往上抛。
func transportError(ctx context.Context, err error) error {
	switch {
	case ctx.Err() == context.Canceled:
		return fmt.Errorf("对话已取消")
	case ctx.Err() == context.DeadlineExceeded:
		return fmt.Errorf("模型服务响应超时")
	default:
		return fmt.Errorf("无法连接到模型服务，请检查 base_url 与网络")
	}
}
