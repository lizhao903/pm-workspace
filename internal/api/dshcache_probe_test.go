// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

// dsh headless「跨进程前缀缓存」真实实验（P0 决策依据，见 docs/agent-module-session-cache-design.md）。
//
// 用真实远端 API 跑 4 次独立的 dsh headless 进程，回答一个具体问题：
// 同一 provider / model / workdir 下，两次进程带**相同用户前缀 P**（但任务尾巴不同）时，
// 第二次能不能命中服务商的前缀缓存、命中多少 token；把 P 换成等长的 P2 后命中量是不是回落到
// 只剩「系统提示 + 工具声明」。
//
// 这个测试默认跳过——它会花真实的 API 费用、依赖本机装好的 dsh 和一份库副本：
//
//	DSH_BIN=/path/to/dsh PMW_DSH_CACHE_PROBE=1 PMW_PROBE_DB_DIR=/tmp/pmw-probe \
//	  go test ./internal/api -run TestDSHPrefixCacheProbe -v -count=1 -timeout 15m
//
// 库副本只用于取服务商配置和 API key（vault 解密），不写业务数据、不碰生产库。

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// probeProviderID 是实验用的 NewAPI 服务商（openai 兼容，deepseek-v4-flash）。
const probeProviderID = "apv_06gsny6anhyss4d3"

// probePrefixBody 是公共前缀 P 的主体：一段确定性的中文「模块维护上下文」。
// 它模拟同一模块的维护会话每次执行都会带上的固定前缀（模块名/目录/历史任务摘要/约定）。
// 里面不能出现时间、随机数、真实路径等每次都变的内容——那样前缀就不再稳定，实验就没意义了。
const probePrefixBody = `模块维护上下文（固定前缀，用于验证跨进程前缀缓存命中）：

模块：任务执行器 / DeepSeek Harness 适配层。
目录：internal/runner（模拟目录；本次实验只回答文字问题，不需要读取磁盘，也不修改任何文件）。
职责：把工作台的「把任务交给执行器」翻译成一次 headless 进程调用——生成临时 dsh patch（模型路由、agent-loop、沙箱档位、审批策略、工作台 MCP），从 stdin 喂任务文本，逐行读 --json 事件并回推给界面，收尾时把退出码、输出、会话 id 交回；dsh 的会话日志另外解析 token 用量。
关键约定一：模型密钥只走进程环境，绝不写进 patch 文件，也绝不进命令行；patch 每次执行现生成、跑完即删。
关键约定二：任务文本走 stdin 而不是 argv，避免上下文超长撞上参数长度上限，也避免被系统进程列表看到。
关键约定三：子进程自成一个进程组，取消时按进程组收尾；否则 dsh 拉起的 bash、子 agent、MCP server 会留下孤儿进程继续写盘。
关键约定四：沙箱档位与审批策略恒为一对固定组合（read-only 或 workspace-write 加 never）；两者必须同时改写 permission 预设表，否则 dsh 启动时会因为「组合匹配不到预设」而整条权限插件不激活。
关键约定五：会话 id 从 --json 的 session 事件取回并落到执行记录；续跑时带 --session-id，未知 id 让 dsh 直接失败，不允许悄悄新开一段会话。
历史任务一：给 dsh 执行器补上续跑能力，用 --session-id 沿用同一个持久化会话，并验证续跑后历史只追加、不替换。
历史任务二：核对 dsh headless 的 --json 事件词汇表：session、status、thinking、text、tool_call、tool_result、final、error；不认识的类型必须忽略，版本升级时多一种事件不该让整次执行失败。
历史任务三：从 dsh 持久化会话日志里解析 usage，字段是 inputTokens、outputTokens、totalTokens、cacheReadTokens；其中 inputTokens 是未命中缓存的输入，cacheReadTokens 是命中前缀缓存的输入，两者相加才是全部输入 token。
历史任务四：给执行记录补上用量采集，算每一次执行的缓存命中率：cacheReadTokens 除以「cacheReadTokens 加 inputTokens」，并按任务和模块维度看趋势。
边界说明：本模块不负责服务商的缓存实现，也不判断某次执行值不值得复用会话；它只负责把「这次任务要带哪些固定前缀、哪些动态尾巴」原样拼出来并落库，命中率由上层读用量后计算。
已知未决问题：不同服务商的前缀缓存粒度不同，DeepSeek 走自动磁盘缓存，Anthropic 需要显式缓存断点；本轮实验只验证 DeepSeek 兼容端点上的实际命中量，不覆盖 Anthropic 的缓存语义。
交付口径：实验只回答「跨进程、同前缀能不能命中、命中多少 token」；不回答缓存写成本，也不回答长会话整体复用是否划算，那两条要等命中率先测出来再算。
观察记录：同一 provider、同一 model、同一 workdir、同一套工具声明下，如果系统提示、工具声明与用户消息开头的公共前缀逐字节一致，那么第二次及之后的请求应该能在服务商侧命中前缀缓存，命中量约等于「系统提示 + 工具声明 + 公共前缀」的 token 数；如果把公共前缀整体换掉，命中量应回落到只剩「系统提示 + 工具声明」。本次实验就是验证这条观察。
回答要求：不要调用任何工具；只输出一句简短中文结论，不要分点、不要复述问题、不要展开推理。`

