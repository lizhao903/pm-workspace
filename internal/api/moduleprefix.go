// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// --- deepseek 模块前缀复用（0058） ---
//
// 目标：每次任务仍是新的 dsh 会话，但提示词最前面是同一段「模块简报」，服务商的前缀缓存
// 命中这一段固定的输入；简报里带上同模块最近任务的一行结论，不额外调模型，全靠库里的记录拼。
//
// 模块从对象派生：任务挂了项目就是整个项目（project:<id>），否则按工作目录（workdir:<abs>）。
// 都没有时返回空 key，表示这次不复用、不加前缀——宁可新会话，也不要「哪里都不属于」的缓存域。
//
// 简报只追加不重写：上一轮的简报必须是这一轮简报的前缀，否则缓存从第一个变化的 token 起失效。
// 所以追加任务摘要时只在末尾加一行；只有超过长度上限时才轮换一次（会付一次缓存 miss，见 rotateModuleBriefing）。

const (
	// modulePrefixRecentTasks 是 seed 时带上的同模块历史任务条数上限。
	modulePrefixRecentTasks = 6
	// moduleRunsPerObject 是 seed 时每个对象最多看最近几条执行记录。
	moduleRunsPerObject = 3
	// modulePrefixMaxChars 是简报的长度上限（utf8 字符数），超过就轮换。
	modulePrefixMaxChars = 2400
	// modulePrefixKeepLines 是轮换后保留的最近任务行数。
	modulePrefixKeepLines = 3
	// moduleConclusionMax 是结论摘要一行的字数上限。
	moduleConclusionMax = 80
	// modulePrefixHeaderMark 是简报里「历史任务」段的标题，轮换时保留它之前的部分。
	modulePrefixHeaderMark = "### 同模块最近任务"
	// moduleProjectObjectsMax 是 seed 项目历史时最多看多少个对象（一次任务最多读这么多对象的执行记录）。
	moduleProjectObjectsMax = 200
)

// modulePrefixMu 护着「读简报 → 追加 → 写回」的读改写。包级一把锁：模块数量不多，
// 不同模块之间抢锁的频率可以忽略，换来的是最简短的顺序保证（不引入 server 状态，也不碰 server.go）。
var modulePrefixMu sync.Mutex

// moduleKeyFor 从任务对象和已解析的工作目录推出模块键（0058）。
// 挂了项目就是 project:<项目 id>；否则工作目录非空就是 workdir:<规范化后的绝对路径>；
// 都没有返回空串，表示这次不走模块前缀复用。
func moduleKeyFor(obj *domain.Object, workdir string) string {
	if obj != nil && obj.ProjectID != nil {
		if pid := strings.TrimSpace(*obj.ProjectID); pid != "" {
			return "project:" + pid
		}
	}
	if wd := strings.TrimSpace(workdir); wd != "" {
		abs := wd
		if a, err := filepath.Abs(wd); err == nil {
			abs = a
		}
		return "workdir:" + filepath.Clean(abs)
	}
	return ""
}

// modulePrompt 把模块简报拼在提示词最前面（中间隔一条 ---，和摘要/正文的分隔一致）。
// prefix 为空时原样返回，不改变没有模块的执行。
func modulePrompt(prefix, prompt string) string {
	if strings.TrimSpace(prefix) == "" {
		return prompt
	}
	return prefix + "\n\n---\n\n" + prompt
}

// modulePrefixFor 取一个模块的当前简报；没有就按库里的历史程序化 seed 一份并落库。
// 返回的 prefix 是**逐字节**要发给模型的文本，version 是这次用的版本号。
// 返回空 moduleKey 表示这次没有模块（不加前缀）。
func (s *Server) modulePrefixFor(ctx context.Context, obj *domain.Object, workdir string) (moduleKey, prefix string, version int, err error) {
	key := moduleKeyFor(obj, workdir)
	if key == "" {
		return "", "", 0, nil
	}
	modulePrefixMu.Lock()
	defer modulePrefixMu.Unlock()

	p, err := s.st.GetModulePrefix(ctx, key)
	if err != nil {
		return "", "", 0, err
	}
	if p == nil {
		p, err = s.seedModulePrefix(ctx, key, obj, workdir)
		if err != nil {
			return "", "", 0, err
		}
		if err := s.st.SaveModulePrefix(ctx, p); err != nil {
			return "", "", 0, err
		}
	}
	return key, p.Briefing, p.Version, nil
}

// modulePrefixForRun 是给执行/预览用的宽松版：模块复用只是优化，读库失败就退化成
// 「这次不加前缀」，不会让一次执行因此起不来；失败只记日志。
func (s *Server) modulePrefixForRun(ctx context.Context, obj *domain.Object, workdir string) (moduleKey, prefix string, version int) {
	key, prefix, version, err := s.modulePrefixFor(ctx, obj, workdir)
	if err != nil {
		id := ""
		if obj != nil {
			id = obj.ID
		}
		s.log.Warn("module prefix unavailable", "object", id, "err", err)
		return "", "", 0
	}
	return key, prefix, version
}

