package sop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// AI 类和外部节点（SOP-01c）：ai 经 Core.Agent() 调节点选的服务商和模型（没选用默认的），extract、classifier、iterate 调默认服务商；
// 这四种节点选了 Agent（config.agent）就用它的服务商、模型、思考档位，指令拼在系统提示前，服务商和模型忽略；
// 都没选时按「其他后台调用」的场景默认 Agent 走（设置 > Agent），那里也没选才用默认服务商。
// knowledge 只搜配置的知识库，agent 按 Agent 的授权跑一轮，http 真发请求；code 不执行。
// 规格见 web-next/docs/spec/sop.md「SPEC-sop-12」15 到 22。

const (
	codeUnsupported = "代码节点暂不支持在后端执行"
	httpBodyMax     = 64 << 10
	httpTimeout     = 30 * time.Second
	iterateMax      = 100
)

// execNode 执行一个节点：要模型、知识库、网络的走这里，其余交给 runNode；im 是流程的触发方式是不是 IM 消息（失败文案要用）。
func execNode(ctx context.Context, c plugin.Core, def stepDef, input Json, deps []string, im bool) nodeResult {
	switch def.Kind {
	case "ai":
		return runAI(ctx, c.Agent(), def, input)
	case "extract":
		return runExtract(ctx, c.Agent(), def, input)
	case "classifier":
		return runClassifier(ctx, c.Agent(), def, input)
	case "iterate":
		return runIterate(ctx, c.Agent(), def, input)
	case "knowledge":
		return runKnowledge(ctx, c.Agent(), def, input)
	case "agent":
		return runAgent(ctx, c.Agent(), def, input)
	case "http":
		// 0.3.0 新增的 network:any 没确认前这一步失败（SEC-01）
		if err := plugin.Require(c, "network:any"); err != nil {
			return nodeResult{err: err.Error()}
		}
		return runHTTP(ctx, def, input)
	case "code":
		return nodeResult{err: codeUnsupported}
	}
	return runNode(def, input, deps, im)
}

// mainText 同原型：指定了字段就取它，否则取输入里最长的那段文字。
func mainText(input Json, field string) string {
	if strings.TrimSpace(field) != "" {
		return txt(getPath(input, field))
	}
	best := ""
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case string:
			if len([]rune(x)) > len([]rune(best)) {
				best = x
			}
		case map[string]any:
			for _, k := range sortedKeys(x) {
				walk(x[k])
			}
		case []any:
			for _, y := range x {
				walk(y)
			}
		}
	}
	walk(input)
	return best
}

func inputJSON(input Json) string {
	b, _ := json.MarshalIndent(input, "", "  ")
	return string(b)
}

func modelErr(err error) string { return "调模型失败：" + err.Error() }

const aiSystem = "你在执行一条标准工作流（SOP）里的一步。按要求处理给你的输入，直接给出结果正文，不要寒暄、不要解释你怎么做的。"

func runAI(ctx context.Context, a plugin.AgentService, def stepDef, input Json) nodeResult {
	key := orDefault(def.Config["output"], "result")
	ask := strings.TrimSpace(render(def.Desc, input))
	if ask == "" {
		ask = def.Name
	}
	out, err := a.Complete(ctx, plugin.CompleteRequest{
		System: aiSystem, Provider: def.Config["provider"], Model: def.Config["model"], Agent: def.Config["agent"],
		Prompt: fmt.Sprintf("这一步：%s\n要求：%s\n\n输入：\n%s", def.Name, ask, inputJSON(input)),
	})
	if err != nil {
		return nodeResult{err: modelErr(err)}
	}
	return nodeResult{output: with(input, key, strings.TrimSpace(out))}
}

var jsonFenceRe = regexp.MustCompile("(?s)```(?:json)?\\s*(.*?)```")

// parseJSONObject 认模型回的 JSON 对象：允许包在 ``` 里、前后有零星文字。
func parseJSONObject(s string) (map[string]any, bool) {
	s = strings.TrimSpace(s)
	if m := jsonFenceRe.FindStringSubmatch(s); m != nil {
		s = strings.TrimSpace(m[1])
	}
	i, j := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if i < 0 || j < i {
		return nil, false
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(s[i:j+1]), &out); err != nil || out == nil {
		return nil, false
	}
	return out, true
}

