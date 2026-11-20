// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 后台执行的权限（TSK-0499）：任务交给 Claude Code 流式执行（claude -p，没人值守）时，
// 放行工作台 MCP 和一份只读命令白名单，按档位再放开文件编辑、测试构建命令、自定义白名单，或交给自动审核（auto）；
// 每一档都传硬拦截清单（内置 + 自定义，--disallowedTools）。
// 档位和白名单的定义在 internal/runner/permissions.go、硬拦截在 deny.go，这里管三件事：
//   - 设置：GET / PUT /api/run-permissions，存在 agent_settings 的 run_permissions 下
//     （{write_profile, custom, deny}）；没设过时写入档位是 accept_edits、自定义白名单和自定义硬拦截为空；
//   - 发起时把请求里的 permission / allow_writes 和角色解析成实际档位、拼 --allowedTools 和 --disallowedTools；
//   - 后台执行经 MCP 回报的结论（pmw_finish_run）先记在内存里，进程退出收尾时放到输出最前面。

const runPermsKey = "run_permissions"

// RunPermissions 是 GET / PUT /api/run-permissions 的响应。
type RunPermissions struct {
	// WriteProfile 是勾「允许写入」时默认选的档位：accept_edits、edits_and_tests、custom 或 auto。
	// SOP 的 Claude Code 节点「可写」时也用它（plugin.RunPerms）。
	WriteProfile string `json:"write_profile"`
	// Custom 是自定义白名单（Claude Code 的权限规则，如 Bash(git commit:*)），在 custom 和 auto 档生效。
	Custom []string `json:"custom"`
	// Deny 是用户自定义的硬拦截（--disallowedTools），每一档都生效，优先于白名单和自动审核。
	Deny []string `json:"deny"`
	// BuiltinDeny 是内置的硬拦截（只读，按组），本实例的数据目录和对外地址已代入；设置里删不掉。
	BuiltinDeny []runner.DenyGroup `json:"builtin_deny"`
	// Profiles 是全部档位和各自实际放行的规则（只读），界面照着展示，不在前端另抄一份。
	Profiles []RunPermProfile `json:"profiles"`
	// MCPServer 是工作台注入的 MCP server 名，每一档都放行它的全部工具。
	MCPServer string `json:"mcp_server"`
}

// RunPermProfile 是一个档位：key、名字、是否放开文件编辑、放行的规则（不含 MCP）。
type RunPermProfile struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Writes  bool     `json:"writes"`
	Allowed []string `json:"allowed"`
}

type runPermsStored struct {
	WriteProfile string   `json:"write_profile"`
	Custom       []string `json:"custom"`
	Deny         []string `json:"deny,omitempty"`
}

func (s *Server) runPerms(ctx context.Context) (runPermsStored, error) {
	out := runPermsStored{WriteProfile: runner.PermAcceptEdits}
	raw, err := s.st.AgentSetting(ctx, runPermsKey)
	if err != nil {
		return out, err
	}
	if len(raw) == 0 {
		return out, nil
	}
	var v runPermsStored
	if err := json.Unmarshal(raw, &v); err != nil {
		s.log.Warn("bad run_permissions setting, using defaults", "err", err)
		return out, nil
	}
	if runner.ValidPerm(v.WriteProfile) && runner.PermWrites(v.WriteProfile) {
		out.WriteProfile = v.WriteProfile
	}
	out.Custom, out.Deny = v.Custom, v.Deny
	return out, nil
}

// denyEnv 是生成内置硬拦截要的本实例信息：数据目录、对外地址。
func (s *Server) denyEnv() runner.DenyEnv {
	return runner.DenyEnv{DataDir: s.opt.DataDir, PublicURL: s.opt.PublicURL}
}

// pluginRunPerms 给插件交给 Claude Code 的运行取全局设置（plugin.SetRunPerms）。
func (s *Server) pluginRunPerms(ctx context.Context) (plugin.RunPerms, error) {
	v, err := s.runPerms(ctx)
	if err != nil {
		return plugin.RunPerms{}, err
	}
	return plugin.RunPerms{WriteProfile: v.WriteProfile, Custom: v.Custom, Deny: v.Deny}, nil
}