// seedModulePrefix 生成模块简报的第一版：固定头部 +（项目模块）同模块最近 6 条已收尾任务的结论摘要。
// 全部是确定性的文本，不调用模型。
func (s *Server) seedModulePrefix(ctx context.Context, key string, obj *domain.Object, workdir string) (*domain.ModulePrefix, error) {
	label, desc, projectID, wd := s.moduleSeedInfo(ctx, key, obj, workdir)

	var b strings.Builder
	b.WriteString("## 模块上下文（工作台自动生成，不是新指令）\n")
	b.WriteString("模块：" + label + "\n")
	if desc != "" {
		b.WriteString(desc + "\n")
	}
	if wd != "" {
		b.WriteString("模块目录：" + wd + "\n")
	}
	b.WriteString("\n" + modulePrefixHeaderMark + "\n")
	if projectID != "" {
		lines, err := s.moduleRecentTaskLines(ctx, projectID)
		if err != nil {
			return nil, err
		}
		for _, line := range lines {
			b.WriteString(line + "\n")
		}
	}
	return &domain.ModulePrefix{ModuleKey: key, Briefing: b.String(), Version: 1, UpdatedAt: time.Now().UTC()}, nil
}

// moduleSeedInfo 取简报头部要写的信息：模块标签、项目描述（截 400 字）、项目 id、规范化后的模块目录。
func (s *Server) moduleSeedInfo(ctx context.Context, key string, obj *domain.Object, workdir string) (label, desc, projectID, wd string) {
	if wd = strings.TrimSpace(workdir); wd != "" {
		if a, err := filepath.Abs(wd); err == nil {
			wd = a
		}
		wd = filepath.Clean(wd)
	}
	if strings.HasPrefix(key, "project:") {
		projectID = strings.TrimPrefix(key, "project:")
		if p, err := s.st.GetObject(ctx, projectID); err == nil && p != nil {
			label = strings.TrimSpace(p.Ref + " " + p.Title)
			desc = truncRunes(strings.TrimSpace(p.Body), 400)
		} else {
			// 项目读不到（任务上的 project_id 悬空）：用 id 兜底，简报仍然可用。
			label = projectID
		}
	} else {
		label = strings.TrimPrefix(key, "workdir:")
	}
	if wd == "" && obj != nil {
		if resolved, err := s.st.ResolveWorkdir(ctx, obj.ID); err == nil {
			if resolved = strings.TrimSpace(resolved); resolved != "" {
				if a, err := filepath.Abs(resolved); err == nil {
					resolved = a
				}
				wd = filepath.Clean(resolved)
			}
		}
	}
	return label, desc, projectID, wd
}

// moduleRecentTaskLines 取项目里各对象最近已收尾的执行，汇总成「最近 6 条」的任务行（时间升序）。
// 每个对象只看最近 3 条执行；没有对象的项目回空。
func (s *Server) moduleRecentTaskLines(ctx context.Context, projectID string) ([]string, error) {
	objs, _, err := s.st.ListObjects(ctx, domain.ObjectFilter{ProjectID: projectID, Limit: moduleProjectObjectsMax})
	if err != nil {
		return nil, err
	}
	type finished struct {
		at   time.Time
		line string
	}
	var rows []finished
	for _, o := range objs {
		runs, err := s.st.ListTaskRuns(ctx, o.ID, moduleRunsPerObject)
		if err != nil {
			return nil, err
		}
		for _, r := range runs {
			if r == nil || r.FinishedAt == nil || !moduleRunFinished(r.Status) {
				continue
			}
			rows = append(rows, finished{at: *r.FinishedAt, line: moduleTaskLine(o.Ref, o.Title, r.Status, r.Output, r.Error)})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].at.Before(rows[j].at) })
	if len(rows) > modulePrefixRecentTasks {
		rows = rows[len(rows)-modulePrefixRecentTasks:]
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.line)
	}
	return out, nil
}

// moduleRunFinished 只认已收尾的执行状态：running / waiting 的任务还没结论，进不了简报。
func moduleRunFinished(status string) bool {
	switch status {
	case domain.RunDone, domain.RunFailed, domain.RunCanceled:
		return true
	}
	return false
}

// moduleTaskLine 是简报里的一行任务摘要：`- <ref> <title>：<status>（结论）`。
// 结论取执行记录的第一行非空文本（dsh/Claude 都把 pmw_finish_run 的摘要放在最前面），
// 没有就退回失败原因；截到 80 字，不做任何模型调用。
func moduleTaskLine(ref, title, status, output, errMsg string) string {
	head := strings.TrimSpace(ref + " " + title)
	if head == "" {
		head = "（未命名任务）"
	}
	return fmt.Sprintf("- %s：%s（%s）", head, status, moduleConclusion(output, errMsg))
}