func runExtract(ctx context.Context, a plugin.AgentService, def stepDef, input Json) nodeResult {
	fields := list(def.Config["fields"])
	if len(fields) == 0 {
		return nodeResult{err: "没有配置要提取的字段"}
	}
	text := mainText(input, def.Config["from"])
	out, err := a.Complete(ctx, plugin.CompleteRequest{
		System: "你从文字里提取字段。只回一个 JSON 对象，不要别的内容。", Agent: def.Config["agent"],
		Prompt: fmt.Sprintf("要提取的字段：%s\n键就用这些字段名，取不到的值填空字符串。\n\n文字：\n%s",
			strings.Join(fields, "、"), text),
	})
	if err != nil {
		return nodeResult{err: modelErr(err)}
	}
	got, ok := parseJSONObject(out)
	if !ok {
		return nodeResult{err: "模型回的不是 JSON 对象，可以重试：" + clipText(out, 200)}
	}
	ext := map[string]any{}
	for _, f := range fields {
		v, has := got[f]
		if !has || v == nil {
			v = ""
		}
		ext[f] = v
	}
	return nodeResult{output: with(input, "extracted", ext)}
}

func runClassifier(ctx context.Context, a plugin.AgentService, def stepDef, input Json) nodeResult {
	if len(def.Cases) == 0 {
		return nodeResult{err: "分类器至少要有一个类别"}
	}
	var b strings.Builder
	for _, c := range def.Cases {
		fmt.Fprintf(&b, "- %s\n", c.Label)
	}
	hint := strings.TrimSpace(def.Config["hint"])
	if hint != "" {
		hint = "\n判断依据：" + hint + "\n"
	}
	out, err := a.Complete(ctx, plugin.CompleteRequest{
		System: "你做分类。只回一个类别名，从给的类别里原样挑一个，不要解释。", Agent: def.Config["agent"],
		Prompt: fmt.Sprintf("类别：\n%s%s\n要分类的文字：\n%s", b.String(), hint, mainText(input, def.Config["from"])),
	})
	if err != nil {
		return nodeResult{err: modelErr(err)}
	}
	got := strings.Trim(strings.TrimSpace(out), "「」\"'。.")
	if c, ok := matchCase(def.Cases, got); ok {
		return nodeResult{output: input, route: c.Key, reason: fmt.Sprintf("模型判断属于「%s」", c.Label)}
	}
	first := def.Cases[0]
	return nodeResult{output: input, route: first.Key,
		reason: fmt.Sprintf("模型回的「%s」不在分支里，归到第一类「%s」", clipText(got, 40), first.Label)}
}

// matchCase 先按类别名、key 整个对上，再看回复里有没有包含某个类别名（取最长的那个）。
func matchCase(cases []Case, got string) (Case, bool) {
	for _, c := range cases {
		if got == c.Label || got == c.Key {
			return c, true
		}
	}
	best := -1
	for i, c := range cases {
		if c.Label != "" && strings.Contains(got, c.Label) && (best < 0 || len(c.Label) > len(cases[best].Label)) {
			best = i
		}
	}
	if best < 0 {
		return Case{}, false
	}
	return cases[best], true
}

func runIterate(ctx context.Context, a plugin.AgentService, def stepDef, input Json) nodeResult {
	field := def.Config["list"]
	items, ok := getPath(input, field).([]any)
	if !ok {
		return nodeResult{err: fmt.Sprintf("输入里的「%s」不是列表", orDefault(field, "未填"))}
	}
	if len(items) > iterateMax {
		return nodeResult{err: fmt.Sprintf("列表有 %d 项，一次最多 %d 项", len(items), iterateMax)}
	}
	action := strings.TrimSpace(def.Config["action"])
	results := make([]any, 0, len(items))
	for i, item := range items {
		if ctx.Err() != nil {
			return nodeResult{err: "执行被取消"}
		}
		out, err := a.Complete(ctx, plugin.CompleteRequest{
			System: aiSystem, Agent: def.Config["agent"],
			Prompt: fmt.Sprintf("对列表里的这一项做这件事：%s\n\n这是第 %d 项，共 %d 项：\n%s", action, i+1, len(items), txt(item)),
		})
		if err != nil {
			return nodeResult{err: fmt.Sprintf("第 %d 项%s", i+1, modelErr(err))}
		}
		results = append(results, map[string]any{"item": item, "result": strings.TrimSpace(out)})
	}
	return nodeResult{output: with(input, "results", results), log: fmt.Sprintf("处理了 %d 项", len(items))}
}