// 任务是尾巴，每次不同；同一个前缀 P 后面接不同任务，模拟同一模块里的不同任务。
const (
	probeTask1 = "任务：用一句话说明，把任务交给 headless 进程后，最需要首先落库的是哪一项信息？"
	probeTask2 = "任务：用一句话说明，计算缓存命中率时，分母应该由哪两部分输入相加得到？"
	probeTask3 = "任务：用一句话说明，为什么换到另一个模型会让同一段历史的前缀缓存失效？"
)

// probeRunResult 记录一次真实执行的结果与解析出的用量。
type probeRunResult struct {
	name      string
	started   time.Time
	sessionID string
	status    string
	output    string
	errMsg    string
	elapsed   time.Duration
	toolCalls []string
	usage     *runner.DSHSessionUsage
	usageErr  error
}

// TestDSHPrefixCacheProbe 是这次实验的主体。不加 PMW_DSH_CACHE_PROBE=1 时跳过，
// 因此不会出现在普通 go test 里，更不会让 CI 依赖外部 API。
func TestDSHPrefixCacheProbe(t *testing.T) {
	if os.Getenv("PMW_DSH_CACHE_PROBE") != "1" {
		t.Skip("真实 dsh 前缀缓存实验默认关闭：设 PMW_DSH_CACHE_PROBE=1 才会跑（会花真实 API 费用）")
	}
	bin := strings.TrimSpace(os.Getenv("DSH_BIN"))
	if bin == "" {
		t.Skip("需要 DSH_BIN 指向 dsh 可执行文件（故意不内置本机路径）")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("DSH_BIN=%s 不可用：%v", bin, err)
	}
	dbDir := strings.TrimSpace(os.Getenv("PMW_PROBE_DB_DIR"))
	if dbDir == "" {
		dbDir = "/tmp/pmw-probe"
	}

	route := probeDshRoute(t, dbDir)
	workdir := t.TempDir()
	r := &runner.Runner{DSHBin: bin, Timeout: 3 * time.Minute}
	t.Logf("dsh=%s", bin)
	t.Logf("workdir=%s", workdir)
	t.Logf("dsh_home=%s", runner.DefaultDSHHome())
	t.Logf("provider=%s kind=%s model=%s base_url=%s", probeProviderID, route.Kind, route.Model, route.BaseURL)

	// 批次号放在 P 的最前面：同一个进程里的 4 轮共用它（前缀完全一致），但重跑实验时
	// 上一轮残留在服务商缓存里的 P 不会把这一轮的 Run1 也「预热」，否则 Run1 的
	// uncached 基线就不准了。这是唯一一个非固定内容，且只影响跨批次的缓存。
	batch := fmt.Sprintf("实验批次：%s（本行只用于避免和上一次实验的缓存串味，四轮共用）。",
		time.Now().Format("20060102-150405.000000000"))
	prefixRun := batch + "\n\n" + probePrefixBody
	prefixControl := probeControlPrefix(prefixRun, batch)
	if prefixRun == prefixControl {
		t.Fatal("对照组前缀和实验组前缀相同，实验设计失效")
	}
	if n := utf8.RuneCountInString(prefixRun); n < 1500 || n > 2500 {
		t.Errorf("公共前缀 P 长度 %d 个字符，期望 ~1500-2500", n)
	}
	t.Logf("公共前缀 P=%d 字符 / %d 字节；对照组前缀 P2 等长、内容不同", utf8.RuneCountInString(prefixRun), len(prefixRun))

	// 4 轮执行。Run2 紧接 Run1（记录「背靠背重复」的真实表现）；Run3 之前留一个缓存
	// 落盘窗口：生产里同一模块的任务通常间隔几分钟，而服务商侧的自动前缀缓存可能是
	// 异步落盘的——第一批实验里紧接上一轮启动的 Run2 首步就没命中，约 9 秒后才命中。
	const settle = 10 * time.Second
	var runs []probeRunResult
	appendRun := func(name, prompt string) {
		if n := len(runs); n > 0 {
			gap := time.Since(runs[n-1].started.Add(runs[n-1].elapsed))
			t.Logf("（%s 距上一轮结束 %.2fs）", name, gap.Seconds())
		}
		runs = append(runs, probeRun(t, r, route, workdir, name, prompt))
	}
	appendRun("run1", prefixRun+"\n\n"+probeTask1)
	appendRun("run2", prefixRun+"\n\n"+probeTask2)
	t.Logf("等待 %s 让服务商侧缓存落盘后再跑 Run3（生产里任务间隔通常更久）", settle)
	time.Sleep(settle)
	appendRun("run3", prefixRun+"\n\n"+probeTask3)
	appendRun("run4-control", prefixControl+"\n\n"+probeTask1)

	// 先逐轮打日志：这是实验的原始数据，断言之前必须能从 go test -v 里读到。
	for i := range runs {
		run := &runs[i]
		t.Logf("---- 第 %d 轮 %s 开始=%s 用时=%s 状态=%s 工具调用=%v",
			i+1, run.name, run.started.Format("15:04:05.000"), run.elapsed, run.status, run.toolCalls)
		if run.sessionID != "" {
			t.Logf("      session_id=%s", run.sessionID)
		}
		if run.output != "" {
			t.Logf("      回答=%q", oneLineForProbe(run.output, 120))
		}
		if run.errMsg != "" {
			t.Logf("      错误=%q", run.errMsg)
		}
		if run.usageErr != nil {
			t.Errorf("第 %d 轮读 dsh 会话用量失败：%v", i+1, run.usageErr)
			continue
		}
		if run.usage == nil {
			continue
		}
		fs := run.usage.FirstStep()
		t.Logf("      首步 cache_read=%d uncached_input=%d output=%d | 全会话 cache_read=%d uncached_input=%d output=%d | 步数=%d 命中率=%.1f%%",
			fs.CacheReadTokens, fs.UncachedInputTokens, fs.OutputTokens,
			run.usage.CacheReadTokens, run.usage.UncachedInputTokens, run.usage.OutputTokens,
			len(run.usage.Steps), run.usage.CacheHitRatio()*100)
	}

	// 执行失败就没法解读用量：直接报出来（会带上 dsh 的失败原因）。
	for i := range runs {
		if runs[i].errMsg != "" {
			t.Fatalf("第 %d 轮 %s 起进程失败：%s", i+1, runs[i].name, runs[i].errMsg)
		}
		if runs[i].status != domain.RunDone {
			t.Fatalf("第 %d 轮 %s 没有正常完成：status=%s error=%q", i+1, runs[i].name, runs[i].status, runs[i].errMsg)
		}
		if runs[i].usageErr != nil || runs[i].usage == nil {
			t.Fatalf("第 %d 轮 %s 没有可解析的用量数据", i+1, runs[i].name)
		}
	}

	// 1) 4 轮的系统提示必须逐字节一致：它是前缀缓存的一部分，不一致就说明 dsh 每轮
	// 都在系统提示里塞了动态内容，跨进程前缀复用从根上就不成立。
	basePrompt := runs[0].usage.SystemPrompt
	if strings.TrimSpace(basePrompt) == "" {
		t.Errorf("Run1 没解析出 SystemPrompt，无法验证系统提示是否稳定")
	}
	for i := 1; i < len(runs); i++ {
		got := runs[i].usage.SystemPrompt
		sumBase := sha256.Sum256([]byte(basePrompt))
		sumGot := sha256.Sum256([]byte(got))
		same := got == basePrompt
		t.Logf("SystemPrompt Run1 vs Run%d: 逐字节一致=%v len=%d/%d sha256=%x/%x",
			i+1, same, len(basePrompt), len(got), sumBase[:8], sumGot[:8])
		if !same {
			t.Errorf("Run%d 的 SystemPrompt 与 Run1 不一致（逐字节比较）：dsh 的系统提示每轮在变，前缀无法稳定复用", i+1)
		}
	}

	// 2) 同一前缀的跨进程复用：Run2 / Run3 至少有一轮首步明显命中 P，且命中量至少是
	// Run1 首步 uncached 的 60%（系统提示 + 工具声明 + P 占大头，尾巴的差异很小）。
	// 为什么是「至少一轮」而不是「两轮都必须」：紧接上一轮结束启动的请求可能赶在
	// 服务商缓存落盘之前（第一批实测如此）。这种情况不判失败，但下面会留痕，
	// 生产里「连续两个任务背靠背」要按冷启动对待。
	uncached1 := runs[0].usage.FirstStep().UncachedInputTokens
	hit1 := runs[0].usage.FirstStep().CacheReadTokens
	hit2 := runs[1].usage.FirstStep().CacheReadTokens
	hit3 := runs[2].usage.FirstStep().CacheReadTokens
	maxHit := hit2
	if hit3 > maxHit {
		maxHit = hit3
	}
	t.Logf("首步 cache_read：Run1=%d（uncached=%d）Run2=%d Run3=%d；同一前缀两轮取最大命中=%d",
		hit1, uncached1, hit2, hit3, maxHit)
	if maxHit <= 0 {
		t.Errorf("Run2/Run3 首步 cache_read 都是 0：同一前缀的跨进程复用不成立（服务商没给缓存命中）")
	}
	if uncached1 > 0 {
		threshold := int(float64(uncached1) * 0.6)
		t.Logf("门槛：≥ Run1 uncached 的 60%% = %d（Run2/3 最大命中 %d）", threshold, maxHit)
		if maxHit < threshold {
			t.Errorf("Run2/Run3 的最大首步 cache_read=%d 低于 Run1 uncached 的 60%%（%d）：前缀命中不足", maxHit, threshold)
		}
	}
	if hit2 == 0 && hit3 > 0 {
		t.Logf("异常/风险：紧接 Run1 结束启动的 Run2 首步 cache_read=0，而 %s 后的 Run3 命中 %d。"+
			"可能是服务商缓存异步落盘有可见延迟，或代理把紧邻请求路由到了不同上游；"+
			"生产里同模块任务间隔通常更久，但连续重活仍应按冷启动预估。", settle, hit3)
	}

	// 3) 对照组 Run4 只应命中「系统提示 + 工具声明」这一小段：首步 cache_read 必须
	// 明显低于 Run2/Run3，且差值约等于 P 的 token 数（说明命中面确实是用户消息前缀 P）。
	hit4 := runs[3].usage.FirstStep().CacheReadTokens
	delta := maxHit - hit4
	t.Logf("对照组 Run4 首步 cache_read=%d；Run2/3 最大=%d；差值=%d（约等于 P 的 token 数）", hit4, maxHit, delta)
	if maxHit > 0 && hit4 >= maxHit {
		t.Errorf("Run4（换了公共前缀）首步 cache_read=%d 不低于 Run2/3 的 %d：命中的不只是用户消息前缀", hit4, maxHit)
	}
	if maxHit > 0 && float64(hit4) > 0.9*float64(maxHit) {
		t.Errorf("Run4 首步 cache_read=%d 与 Run2/3 的 %d 太接近（>90%%）：P 的命中面没有体现出来", hit4, maxHit)
	}
	if maxHit > 0 && delta < 200 {
		t.Errorf("Run4 与 Run2/3 的 cache_read 差值只有 %d token，太小：P 本身可能没进缓存", delta)
	}

	// 4) 全会话汇总也打一遍：如果模型额外调了工具，多步的缓存命中会摊薄首步结论，
	// 这里给出「一次执行整体省了多少」的视角。
	for i := range runs {
		u := runs[i].usage
		t.Logf("汇总 第%d轮 %s: prompt=%d (cache_read=%d + uncached=%d) output=%d ratio=%.1f%%",
			i+1, runs[i].name, u.PromptTokens, u.CacheReadTokens, u.UncachedInputTokens, u.OutputTokens, u.CacheHitRatio()*100)
	}
}

