// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package pluginhost 是 P1-a 外部插件宿主：解析/校验清单 v2、安装包（目录 / tar.gz /
// GitHub Release）、管理插件子进程（Unix domain socket + pmw-plugin-rpc/1）、
// 以及插件 → 宿主的 broker 调用。规范见 docs/plugin-spec-v2.md 第 4/5/7 节，
// 团队实施契约见 /tmp/pmw-p1a-brief.md 第 1–4 节。
//
// 宿主进程内不加载任何第三方代码：外部插件只以子进程形式运行，宿主与它之间
// 只有一条本机 socket 上的 JSON-RPC 连接。
package pluginhost

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	// ExternalAPIVersion 是宿主对外的插件 API 版本；清单 api 范围必须包含它。
	ExternalAPIVersion = "2.0.0"
	// ProtocolVersion 是宿主和插件之间的 RPC 协议名，清单 runtime.backend.protocol 固定为它。
	ProtocolVersion = "pmw-plugin-rpc/1"
	// MaxFrameBytes 是单条 JSON-RPC 消息上限（8 MiB），超限断开连接。
	MaxFrameBytes = 8 << 20
	// MaxConcurrentRequests 是每个插件方向允许的并发 in-flight 请求数。
	MaxConcurrentRequests = 8
	// DefaultTimeoutMS 是宿主 → 插件请求的默认超时。
	DefaultTimeoutMS = 30000
)

// Options 是 New 的参数（签名见 brief §2，不得改）。
type Options struct {
	DataDir  string       // <data>（库文件所在目录）；宿主用 <DataDir>/external-plugins/
	DB       *db.DB       // 内核 SQLite（读对象、写状态）
	Version  string       // PMW 版本（--version）
	DevDir   string       // 可选：--plugin-dev-dir，P1 暂只记录
	Logger   *slog.Logger // 空用 slog.Default()
	Notifier Notifier     // 可选

	// HTTPClient 可选：GitHub 来源解析用的 HTTP 客户端；空用带超时的默认客户端。
	// brief §3 建议加这个可注入点，测试用 httptest 的 client。
	HTTPClient *http.Client

	// HealthInterval 是运行期周期健康检查间隔；空用 30s。测试可调短。
	HealthInterval time.Duration

	// CrashBackoffBase 是崩溃重启退避的基数；空用 1s（1s/2s/4s）。测试可调短。
	CrashBackoffBase time.Duration

	// Events 是内核事件总线（internal/events.Bus 满足）：宿主订阅它给外部插件投递
	// plugin.event.deliver，也承接插件 host.events.publish 的发布。为空时不投递/不发布。
	Events EventBus

	// MaxVersions 是每个插件保留的安装包目录数（当前 + 上一版本），空用 2。
	MaxVersions int

	// Mirror 是 GitHub 下载镜像前缀（例 https://ghproxy.example/ 或含 {url} 占位符）。
	// 只改下载地址，不改 commit/SHA-256 校验；为空时直连 GitHub。
	Mirror string

	// Secrets 是内核凭证保险箱（*vault.Vault 满足），给 host.secrets.* 用；为空时这三个方法回 unavailable。
	Secrets SecretStore
}

// EventBus 是宿主需要的事件总线能力（internal/events.Bus 天然满足，测试可 mock）。
type EventBus interface {
	Tap(fn func(plugin.Event)) (cancel func())
	Publish(ctx context.Context, eventType string, payload any) error
}

// Notifier 是宿主通知能力（Options.Notifier 可空；空时 host.notify 回 unavailable）。
type Notifier interface {
	Notify(ctx context.Context, pluginID, title, body string) error
}

// 错误哨兵：API 层用 errors.Is 映射成 HTTP 状态码（brief §2）。
var (
	// ErrNotFound 表示插件/对象/文件不存在。
	ErrNotFound = errors.New("插件不存在")
	// ErrConflict 表示 id 冲突、版本冲突、迁移冲突等状态冲突。
	ErrConflict = errors.New("插件状态冲突")
	// ErrValidation 表示清单/来源/参数不合法。
	ErrValidation = errors.New("插件不合法")
	// ErrIncompatible 表示插件与当前宿主版本或平台不兼容。
	ErrIncompatible = errors.New("插件与当前宿主不兼容")
	// ErrPermission 表示权限未声明或未授予。
	ErrPermission = errors.New("插件权限不足")
	// ErrNotRunning 表示插件没有在运行。
	ErrNotRunning = errors.New("插件未运行")
)