func runKnowledge(ctx context.Context, a plugin.AgentService, def stepDef, input Json) nodeResult {
	kbs := list(def.Config["kbs"])
	if len(kbs) == 0 {
		return nodeResult{err: "没有配置要检索的知识库"}
	}
	q := strings.TrimSpace(render(def.Config["query"], input))
	if q == "" {
		return nodeResult{err: "检索问题是空的"}
	}
	top, err := strconv.Atoi(strings.TrimSpace(def.Config["top_k"]))
	if err != nil || top <= 0 {
		top = 3
	}
	hits, err := a.SearchKB(ctx, kbs, q, top)
	if err != nil {
		return nodeResult{err: "检索失败：" + err.Error()}
	}
	matches := make([]any, 0, len(hits))
	for _, h := range hits {
		matches = append(matches, map[string]any{
			"kb_id": h.KbID, "doc_id": h.DocID, "title": h.Title, "index": h.Index,
			"score": h.Score, "snippet": h.Text,
		})
	}
	out := with(input, "query", q)
	out["matches"] = matches
	return nodeResult{output: out, log: fmt.Sprintf("在 %s 里找到 %d 段", strings.Join(kbs, "、"), len(hits))}
}

/* ---------- 调用 Agent ---------- */

// agentState 是 agent 节点记在输出 agent 字段里的会话信息，停下等确认后据此看会话有没有新回复。
type agentState struct {
	SessionID string `json:"session_id"`
	MessageID string `json:"message_id"`
	AgentID   string `json:"agent_id"`
	Name      string `json:"name"`
	Status    string `json:"status"` // waiting / done
	// CallIDs 是停下时待确认调用的 id，前端可以直接拿去确认
	CallIDs []string `json:"call_ids,omitempty"`
}

const agentWaitLog = "等你在会话里确认"

func runAgent(ctx context.Context, a plugin.AgentService, def stepDef, input Json) nodeResult {
	task := strings.TrimSpace(render(def.Config["prompt"], input))
	if task == "" {
		task = orDefault(strings.TrimSpace(render(def.Desc, input)), def.Name)
	}
	res, err := a.RunAgent(ctx, plugin.AgentRunRequest{
		Agent:  def.Config["agent"],
		Title:  "SOP · " + def.Name,
		Prompt: fmt.Sprintf("%s\n\n这一步的输入：\n%s", task, inputJSON(input)),
	})
	if err != nil {
		return nodeResult{err: "调用 Agent 失败：" + err.Error()}
	}
	st := agentState{SessionID: res.SessionID, MessageID: res.MessageID, AgentID: res.AgentID, Name: res.AgentName, Status: "done"}
	if res.Waiting {
		st.Status, st.CallIDs = "waiting", res.CallIDs
		return nodeResult{output: with(input, "agent", st.json()), review: true,
			log: fmt.Sprintf("Agent「%s」要调用需确认的工具（%s），%s", res.AgentName, res.Pending, agentWaitLog)}
	}
	return agentDone(input, st, res.Reply)
}

func agentDone(input Json, st agentState, reply string) nodeResult {
	st.Status, st.CallIDs = "done", nil
	out := with(input, "agent", st.json())
	out["agent_reply"] = reply
	return nodeResult{output: out}
}

func (s agentState) json() map[string]any {
	m := map[string]any{"session_id": s.SessionID, "message_id": s.MessageID, "agent_id": s.AgentID, "name": s.Name, "status": s.Status}
	if len(s.CallIDs) > 0 {
		ids := make([]any, len(s.CallIDs))
		for i, id := range s.CallIDs {
			ids[i] = id
		}
		m["call_ids"] = ids
	}
	return m
}

// waitingAgent 从停下的 agent 步骤的输出里取会话信息，不是在等确认的回 false。
func waitingAgent(def stepDef, s RunStep) (agentState, bool) {
	if def.Kind != "agent" || s.Status != stReview {
		return agentState{}, false
	}
	m, _ := s.Output["agent"].(map[string]any)
	st := agentState{}
	st.SessionID, _ = m["session_id"].(string)
	st.MessageID, _ = m["message_id"].(string)
	st.AgentID, _ = m["agent_id"].(string)
	st.Name, _ = m["name"].(string)
	st.Status, _ = m["status"].(string)
	return st, st.Status == "waiting" && st.SessionID != ""
}

// watchAgent 每隔 every 看一次会话，出了不再等确认的新回复就回结果；ctx 取消时回 false。
func watchAgent(ctx context.Context, a plugin.AgentService, input Json, st agentState, every time.Duration) (nodeResult, bool) {
	last := st.MessageID
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nodeResult{}, false
		case <-t.C:
		}
		cur, err := a.AgentState(ctx, st.SessionID)
		if err != nil || cur.MessageID == "" || cur.MessageID == last {
			continue
		}
		last = cur.MessageID
		if cur.Waiting {
			continue
		}
		st.MessageID = cur.MessageID
		return agentDone(input, st, cur.Reply), true
	}
}

