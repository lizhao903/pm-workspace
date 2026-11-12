// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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
	HarnessCodex  Harness = "codex"
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
	case HarnessClaude, HarnessDeepSeek, HarnessCodex, HarnessAgent:
		return h, nil
	default:
		return "", validationErr("不认识执行器「" + string(h) + "」，只能是 claude、deepseek、codex 或 agent")
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
// dsh 的自定义模型 API 只提供 OpenAI Chat Completions 与 Anthropic Messages 两种协议。
// ollama 自带 OpenAI 兼容端点（<地址>/v1），按 OpenAI 兼容接（TSK-0722，地址见 dshBaseURL）；
// gemini 没有对应协议，与其猜一个近似值让它跑出莫名其妙的错，不如在这里拒绝并说清原因。
func dshAPI(kind string) (string, error) {
	switch kind {
	case domain.ProviderOpenAI, domain.ProviderOllama:
		return "openai-completions", nil
	case domain.ProviderAnthropic:
		return "anthropic-messages", nil
	}
	return "", validationErr(fmt.Sprintf(
		"执行器 deepseek 不支持「%s」协议的服务商，只能用 OpenAI 兼容（DeepSeek 属于这类）、Anthropic 或本机 Ollama 的服务商", kind))
}

// DSHCompatible 报告这种协议的服务商能不能交给 dsh（执行器状态、分派弹窗的服务商下拉用）。
func DSHCompatible(kind string) bool {
	_, err := dshAPI(kind)
	return err == nil
}

// dshBaseURL 是交给 dsh 的接口地址。ollama 服务商在工作台里存的是原生地址
// （http://localhost:11434），dsh 走的是它的 OpenAI 兼容端点，要补上 /v1；已经带了就不再补。
func dshBaseURL(kind, base string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if kind == domain.ProviderOllama && base != "" && !strings.HasSuffix(base, "/v1") {
		return base + "/v1"
	}
	return base
}

// DSHInstallHint 是找不到 dsh 时的补救办法（执行器状态、执行失败文案共用，TSK-0722）。
// 不建议全局安装：装到一个固定目录、用 --dsh-bin 或 DSH_BIN 指过去，升级和回退都只动那一个目录。
const DSHInstallHint = "先装 deepseek-harness（npm i --prefix <目录> @deepseek-ai/dsh），再在启动工作台时用 --dsh-bin <目录>/node_modules/.bin/dsh 或环境变量 DSH_BIN 指定；也可以装进 PATH"

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