// wrap 给哨兵错误加上可读细节，保留 errors.Is 语义。
func wrap(base error, format string, args ...any) error {
	return fmt.Errorf("%w：%s", base, fmt.Sprintf(format, args...))
}

// Source 是安装来源（brief §2）。
type Source struct {
	Type   string `json:"type"`             // "dir"|"archive"|"github"
	Path   string `json:"path,omitempty"`   // dir 或 tar.gz 的本地绝对路径
	URL    string `json:"url,omitempty"`    // github 资产直链 / release 页 / 仓库页
	SHA256 string `json:"sha256,omitempty"` // 可选，期望的包哈希
}

// PermissionInfo 是安全预览里的一条权限（brief §2）。
type PermissionInfo struct {
	Name    string `json:"name"`
	Reason  string `json:"reason"`
	Risk    string `json:"risk"` // normal|high|separate
	Granted bool   `json:"granted"`
}

// Check 是安全预览里的一条检查项（brief §2）。
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Preview 是 Resolve 的安全预览结果（brief §2）。
type Preview struct {
	Manifest      Manifest         `json:"manifest"`
	Source        Source           `json:"source"`
	PackageSHA256 string           `json:"package_sha256"`
	Platform      string           `json:"platform"` // 例 darwin-arm64
	Entry         string           `json:"entry"`
	WebEntry      string           `json:"web_entry"`
	Compatible    bool             `json:"compatible"`
	Checks        []Check          `json:"checks"`
	Permissions   []PermissionInfo `json:"permissions"`
	Existing      *Info            `json:"existing,omitempty"`
	// Tier 是安装后的信任等级（预览不写 TOFU，只标本次验签结果）。
	Tier string `json:"tier"`
}

// Info 是一个已安装外部插件的状态（brief §2）；API 层直接 JSON 序列化它。
type Info struct {
	ID            string              `json:"id"`
	Name          string              `json:"name"`
	Description   string              `json:"description"`
	Version       string              `json:"version"`
	API           string              `json:"api"`
	PMW           string              `json:"pmw"`
	License       string              `json:"license"`
	Repository    string              `json:"repository"`
	Icon          string              `json:"icon"`
	WebEntry      string              `json:"web_entry"`
	WebStyles     []string            `json:"web_styles,omitempty"`
	Enabled       bool                `json:"enabled"`
	Running       bool                `json:"running"`
	InstalledAt   time.Time           `json:"installed_at"`
	Source        Source              `json:"source"`
	PackageSHA256 string              `json:"package_sha256"`
	Permissions   []string            `json:"permissions"`
	Granted       []string            `json:"granted"`
	Provides      map[string][]string `json:"provides"`
	Error         string              `json:"error,omitempty"`
	InstallDir    string              `json:"install_dir"`
	DataDir       string              `json:"data_dir"`
	// PreviousVersion 非空表示有可回滚的上一版本。
	PreviousVersion string `json:"previous_version,omitempty"`
	// Tier 是信任等级：verified（发布者签名验证通过）/community（未签名）。
	Tier string `json:"tier"`
	// PublisherID 是清单 publisher.id（验签/TOFU 用），没声明时为空。
	PublisherID string `json:"publisher_id,omitempty"`
}

// highRiskPermissions 是安装时不授予、需要装后单独申请的高风险权限。
// 取值见 docs/plugin-spec-v2.md 5.3：fs:write:any / network:any / process:spawn 高风险，
// trade:live 最高（v0.1 外部插件一律不授予）。
var highRiskPermissions = map[string]string{
	"fs:write:any":  "high",
	"network:any":   "high",
	"process:spawn": "high",
	"trade:live":    "separate",
}

// PermissionRisk 返回权限的风险等级：normal|high|separate。
// 未在 v2 权限表里的名字按 normal 处理（清单校验会先把它判非法）。
func PermissionRisk(name string) string {
	if risk, ok := highRiskPermissions[name]; ok {
		return risk
	}
	return "normal"
}

// grantableOnInstall 判断权限能否随安装授予：高风险和单独授权项一律不授予。
func grantableOnInstall(name string) bool {
	_, high := highRiskPermissions[name]
	return !high
}