/* ---------- HTTP 请求 ---------- */

var httpMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE"}

var secretName = regexp.MustCompile(`(?i)auth|token|secret|key|password|passwd|cookie|signature|credential|session`)

// maskHeader 凭证类请求头的值打码。
func maskHeader(name, value string) string {
	if secretName.MatchString(name) {
		return "***"
	}
	return value
}

// maskURL 去掉地址里的用户名密码，凭证类查询参数打码。
func maskURL(u *url.URL) string {
	c := *u
	if c.User != nil {
		c.User = url.User("***")
	}
	q := c.Query()
	changed := false
	for k := range q {
		if secretName.MatchString(k) {
			q.Set(k, "***")
			changed = true
		}
	}
	if changed {
		c.RawQuery = strings.ReplaceAll(q.Encode(), "%2A%2A%2A", "***")
	}
	return c.String()
}

var httpClient = &http.Client{Timeout: httpTimeout}

func runHTTP(ctx context.Context, def stepDef, input Json) nodeResult {
	cfg := def.Config
	method := strings.ToUpper(strings.TrimSpace(orDefault(cfg["method"], "POST")))
	if !slices.Contains(httpMethods, method) {
		return nodeResult{err: fmt.Sprintf("不支持的请求方法 %s", method)}
	}
	raw := strings.TrimSpace(render(cfg["url"], input))
	if raw == "" {
		return nodeResult{err: "没有配置请求地址"}
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nodeResult{err: fmt.Sprintf("请求地址「%s」不对，要以 http:// 或 https:// 开头", clipText(raw, 80))}
	}
	shown := maskURL(u)
	body := render(cfg["body"], input)
	if len(body) > httpBodyMax {
		return nodeResult{err: fmt.Sprintf("请求体有 %d 字节，超过 64KB", len(body))}
	}
	var rd io.Reader
	if strings.TrimSpace(body) != "" && method != "GET" {
		rd = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return nodeResult{err: "建请求失败"}
	}
	var shownHeaders []string
	for _, line := range strings.Split(render(cfg["headers"], input), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if !ok || k == "" {
			return nodeResult{err: fmt.Sprintf("请求头「%s」写法不对，要写成「名称: 值」", clipText(maskHeader(line, line), 60))}
		}
		req.Header.Add(k, v)
		shownHeaders = append(shownHeaders, k+": "+maskHeader(k, v))
	}
	if rd != nil && req.Header.Get("Content-Type") == "" && json.Valid([]byte(body)) {
		req.Header.Set("Content-Type", "application/json")
	}
	head := method + " " + shown
	if len(shownHeaders) > 0 {
		head += "，请求头 " + strings.Join(shownHeaders, "；")
	}
	start := time.Now()
	resp, err := httpClient.Do(req)
	if err != nil {
		why := "连不上对方"
		if ctx.Err() != nil {
			why = "执行被取消"
		} else if strings.Contains(err.Error(), "Client.Timeout") {
			why = fmt.Sprintf("对方 %d 秒没有响应", int(httpTimeout.Seconds()))
		}
		return nodeResult{err: why + "，可以重试", log: head}
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, httpBodyMax+1))
	truncated := len(b) > httpBodyMax
	if truncated {
		b = b[:httpBodyMax]
	}
	var got any = string(b)
	if !truncated && json.Valid(b) && len(bytes.TrimSpace(b)) > 0 {
		_ = json.Unmarshal(b, &got)
	}
	log := fmt.Sprintf("%s → HTTP %d，用时 %.1fs，响应 %d 字节", head, resp.StatusCode, time.Since(start).Seconds(), len(b))
	if truncated {
		log += "（超过 64KB，已截断）"
	}
	if resp.StatusCode >= 400 {
		why := "对方拒绝了请求"
		if resp.StatusCode >= 500 {
			why = "对方服务出错"
		}
		return nodeResult{err: fmt.Sprintf("HTTP %d：%s", resp.StatusCode, why), log: log}
	}
	res := map[string]any{"status": resp.StatusCode, "method": method, "url": shown, "body": got}
	if truncated {
		res["truncated"] = true
	}
	return nodeResult{output: with(input, "http", res), log: log}
}

func clipText(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n]) + "…"
}
