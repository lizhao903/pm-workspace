package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/pelletier/go-toml/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// Executor is a saved local executor configuration. Adapter types remain the
// existing runner harnesses; adding a configuration does not add an adapter.
type Executor struct {
	UseCLIConfig bool     `json:"use_cli_config"`
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Bin          string   `json:"bin"`
	Desc         string   `json:"desc"`
	Enabled      bool     `json:"enabled"`
	ProviderID   string   `json:"provider_id"`
	Warnings     []string `json:"warnings,omitempty"`
	ProviderName string   `json:"provider_name,omitempty"`
	Model        string   `json:"model,omitempty"`
}

const executorsKey = "local_executors"

func (s *Server) executors(ctx context.Context) ([]Executor, error) {
	raw, err := s.st.AgentSetting(ctx, executorsKey)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		claude, dsh := strings.TrimSpace(s.opt.ClaudeBin), strings.TrimSpace(s.opt.DSHBin)
		if claude == "" {
			claude = "claude"
		}
		if dsh == "" {
			dsh = "dsh"
		}
		return []Executor{{ID: "exec_claude", Name: "Claude Code", Kind: "claude", Bin: claude, Enabled: true}, {ID: "exec_deepseek", Name: "DeepSeek", Kind: "deepseek", Bin: dsh, Enabled: true}}, nil
	}
	var list []Executor
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("read local executors: %w", err)
	}
	if list == nil {
		list = []Executor{}
	}
	return list, nil
}

func cleanExecutor(e Executor) (Executor, error) {
	e.Name, e.Kind, e.Bin, e.Desc = strings.TrimSpace(e.Name), strings.TrimSpace(e.Kind), strings.TrimSpace(e.Bin), strings.TrimSpace(e.Desc)
	if e.Name == "" || utf8.RuneCountInString(e.Name) > 100 {
		return e, validationf("名称必填，最多 100 字")
	}
	if e.Kind == "" {
		return e, validationf("请选择执行器类型")
	}
	if _, err := runner.ParseHarness(e.Kind); err != nil {
		return e, validationf("执行器类型只支持 claude、deepseek、codex")
	}
	if e.Bin == "" || len(e.Bin) > 4096 || strings.IndexFunc(e.Bin, unicode.IsControl) >= 0 {
		return e, validationf("程序路径必填，最多 4096 字节，不能包含控制字符")
	}
	if !filepath.IsAbs(e.Bin) && (strings.ContainsAny(e.Bin, `/\\`) || strings.IndexFunc(e.Bin, unicode.IsSpace) >= 0) {
		return e, validationf("程序路径请填写绝对路径或 PATH 中的命令名，不要附加命令行参数")
	}
	if utf8.RuneCountInString(e.Desc) > 1000 {
		return e, validationf("说明最多 1000 字")
	}
	e.ProviderID = strings.TrimSpace(e.ProviderID)
	e.Warnings, e.ProviderName, e.Model = nil, "", ""
	if path, err := exec.LookPath(e.Bin); err == nil {
		e.Bin, _ = filepath.Abs(path)
	}
	if !filepath.IsAbs(e.Bin) {
		return e, validationf("请填写程序绝对路径；该命令无法在服务进程 PATH 中找到")
	}
	return e, nil
}

