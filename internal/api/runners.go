// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 执行器状态（TSK-0722）：GET /api/runners。
//
// 分派弹窗和设置「执行器」页用同一份：每种执行器能不能用、可执行文件在哪、什么版本、缺什么。
// 「缺什么」分两类：blocking 的（没装、没有能用的服务商、没有启用的 Agent）让分派入口置灰；
// 不 blocking 的（工作台 MCP 没接上）只提示，照样能发起，结论写在回复里。
//
// 可执行文件的检测（找路径、跑 --version）结果缓存一分钟：分派弹窗每次打开都会问，
// 每次都起一个 node 进程不划算；设置页的「检测」按钮带 refresh=true 跳过缓存。
// 服务商、Agent 这些库里的东西每次现查，改完设置马上就能看到。

// RunnerProblem 是执行器缺的一样东西。
type RunnerProblem struct {
	// Code：not_installed / broken / no_provider / provider_disabled / no_model / no_agent / no_mcp
	Code    string `json:"code"`
	Message string `json:"message"`
	// Fix 是一句话的修法；Steps 是要照做的几步（命令原文），没有时为空数组。
	Fix   string   `json:"fix"`
	Steps []string `json:"steps"`
	// Blocking 为真时这个执行器不能用，分派入口置灰。
	Blocking bool `json:"blocking"`
}