func (s *Server) runPermsView(v runPermsStored) RunPermissions {
	out := RunPermissions{WriteProfile: v.WriteProfile, Custom: v.Custom, Deny: v.Deny, MCPServer: runner.MCPServer,
		BuiltinDeny: runner.BuiltinDenyGroups(s.denyEnv())}
	if out.Custom == nil {
		out.Custom = []string{}
	}
	if out.Deny == nil {
		out.Deny = []string{}
	}
	for _, p := range runner.PermProfiles {
		out.Profiles = append(out.Profiles, RunPermProfile{Key: p, Label: runner.PermLabel(p), Writes: runner.PermWrites(p),
			Allowed: runner.PermAllowed(p, v.Custom)})
	}
	return out
}

func (s *Server) handleGetRunPermissions(w http.ResponseWriter, r *http.Request) {
	v, err := s.runPerms(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, s.runPermsView(v))
}

func (s *Server) handlePutRunPermissions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WriteProfile string   `json:"write_profile"`
		Custom       []string `json:"custom"`
		// Deny 不传（null）时保留原来的自定义硬拦截：旧前端不认这个字段，整体替换会把它清掉
		Deny *[]string `json:"deny"`
	}
	if err := decodeBody(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	wp := strings.TrimSpace(body.WriteProfile)
	if wp == "" {
		wp = runner.PermAcceptEdits
	}
	if !runner.ValidPerm(wp) || !runner.PermWrites(wp) {
		s.fail(w, r, validationf("write_profile 只能是 accept_edits、edits_and_tests、custom 或 auto"))
		return
	}
	custom, err := runner.CleanRules(body.Custom)
	if err != nil {
		s.fail(w, r, validationf("%s", err.Error()))
		return
	}
	var deny []string
	if body.Deny != nil {
		if deny, err = runner.CleanDenyRules(*body.Deny); err != nil {
			s.fail(w, r, validationf("硬拦截：%s", err.Error()))
			return
		}
	} else {
		old, err := s.runPerms(r.Context())
		if err != nil {
			s.fail(w, r, err)
			return
		}
		deny = old.Deny
	}
	v := runPermsStored{WriteProfile: wp, Custom: custom, Deny: deny}
	raw, _ := json.Marshal(v)
	if err := s.st.SetAgentSetting(r.Context(), runPermsKey, raw); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "update", "run_permissions", runPermsKey, "修改交给 Claude Code 的执行权限",
		map[string]any{"write_profile": wp, "custom": custom, "deny": nonNil(deny)})
	respondData(w, http.StatusOK, s.runPermsView(v))
}

// projectAllowOf 是任务所属项目的执行白名单（项目档案 run_allow，TSK-0837），经插件钩子问项目插件。
// 任务没挂项目时按这次的工作目录认定项目（TSK-0841 复盘，projectbydir.go），口径同提示词的「所属项目」。
// 没挂项目也认不出、项目插件没装或还没升到 0.20.0（ErrNoProjectRunAllow）、查询出错时回空：辅助信息缺失不能让执行起不来，
// 出错记一条日志。按档位筛（只读只留读规则）由调用方 runner.ProjectAllowFor 做。
func (s *Server) projectAllowOf(ctx context.Context, o *domain.Object, workdir string) []string {
	if o == nil || s.opt.Plugins == nil {
		return nil
	}
	ref := s.runProjectOf(ctx, o, workdir)
	if ref == nil {
		return nil
	}
	rules, err := s.opt.Plugins.ProjectRunAllow(ctx, ref.ID)
	if err != nil {
		if !errors.Is(err, plugin.ErrNoProjectRunAllow) {
			s.log.Warn("list project run allow failed", "project", ref.ID, "err", err)
		}
		return nil
	}
	return rules
}