// probeRun 起一次真实 dsh headless 执行，并读回它的会话日志用量。
func probeRun(t *testing.T, r *runner.Runner, route *runner.DeepSeekRoute, workdir, name, prompt string) probeRunResult {
	t.Helper()
	start := time.Now()
	out := probeRunResult{name: name, started: start}
	var tools []string
	res, err := r.Start(context.Background(), runner.Request{
		RunID:    fmt.Sprintf("run_dshcache_%s_%d", name, start.UnixNano()),
		Workdir:  workdir,
		Prompt:   prompt,
		Timeout:  3 * time.Minute,
		Harness:  runner.HarnessDeepSeek,
		DeepSeek: route,
	}, func(ev runner.Event) {
		if ev.Type == runner.EventTool {
			tools = append(tools, ev.Name)
		}
	})
	out.elapsed, out.toolCalls = time.Since(start), tools
	if err != nil {
		out.errMsg = err.Error()
		return out
	}
	out.sessionID, out.status, out.output, out.errMsg = res.SessionID, res.Status, res.Output, res.Error
	if out.sessionID == "" {
		out.usageErr = fmt.Errorf("本次执行没有拿到 session id，读不到会话日志")
		return out
	}
	out.usage, out.usageErr = runner.ReadDSHSessionUsageByID(runner.DefaultDSHHome(), out.sessionID)
	return out
}

