package runner

import (
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// Harness 是一次执行交给哪个 agent harness 跑。
//
// 做成一个封闭的枚举，而不是可扩展的注册表：多一个后端就多一套事件口径
// 和一套权限口径，而这两样必须逐条对得上界面（见 Event 的注释）。真要加第三个，
// 它应该在这里显式出现，而不是藏在某个配置项里。
type Harness string

const (
	// HarnessClaude 是本机的 claude CLI，默认值，也是历史行为。
	HarnessClaude Harness = "claude"
	// HarnessDeepSeek 是 deepseek-harness（dsh）的 headless 一次性任务模式：
	// dsh 用 DeepSeek 的模型、自己的工具与沙箱，工作台只负责派单、收事件、留档。
	HarnessDeepSeek Harness = "deepseek"
	// HarnessAgent 是工作台自己的 Agent（TSK-0460）：不起外部进程，由 api 层直接跑 internal/agent 的
	// 工具循环，Runner.Start 不接它。事件照这里的 Event 口径回推，界面上的执行面板不用分两套。
	HarnessAgent Harness = "agent"
)

// ParseHarness 把请求里传来的字符串翻成 Harness，空串按 claude 处理。
//
// 空串给 claude 是为了兼容：加这个字段之前的所有调用方都不传它，
// 它们的行为必须一模一样。
func ParseHarness(s string) (Harness, error) {
	switch h := Harness(strings.TrimSpace(s)); h {
	case "":
		return HarnessClaude, nil
	case HarnessClaude, HarnessDeepSeek, HarnessAgent:
		return h, nil
	default:
		return "", validationErr("不认识执行器「" + string(h) + "」，只能是 claude、deepseek 或 agent")
	}
}

// DeepSeekRoute 是跑 dsh 时的模型路由。
//
// dsh 读不到工作台的 agent_providers，所以每次执行由工作台把服务商翻译成一份
// 临时 patch 交给它（见 writeDSHPatch）。密钥只走进程环境：写进文件会留在磁盘上，
// 放进命令行会被 ps 看见。
type DeepSeekRoute struct {
	// Kind 是服务商的协议（domain.ProviderOpenAI / ProviderAnthropic），
	// 由它决定 patch 里写哪种 wire protocol。
	Kind    string
	BaseURL string
	Model   string
	APIKey  string

	// Profile 是 dsh 的 profile 名，空用 DefaultDSHProfile；Bin 空则走 PATH。
	Profile string
	Bin     string
}

// dshAPI 把服务商的协议翻成 dsh 自定义 provider 的 api 字段。
//
// 只认这两种：dsh 的自定义模型 API 只提供 OpenAI Chat Completions 与
// Anthropic Messages 两种协议。gemini、ollama 这类没有对应协议，
// 与其猜一个近似值让它跑出莫名其妙的错，不如在这里拒绝并说清原因。
func dshAPI(kind string) (string, error) {
	switch kind {
	case domain.ProviderOpenAI:
		return "openai-completions", nil
	case domain.ProviderAnthropic:
		return "anthropic-messages", nil
	}
	return "", validationErr(fmt.Sprintf(
		"执行器 deepseek 不支持「%s」协议的服务商，只能用 OpenAI 兼容（DeepSeek 属于这类）或 Anthropic 的服务商", kind))
}

// Validate 判定这条模型路由能不能用。
//
// 必须在开流之前调：这些错误用户改一下设置就能重试，一旦进了 SSE，
// 它就只剩一条 error 事件，前端拿不到能改的东西的位置。
func (rt *DeepSeekRoute) Validate() error {
	if rt == nil {
		return validationErr(
			"用 deepseek 执行器跑之前，先在设置 > 模型里配一个 DeepSeek（OpenAI 兼容）服务商")
	}
	if strings.TrimSpace(rt.Model) == "" {
		return validationErr("这个服务商没设模型，dsh 不知道跑哪个模型；请在设置 > 模型里补上")
	}
	if strings.TrimSpace(rt.BaseURL) == "" {
		return validationErr("这个服务商没设接口地址；dsh 需要一个 Base URL 才能发请求")
	}
	_, err := dshAPI(rt.Kind)
	return err
}