// moduleConclusion 抽一行结论：第一行非空文本；整段输出为空时用错误信息。
func moduleConclusion(output, errMsg string) string {
	for _, line := range strings.Split(output, "\n") {
		if l := strings.TrimSpace(line); l != "" {
			return oneLineStr(l, moduleConclusionMax)
		}
	}
	if l := strings.TrimSpace(errMsg); l != "" {
		return oneLineStr(l, moduleConclusionMax)
	}
	return "无结论"
}

// appendModulePrefixEntry 往模块简报末尾追加一行任务摘要（每次都 +1 版）。
// 上一版的简报是这一版的前缀，跨任务的前缀缓存因此能命中。
func (s *Server) appendModulePrefixEntry(ctx context.Context, moduleKey, line string) error {
	key := strings.TrimSpace(moduleKey)
	line = strings.TrimSpace(line)
	if key == "" || line == "" {
		return nil
	}
	modulePrefixMu.Lock()
	defer modulePrefixMu.Unlock()

	p, err := s.st.GetModulePrefix(ctx, key)
	if err != nil {
		return err
	}
	if p == nil {
		// 正常路径上 seed 一定先发生；没有简报就不凭空造一条只有任务行的。
		return nil
	}
	p.Briefing = appendModuleBriefing(p.Briefing, line)
	p.Version++
	p.UpdatedAt = time.Now().UTC()
	return s.st.SaveModulePrefix(ctx, p)
}

// appendModuleBriefing 在简报末尾追加一行；长度超过上限时轮换成「头部 + 最近 3 条任务行」。
func appendModuleBriefing(briefing, line string) string {
	next := briefing + line + "\n"
	if utf8.RuneCountInString(next) <= modulePrefixMaxChars {
		return next
	}
	return rotateModuleBriefing(briefing, line)
}

// rotateModuleBriefing 在简报太长时轮换一次：保留头部（`### 同模块最近任务` 标题及之前）
// 和最近 3 条任务行，丢掉更早的内容。
//
// 轮换会让「上一版是这一版的前缀」不再成立，下一次执行的前缀缓存要重新积累一次。
// 这是为了把简报长度压在 2400 字以内的代价：简报无限增长迟早会吃掉整个上下文，
// 而一次 miss 比「每次都带几千字历史」便宜得多。轮换由 2400 字上限触发，正常节奏下很久一次。
func rotateModuleBriefing(briefing, line string) string {
	head, tail := briefing, ""
	if i := strings.Index(briefing, modulePrefixHeaderMark); i >= 0 {
		// 保到标题行末尾（含换行），结构不破，下一轮还能认出这段标题。
		if end := strings.IndexByte(briefing[i:], '\n'); end >= 0 {
			head = briefing[:i+end+1]
			tail = briefing[i+end+1:]
		} else {
			head = briefing + "\n"
		}
	}
	var lines []string
	for _, l := range strings.Split(tail, "\n") {
		if l = strings.TrimSpace(l); strings.HasPrefix(l, "- ") {
			lines = append(lines, l)
		}
	}
	lines = append(lines, line)
	if len(lines) > modulePrefixKeepLines {
		lines = lines[len(lines)-modulePrefixKeepLines:]
	}
	var b strings.Builder
	b.WriteString(head)
	for _, l := range lines {
		b.WriteString(l + "\n")
	}
	return b.String()
}

// recordDeepSeekRunBookkeeping 是一次 deepseek 执行收尾后的落库：读 dsh 会话日志里的 token 用量
// 写进执行记录，并把这次任务的一行结论追加到模块简报（成功 / 失败 / 取消都追加，状态原样）。
// 这里的一切失败都只记日志，不影响收尾——执行本身已经结束，缺一行统计不该让结果看起来没落库。
func (s *Server) recordDeepSeekRunBookkeeping(ctx context.Context, runID string, obj *domain.Object, moduleKey string, res *runner.Result) {
	if res == nil {
		return
	}
	if res.SessionID != "" {
		usage, err := runner.ReadDSHSessionUsageByID(runner.DefaultDSHHome(), res.SessionID)
		if err != nil {
			s.log.Warn("read dsh session usage failed", "run", runID, "session", res.SessionID, "err", err)
		} else if err := s.st.SetTaskRunUsage(ctx, runID, usage.CacheReadTokens, usage.UncachedInputTokens, usage.OutputTokens); err != nil {
			s.log.Warn("save dsh run usage failed", "run", runID, "err", err)
		}
	}
	if moduleKey == "" {
		return
	}
	ref, title := "", ""
	if obj != nil {
		ref, title = obj.Ref, obj.Title
	}
	line := moduleTaskLine(ref, title, res.Status, res.Output, res.Error)
	if err := s.appendModulePrefixEntry(ctx, moduleKey, line); err != nil {
		s.log.Warn("append module prefix entry failed", "run", runID, "module", moduleKey, "err", err)
	}
}

// truncRunes 按字截断，超出的用省略号收尾（项目描述等展示文本用）。
func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