// effectivePerm 定这次流式执行的档位：permission 给了以它为准，没给按 allow_writes
// （false 只读、true 允许改文件）；只读角色一律压成只读（AUTO-03）。不认识的档位回 400。
func effectivePerm(permission string, allowWrites, roleReadOnly bool) (string, error) {
	p := strings.TrimSpace(permission)
	if p != "" && !runner.ValidPerm(p) {
		return "", validationf("permission 只能是 read_only、accept_edits、edits_and_tests、custom 或 auto")
	}
	if p == "" {
		p = runner.PermReadOnly
		if allowWrites {
			p = runner.PermAcceptEdits
		}
	}
	if roleReadOnly {
		p = runner.PermReadOnly
	}
	return p, nil
}

// --- 后台执行的 MCP 与回报 ---

// streamMCP 给一次后台执行写 MCP 配置：数据目录 tmp/handoff/<执行 id>/mcp.json，执行收尾时删。
// 接不上（没配 MCP 程序、地址或数据目录）时回空路径和原因：执行照跑，提示词写明没接上。
func (s *Server) streamMCP(runID string) (path, reason string, cleanup func()) {
	cleanup = func() {}
	if err := runner.CheckMCP(s.opt.MCPBin, s.opt.PublicURL); err != nil {
		return "", err.Error(), cleanup
	}
	if !safeRunID(runID) {
		return "", "执行 id 不合法", cleanup
	}
	root, err := s.handoffRoot()
	if err != nil {
		return "", "临时目录建不了：" + err.Error(), cleanup
	}
	dir := filepath.Join(root, runID)
	p, err := runner.WriteMCPConfig(dir, strings.TrimSpace(s.opt.MCPBin), s.opt.PublicURL)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "MCP 配置写不了：" + err.Error(), cleanup
	}
	return p, "", func() { _ = os.RemoveAll(dir) }
}

// dshMCP 是交给 DeepSeek（dsh）时的工作台 MCP（TSK-0722）：程序和地址写进 dsh 的 patch，不写文件。
// 接不上时回 nil 和原因，执行照跑，提示词写明没接上。
func (s *Server) dshMCP() (*runner.MCPEndpoint, string) {
	if err := runner.CheckMCP(s.opt.MCPBin, s.opt.PublicURL); err != nil {
		return nil, err.Error()
	}
	return &runner.MCPEndpoint{Bin: strings.TrimSpace(s.opt.MCPBin), API: s.opt.PublicURL}, ""
}

// streamReport 是后台执行经 pmw_finish_run 回报的结论。
type streamReport struct {
	Status  string
	Summary string
}

// streamReports 记还在跑的后台执行的回报，进程退出收尾时取走。
type streamReports struct {
	mu sync.Mutex
	m  map[string]streamReport
}

// put 记下回报；同一次执行只收一次，已经回报过回 false。
func (r *streamReports) put(id string, rep streamReport) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = map[string]streamReport{}
	}
	if _, ok := r.m[id]; ok {
		return false
	}
	r.m[id] = rep
	return true
}

func (r *streamReports) take(id string) (streamReport, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rep, ok := r.m[id]
	delete(r.m, id)
	return rep, ok
}

// applyStreamReport 把回报合进收尾结果：结论放在过程记录前面；进程正常结束、但 Claude Code
// 自己回报做不下去时按失败记（同插件运行的 applyReport）。
func applyStreamReport(res *runner.Result, rep streamReport) {
	if s := strings.TrimSpace(rep.Summary); s != "" {
		res.Output = s + "\n\n---\n\n" + res.Output
	}
	if res.Status == domain.RunDone && rep.Status != "" && rep.Status != domain.RunDone {
		res.Status = rep.Status
		if res.Error == "" {
			res.Error = "Claude Code 回报" + map[string]string{domain.RunFailed: "做不下去", domain.RunCanceled: "已停下"}[rep.Status]
			if s := strings.TrimSpace(rep.Summary); s != "" {
				rs := []rune(s)
				if len(rs) > 300 {
					s = string(rs[:300]) + "…"
				}
				res.Error += "：" + s
			}
		}
	}
}
