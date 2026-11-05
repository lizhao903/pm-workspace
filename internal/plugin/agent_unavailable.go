package plugin

import "github.com/lizhao903/pm-workspace/internal/agent"

// 服务商不可用（TSK-0392）：Agent().Complete 遇到服务商熔断中、或重试用完仍是 5xx / 连不上时回这个错误，
// 里面有服务商 id 和名称、原始失败、是否已熔断、下次探测时间。插件可以据此「等服务商恢复后再跑」，不必当成自己的失败。
type ProviderUnavailableError = agent.UnavailableError

// AsProviderUnavailable 取出 err 里的服务商不可用。
func AsProviderUnavailable(err error) (*ProviderUnavailableError, bool) {
	return agent.AsUnavailable(err)
}