// probeDshRoute 从探针库副本里取服务商配置与 API key。只打开副本，不连、不写生产库。
func probeDshRoute(t *testing.T, dbDir string) *runner.DeepSeekRoute {
	t.Helper()
	ctx := context.Background()
	dbPath := filepath.Join(dbDir, "pm.db")
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("探针库副本不存在：%s（%v）；本测试只允许打开 /tmp/pmw-probe 这类副本", dbPath, err)
	}
	st, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("打开探针库副本 %s 失败：%v", dbPath, err)
	}
	t.Cleanup(func() { _ = st.Close() })
	v, _, err := vault.Open(ctx, dbPath, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatalf("打开探针保险箱失败：%v", err)
	}
	t.Cleanup(func() { _ = v.Close() })
	if _, err := st.AttachVault(ctx, v); err != nil {
		t.Fatalf("挂载探针保险箱失败：%v", err)
	}
	p, err := st.GetProvider(ctx, probeProviderID)
	if err != nil {
		t.Fatalf("探针库里没有服务商 %s：%v", probeProviderID, err)
	}
	if !p.Enabled {
		t.Fatalf("服务商 %s（%s）在探针库里是停用的", probeProviderID, p.Name)
	}
	key, err := st.ProviderAPIKey(ctx, probeProviderID)
	if err != nil {
		t.Fatalf("取服务商 %s 的密钥失败：%v", probeProviderID, err)
	}
	if strings.TrimSpace(key) == "" {
		t.Fatalf("服务商 %s 没有可用的 API key", probeProviderID)
	}
	t.Logf("探针库=%s 服务商=%s(%s) key=已取到(%d 字符，不打印内容)", dbPath, p.Name, p.ID, len(key))
	return &runner.DeepSeekRoute{Kind: p.Kind, BaseURL: p.BaseURL, Model: p.Model, APIKey: key}
}