func (s *Server) handleListExecutors(w http.ResponseWriter, r *http.Request) {
	list, err := s.executors(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	out := []Executor{}
	for _, e := range list {
		if q == "" || strings.Contains(strings.ToLower(e.Name+" "+e.Kind+" "+e.Bin+" "+e.Desc), q) {
			out = append(out, s.executorStatus(r.Context(), e))
		}
	}
	respondList(w, out, Meta{Total: len(out)})
}
func (s *Server) handleGetExecutor(w http.ResponseWriter, r *http.Request) {
	list, err := s.executors(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, e := range list {
		if e.ID == r.PathValue("id") {
			respondData(w, 200, s.executorStatus(r.Context(), e))
			return
		}
	}
	s.fail(w, r, notFoundf("执行器不存在"))
}
func (s *Server) saveExecutorList(ctx context.Context, list []Executor) error {
	raw, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return s.st.SetAgentSetting(ctx, executorsKey, raw)
}
func (s *Server) handleWriteExecutor(w http.ResponseWriter, r *http.Request) {
	var input Executor
	if err := decodeBody(r, &input); err != nil {
		s.fail(w, r, err)
		return
	}
	e, err := cleanExecutor(input)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.executorsMu.Lock()
	defer s.executorsMu.Unlock()
	list, err := s.executors(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	index := -1
	creating := r.Method == http.MethodPost
	if creating {
		e.ID = idgen.Prefixed("exec")
	} else {
		e.ID = r.PathValue("id")
		for i, old := range list {
			if old.ID == e.ID {
				index = i
				break
			}
		}
		if index < 0 {
			s.fail(w, r, notFoundf("执行器不存在"))
			return
		}
	}
	for _, old := range list {
		if old.ID != e.ID && strings.EqualFold(old.Name, e.Name) {
			s.fail(w, r, conflictf("执行器名称已存在"))
			return
		}
	}
	if creating {
		if len(list) >= 100 {
			s.fail(w, r, validationf("最多配置 100 个执行器"))
			return
		}
		list = append(list, e)
	} else {
		list[index] = e
	}
	if err := s.saveExecutorList(r.Context(), list); err != nil {
		s.fail(w, r, err)
		return
	}
	action, status := "update", http.StatusOK
	if creating {
		action, status = "create", http.StatusCreated
	}
	s.auditConfig(r, action, "executor", e.ID, "保存执行器 "+e.Name, nil)
	respondData(w, status, e)
}
func (s *Server) handleDeleteExecutor(w http.ResponseWriter, r *http.Request) {
	s.executorsMu.Lock()
	defer s.executorsMu.Unlock()
	list, err := s.executors(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for i, e := range list {
		if e.ID == r.PathValue("id") {
			list = append(list[:i], list[i+1:]...)
			if err := s.saveExecutorList(r.Context(), list); err != nil {
				s.fail(w, r, err)
				return
			}
			s.auditConfig(r, "delete", "executor", e.ID, "删除执行器 "+e.Name, nil)
			respondData(w, 200, nil)
			return
		}
	}
	s.fail(w, r, notFoundf("执行器不存在"))
}

// Status checks never launch executables during list requests.
func (s *Server) executorStatus(ctx context.Context, e Executor) Executor {
	e.Warnings = []string{}
	if !filepath.IsAbs(e.Bin) {
		e.Warnings = append(e.Warnings, "程序路径不是绝对路径")
	}
	if _, err := exec.LookPath(e.Bin); err != nil {
		e.Warnings = append(e.Warnings, "找不到程序或程序不可执行")
	}
	if e.Kind == "codex" && e.UseCLIConfig {
		e.ProviderName = "Codex 本机登录与配置"
		e.Model = "本机默认模型"
		return e
	}
	if e.ProviderID == "" {
		e.Warnings = append(e.Warnings, "未选择模型服务商")
		return e
	}
	p, err := s.st.GetProvider(ctx, e.ProviderID)
	if err != nil {
		e.Warnings = append(e.Warnings, "模型服务商已删除或无法读取")
		return e
	}
	e.ProviderName, e.Model = p.Name, p.Model
	if !p.Enabled {
		e.Warnings = append(e.Warnings, "模型服务商已停用")
	}
	if strings.TrimSpace(p.Model) == "" {
		e.Warnings = append(e.Warnings, "模型服务商未配置模型")
	}
	return e
}

type executorProbe struct {
	BaseURL      string   `json:"base_url,omitempty"`
	ConfigSource string   `json:"config_source,omitempty"`
	Path         string   `json:"path"`
	Version      string   `json:"version"`
	Warnings     []string `json:"warnings"`
}

func (s *Server) probeExecutor(ctx context.Context, e Executor) executorProbe {
	out := executorProbe{Warnings: []string{}}
	if e.Kind == "codex" && e.UseCLIConfig {
		out.BaseURL, out.ConfigSource = localCodexBaseURL()
	}
	path, err := exec.LookPath(strings.TrimSpace(e.Bin))
	if err != nil {
		out.Warnings = append(out.Warnings, "找不到程序或程序不可执行")
		return out
	}
	out.Path, _ = filepath.Abs(path)
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, out.Path, "--version")
	cmd.WaitDelay = 200 * time.Millisecond
	// Bounded capture protects against noisy or broken commands.
	capture := &executorOutput{limit: 4096}
	cmd.Stdout, cmd.Stderr = capture, capture
	if err := cmd.Run(); err != nil {
		out.Warnings = append(out.Warnings, "版本探测失败，请确认程序支持 --version")
		return out
	}
	out.Version = strings.TrimSpace(capture.text)
	if out.Version == "" {
		out.Warnings = append(out.Warnings, "程序未返回版本")
	}
	return out
}

type executorOutput struct {
	text  string
	limit int
}

func (b *executorOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := b.limit - len(b.text)
	if left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		b.text += string(p)
	}
	return n, nil
}
func (s *Server) handleProbeExecutor(w http.ResponseWriter, r *http.Request) {
	var e Executor
	if err := decodeBody(r, &e); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(e.Bin) > 4096 || strings.IndexFunc(e.Bin, unicode.IsControl) >= 0 {
		s.fail(w, r, validationf("程序路径不正确"))
		return
	}
	respondData(w, 200, s.probeExecutor(r.Context(), e))
}
func (s *Server) handleTestExecutor(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Executor Executor `json:"executor"`
		Prompt   string   `json:"prompt"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := decodeBody(r, &input); err != nil {
		s.fail(w, r, err)
		return
	}
	e, err := cleanExecutor(input.Executor)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	status := s.executorStatus(r.Context(), e)
	if len(status.Warnings) > 0 {
		s.fail(w, r, validationf("%s", strings.Join(status.Warnings, "；")))
		return
	}
	if strings.TrimSpace(input.Prompt) == "" || utf8.RuneCountInString(input.Prompt) > 2000 {
		s.fail(w, r, validationf("测试消息必填，最多 2000 字"))
		return
	}
	if len(input.Messages) > 20 {
		s.fail(w, r, validationf("对话最多保留 20 条历史消息，请清空后继续"))
		return
	}
	var history strings.Builder
	for _, m := range input.Messages {
		if (m.Role != "user" && m.Role != "assistant") || utf8.RuneCountInString(m.Content) > 12000 {
			s.fail(w, r, validationf("对话历史格式不正确或消息过长"))
			return
		}
	}
	if len(input.Messages) > 0 {
		raw, _ := json.Marshal(input.Messages)
		history.WriteString("以下是本次测试的历史对话（JSON）：\n")
		history.Write(raw)
		history.WriteString("\n请结合历史回复用户最新消息：\n")
	}
	input.Prompt = history.String() + input.Prompt
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	req, err := s.executorConfigRequest(ctx, e)
	if err != nil {
		s.fail(w, r, validationf("%v", err))
		return
	}
	dir, err := os.MkdirTemp("", "pmw-executor-test-")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer os.RemoveAll(dir)
	req.RunID, req.Workdir, req.Timeout = idgen.Prefixed("probe"), dir, 45*time.Second
	req.Prompt = "这是 CLI 测试对话。仅报告当前上下文确实可见的已加载项目名称，不要猜测；未知项目返回空数组。按用户要求的格式回复，不读取文件、不执行命令、不使用工具。\n" + input.Prompt
	local := runner.Runner{}
	result, err := local.Start(ctx, req, nil)
	if err != nil {
		s.fail(w, r, validationf("%s CLI 测试失败：%v", e.Kind, err))
		return
	}
	if result.Status != domain.RunDone {
		s.fail(w, r, validationf("%s CLI 测试失败：%s", e.Kind, result.Error))
		return
	}
	respondData(w, 200, map[string]string{"reply": result.Output, "model": status.Model})
}

// executorRequest resolves a saved configuration into a per-run snapshot.
func (s *Server) executorRequest(ctx context.Context, id string) (runner.Request, error) {
	list, err := s.executors(ctx)
	if err != nil {
		return runner.Request{}, err
	}
	for _, e := range list {
		if e.ID != id {
			continue
		}
		if !e.Enabled {
			return runner.Request{}, fmt.Errorf("执行器 %s 已停用", e.Name)
		}
		e = s.executorStatus(ctx, e)
		if len(e.Warnings) > 0 {
			return runner.Request{}, fmt.Errorf("执行器 %s：%s", e.Name, strings.Join(e.Warnings, "；"))
		}
		return s.executorConfigRequest(ctx, e)
	}
	return runner.Request{}, fmt.Errorf("执行器 %s 不存在，请重新选择", id)
}

// executorConfigRequest is shared by SOP runs and unsaved editor tests.
func (s *Server) executorConfigRequest(ctx context.Context, e Executor) (runner.Request, error) {
	h, err := runner.ParseHarness(e.Kind)
	if err != nil {
		return runner.Request{}, err
	}
	req := runner.Request{Harness: h}
	var route *runner.DeepSeekRoute
	if !(e.Kind == "codex" && e.UseCLIConfig) {
		p, err := s.resolveProvider(ctx, e.ProviderID)
		if err != nil {
			return req, err
		}
		key, err := s.st.ProviderAPIKey(ctx, p.ID)
		if err != nil {
			return req, err
		}
		route = &runner.DeepSeekRoute{Kind: p.Kind, BaseURL: p.BaseURL, Model: p.Model, APIKey: key, Bin: e.Bin}
	}
	switch h {
	case runner.HarnessCodex:
		if route != nil && route.Kind != domain.ProviderOpenAI {
			return req, fmt.Errorf("Codex 执行器需要 OpenAI 兼容服务商")
		}
		req.CodexBin, req.Codex = e.Bin, route
	case runner.HarnessDeepSeek:
		req.DeepSeek = route
	default:
		if route.Kind != domain.ProviderAnthropic {
			return req, fmt.Errorf("Claude Code 执行器需要 Anthropic 兼容服务商")
		}
		req.ClaudeBin = e.Bin
		req.ClaudeEnv = []string{"ANTHROPIC_BASE_URL=" + route.BaseURL, "ANTHROPIC_API_KEY=" + route.APIKey, "ANTHROPIC_AUTH_TOKEN=" + route.APIKey, "ANTHROPIC_MODEL=" + route.Model}
	}
	return req, nil
}

// handleExecutorCommand previews an unsaved Codex configuration without running it.
func (s *Server) handleExecutorCommand(w http.ResponseWriter, r *http.Request) {
	var e Executor
	if err := decodeBody(r, &e); err != nil {
		s.fail(w, r, err)
		return
	}
	e, err := cleanExecutor(e)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if e.Kind != "codex" {
		s.fail(w, r, validationf("命令预览目前支持 Codex CLI"))
		return
	}
	req, err := s.executorConfigRequest(r.Context(), e)
	if err != nil {
		s.fail(w, r, validationf("%v", err))
		return
	}
	command, err := runner.CodexBash(req, "请列出当前会话实际加载的名称，未知返回空数组。只返回 JSON：{\"skill\":[],\"mcp\":[],\"rag\":[],\"rule\":[]}")
	if err != nil {
		s.fail(w, r, validationf("%v", err))
		return
	}
	respondData(w, 200, map[string]string{"command": command})
}

// localCodexBaseURL reports file configuration only; no credentials are returned.
func localCodexBaseURL() (string, string) {
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", "无法定位本机配置"
		}
		home = filepath.Join(userHome, ".codex")
	}
	path := filepath.Join(home, "config.toml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", path + "（无法读取）"
	}
	var config struct {
		Provider  string `toml:"model_provider"`
		Profile   string `toml:"profile"`
		Providers map[string]struct {
			BaseURL string `toml:"base_url"`
		} `toml:"model_providers"`
		Profiles map[string]struct {
			Provider string `toml:"model_provider"`
		} `toml:"profiles"`
	}
	if err := toml.Unmarshal(raw, &config); err != nil {
		return "", path + "（解析失败）"
	}
	provider := config.Provider
	if p, ok := config.Profiles[config.Profile]; ok && p.Provider != "" {
		provider = p.Provider
	}
	return config.Providers[provider].BaseURL, path
}