// RunnerStatus 是一种执行器的状态。
type RunnerStatus struct {
	// Harness：claude / deepseek / agent，同 POST /api/objects/{id}/run 的 harness。
	Harness   string `json:"harness"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
	// Modes 是能用的执行方式：stream（后台）、terminal（切换到终端，还要终端插件在跑，前端判）。
	Modes []string `json:"modes"`
	// Bin 是解析后的可执行文件路径，找不到时是配置的名字；工作台 Agent 不起进程，为空。
	Bin string `json:"bin"`
	// BinSource：flag（启动时指定：dsh 是 --dsh-bin 或 DSH_BIN；claude 目前没有启动参数，只在测试里指定）/ path（走 PATH）/ builtin（工作台自己）。
	BinSource string `json:"bin_source"`
	Version   string `json:"version"`
	// MCP 为真表示这种执行器发起时能接上工作台 MCP 回写进展和结论。
	MCP bool `json:"mcp"`
	// ProviderID / ProviderName / Model：DeepSeek 不指定服务商时默认用哪个、哪个模型；其余为空。
	ProviderID   string          `json:"provider_id"`
	ProviderName string          `json:"provider_name"`
	Model        string          `json:"model"`
	Problems     []RunnerProblem `json:"problems"`
	CheckedAt    time.Time       `json:"checked_at"`
}

// binCacheTTL 是可执行文件检测结果的缓存时间。
const binCacheTTL = time.Minute

type binCacheEntry struct {
	info runner.BinInfo
	at   time.Time
}

// binCache 缓存 DetectBin 的结果，按「执行器 + 配置的名字」记。
type binCache struct {
	mu sync.Mutex
	m  map[string]binCacheEntry
}

func (c *binCache) get(ctx context.Context, key, bin string, refresh bool) (runner.BinInfo, time.Time) {
	c.mu.Lock()
	e, ok := c.m[key+"\x00"+bin]
	c.mu.Unlock()
	if ok && !refresh && time.Since(e.at) < binCacheTTL {
		return e.info, e.at
	}
	info := runner.DetectBin(ctx, bin)
	now := time.Now().UTC()
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]binCacheEntry{}
	}
	c.m[key+"\x00"+bin] = binCacheEntry{info: info, at: now}
	c.mu.Unlock()
	return info, now
}

func (s *Server) handleListRunners(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "true"
	out, err := s.runnerStatuses(r.Context(), refresh)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, out, Meta{Total: len(out), Limit: len(out)})
}

// runnerStatuses 三种执行器按固定顺序：Claude Code、DeepSeek、工作台 Agent。
func (s *Server) runnerStatuses(ctx context.Context, refresh bool) ([]RunnerStatus, error) {
	providers, err := s.st.ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	agents, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	return []RunnerStatus{
		s.claudeStatus(ctx, refresh),
		s.deepseekStatus(ctx, refresh, providers),
		agentStatus(agents, providers, s.opt.Version),
	}, nil
}

// claudeBin / dshBin 取执行器真正会用的那个（Runner 上的，由 --claude-bin、--dsh-bin 或 DSH_BIN 来），
// 检测的和执行的必须是同一个文件。
func (s *Server) claudeBin() (bin, source string) {
	if b := strings.TrimSpace(s.run.Bin); b != "" {
		return b, "flag"
	}
	return runner.DefaultBin, "path"
}

func (s *Server) dshBin() (bin, source string) {
	if b := strings.TrimSpace(s.run.DSHBin); b != "" {
		return b, "flag"
	}
	return runner.DefaultDSHBin, "path"
}

// mcpProblem 是工作台 MCP 接不上时那条不 blocking 的提示；接得上回 nil。
func (s *Server) mcpProblem() *RunnerProblem {
	if err := runner.CheckMCP(s.opt.MCPBin, s.opt.PublicURL); err != nil {
		return &RunnerProblem{Code: "no_mcp", Message: "工作台 MCP 接不上：" + err.Error(),
			Fix: "执行照常发起，进展和结论写在最后的回复里；要回写到任务，先 make build-mcp 或启动时用 --mcp-bin 指定", Steps: []string{}}
	}
	return nil
}

func binProblem(info runner.BinInfo, name, installFix string, steps []string) *RunnerProblem {
	if info.NotFound {
		return &RunnerProblem{Code: "not_installed", Message: "找不到 " + name + " 可执行文件", Fix: installFix, Steps: steps, Blocking: true}
	}
	if info.Err != nil {
		return &RunnerProblem{Code: "broken", Message: name + " --version 跑不通：" + info.Err.Error(),
			Fix: "确认这个可执行文件能在终端里直接运行，或重新安装", Steps: steps, Blocking: true}
	}
	return nil
}

func (s *Server) claudeStatus(ctx context.Context, refresh bool) RunnerStatus {
	bin, src := s.claudeBin()
	info, at := s.bins.get(ctx, "claude", bin, refresh)
	st := RunnerStatus{Harness: string(runner.HarnessClaude), Label: "Claude Code", Modes: []string{domain.RunModeStream, domain.RunModeTerminal},
		Bin: firstNonEmptyStr(info.Path, bin), BinSource: src, Version: info.Version, CheckedAt: at}
	if p := binProblem(info, "claude", "安装 Claude Code，并确认 claude 在启动工作台的那个进程的 PATH 里（工作台按名字找它）", []string{}); p != nil {
		st.Problems = append(st.Problems, *p)
	}
	if p := s.mcpProblem(); p != nil {
		st.Problems = append(st.Problems, *p)
	} else {
		st.MCP = true
	}
	return finishStatus(st)
}

// dshInstallSteps 是 dsh 的安装步骤，和 docs/deepseek-harness.md「二、装 dsh」同一份。
var dshInstallSteps = []string{
	"npm i --prefix ~/.local/share/pmw-dsh @deepseek-ai/dsh",
	"启动工作台时加 --dsh-bin ~/.local/share/pmw-dsh/node_modules/.bin/dsh（或设环境变量 DSH_BIN 为同一路径），重启工作台",
	"到「设置 / 模型服务商」配一个 DeepSeek（OpenAI 兼容，Base URL https://api.deepseek.com，填 API Key 和模型）",
	"回到「设置 / 执行器」点「检测」，再跑一次集成检查",
}

func (s *Server) deepseekStatus(ctx context.Context, refresh bool, providers []*domain.AgentProvider) RunnerStatus {
	bin, src := s.dshBin()
	info, at := s.bins.get(ctx, "deepseek", bin, refresh)
	st := RunnerStatus{Harness: string(runner.HarnessDeepSeek), Label: "DeepSeek", Modes: []string{domain.RunModeStream},
		Bin: firstNonEmptyStr(info.Path, bin), BinSource: src, Version: info.Version, CheckedAt: at}
	if p := binProblem(info, "dsh", runner.DSHInstallHint, dshInstallSteps); p != nil {
		st.Problems = append(st.Problems, *p)
	}
	if p, prob := pickDSHProvider(providers); p != nil {
		st.ProviderID, st.ProviderName, st.Model = p.ID, p.Name, p.Model
		if strings.TrimSpace(p.Model) == "" {
			st.Problems = append(st.Problems, RunnerProblem{Code: "no_model", Message: "服务商「" + p.Name + "」没设模型",
				Fix: "到「设置 / 模型服务商」给它填一个模型，或在分派时指定模型", Steps: []string{}, Blocking: false})
		}
	} else {
		st.Problems = append(st.Problems, *prob)
	}
	if p := s.mcpProblem(); p != nil {
		st.Problems = append(st.Problems, *p)
	} else {
		st.MCP = true
	}
	return finishStatus(st)
}

func agentStatus(agents []*domain.Agent, providers []*domain.AgentProvider, version string) RunnerStatus {
	st := RunnerStatus{Harness: string(runner.HarnessAgent), Label: "工作台 Agent", Modes: []string{domain.RunModeStream},
		BinSource: "builtin", Version: version, MCP: true, CheckedAt: time.Now().UTC()}
	on := 0
	for _, a := range agents {
		if a.Enabled {
			on++
		}
	}
	if on == 0 {
		st.Problems = append(st.Problems, RunnerProblem{Code: "no_agent", Message: "还没有启用的 Agent",
			Fix: "到「设置 / Agent」建一个并启用", Steps: []string{}, Blocking: true})
	}
	enabled := 0
	for _, p := range providers {
		if p.Enabled {
			enabled++
		}
	}
	if enabled == 0 {
		code := "no_provider"
		msg := "还没有模型服务商"
		if len(providers) > 0 {
			code, msg = "provider_disabled", "模型服务商都停用了"
		}
		st.Problems = append(st.Problems, RunnerProblem{Code: code, Message: msg,
			Fix: "到「设置 / 模型服务商」加一个或启用一个", Steps: []string{}, Blocking: true})
	}
	return finishStatus(st)
}

// finishStatus 按有没有 blocking 的问题定 available，并把 nil 切片换成空数组（契约里是数组）。
func finishStatus(st RunnerStatus) RunnerStatus {
	st.Available = true
	for _, p := range st.Problems {
		if p.Blocking {
			st.Available = false
		}
	}
	if st.Problems == nil {
		st.Problems = []RunnerProblem{}
	}
	return st
}

// pickDSHProvider 定 DeepSeek 执行器不指定服务商时用哪个：只看 dsh 能接的协议（OpenAI 兼容、
// Anthropic、Ollama）里启用的；名字、地址或模型里带 deepseek 的优先，其次标了默认的，再次第一个。
// 一个都没有时回 blocking 的问题：一个能接的都没配是 no_provider，有但全停用是 provider_disabled。
func pickDSHProvider(list []*domain.AgentProvider) (*domain.AgentProvider, *RunnerProblem) {
	var usable []*domain.AgentProvider
	compatible := 0
	for _, p := range list {
		if !runner.DSHCompatible(p.Kind) {
			continue
		}
		compatible++
		if p.Enabled {
			usable = append(usable, p)
		}
	}
	if len(usable) == 0 {
		if compatible > 0 {
			return nil, &RunnerProblem{Code: "provider_disabled", Message: "dsh 能用的服务商都停用了",
				Fix: "到「设置 / 模型服务商」启用一个 OpenAI 兼容（DeepSeek）、Anthropic 或 Ollama 的服务商", Steps: []string{}, Blocking: true}
		}
		return nil, &RunnerProblem{Code: "no_provider", Message: "还没有 dsh 能用的服务商（OpenAI 兼容、Anthropic 或 Ollama）",
			Fix: "到「设置 / 模型服务商」加一个 DeepSeek：协议选 OpenAI 兼容，Base URL https://api.deepseek.com，填 API Key 和模型", Steps: []string{}, Blocking: true}
	}
	for _, p := range usable {
		if isDeepSeekProvider(p) {
			return p, nil
		}
	}
	for _, p := range usable {
		if p.IsDefault {
			return p, nil
		}
	}
	return usable[0], nil
}

func isDeepSeekProvider(p *domain.AgentProvider) bool {
	hay := strings.ToLower(p.Name + " " + p.BaseURL + " " + p.Model)
	return strings.Contains(hay, "deepseek")
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