// probeControlPrefix 造一个与 P 等长、内容完全不同的对照组前缀 P2。
//
// 必须把本次实验的批次号也放进 P2：第一批实验里 P2 只按长度生成，于是重跑实验时
// P2 与上一批逐字节相同，Run4 直接命中了上一批留下的 S+P2 缓存，对照组失效。
// 批次号只保证「跨批次不串味」，同一批里的 Run4 仍然是第一次使用这个 P2。
func probeControlPrefix(reference, batch string) string {
	head := []rune("对照组前缀（与实验组等长、内容不同）：" + batch + "\n\n")
	base := []rune("对照组模块上下文：这段文字与实验组的公共前缀逐字不同，用来确认服务商命中的确实是用户消息开头的公共前缀，而不是系统提示或工具声明之外的巧合。它同样是一段确定性的中文材料，不包含时间、路径等每次都会变化的内容；重复到与实验组前缀相同的字数为止。")
	n := utf8.RuneCountInString(reference)
	out := make([]rune, 0, n+len(base))
	out = append(out, head...)
	for len(out) < n {
		out = append(out, base...)
	}
	return string(out[:n])
}

// oneLineForProbe 把模型回答压成一行日志，超长截断。
func oneLineForProbe(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if n := utf8.RuneCountInString(s); n > max {
		return string([]rune(s)[:max]) + "…"
	}
	return s
}
