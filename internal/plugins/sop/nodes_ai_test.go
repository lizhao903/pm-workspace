package sop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// AI 类和外部节点（SOP-01c）：假的模型和 Agent 句柄，HTTP 用本机假服务。

func init() { agentPoll = 10 * time.Millisecond }

// fakeAgent 是假的 Core.Agent()：按 System 提示词分流回话，记下收到的请求。
type fakeAgent struct {
	mu       sync.Mutex
	complete func(req plugin.CompleteRequest) (string, error)
	reqs     []plugin.CompleteRequest
	run      plugin.AgentRunResult
	runReqs  []plugin.AgentRunRequest
	state    plugin.AgentRunResult
	kbIDs    [][]string
	hits     []plugin.KBHit
}

func (f *fakeAgent) Complete(_ context.Context, req plugin.CompleteRequest) (string, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	fn := f.complete
	f.mu.Unlock()
	return fn(req)
}

func (f *fakeAgent) RunAgent(_ context.Context, req plugin.AgentRunRequest) (plugin.AgentRunResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runReqs = append(f.runReqs, req)
	return f.run, nil
}

func (f *fakeAgent) AgentState(_ context.Context, _ string) (plugin.AgentRunResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state, nil
}

func (f *fakeAgent) setState(s plugin.AgentRunResult) {
	f.mu.Lock()
	f.state = s
	f.mu.Unlock()
}

func (f *fakeAgent) SearchKB(_ context.Context, ids []string, _ string, top int) ([]plugin.KBHit, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.kbIDs = append(f.kbIDs, ids)
	var out []plugin.KBHit
	for _, h := range f.hits {
		if slices.Contains(ids, h.KbID) && len(out) < top {
			out = append(out, h)
		}
	}
	return out, nil
}

func setupAgent(t *testing.T, fa *fakeAgent) http.Handler {
	t.Helper()
	r, h := setup(t, New())
	if fa != nil {
		r.SetAgent(fa)
	}
	return h
}

func TestAINodesWithFakeModel(t *testing.T) {
	var extractCalls atomic.Int32
	fa := &fakeAgent{complete: func(req plugin.CompleteRequest) (string, error) {
		switch {
		case strings.Contains(req.System, "提取字段"):
			if extractCalls.Add(1) == 1 {
				return "客户是星河科技，金额 3 万", nil
			}
			return "```json\n{\"客户名\":\"星河科技\",\"金额\":\"3 万\"}\n```", nil
		case strings.Contains(req.System, "分类"):
			return "缺陷", nil
		case strings.Contains(req.Prompt, "第 1 项"):
			return "已建：登录报错", nil
		case strings.Contains(req.Prompt, "第 2 项"):
			return "已建：导出超时", nil
		}
		return "  这是摘要  ", nil
	}}
	h := setupAgent(t, fa)
	id := newFlow(t, h, `{"name":"AI 节点","fields":[{"key":"text","label":"原文","type":"textarea"}],"steps":[
		{"key":"a","name":"写摘要","kind":"ai","desc":"把 {{text}} 写成一句话","after":[],"config":{"provider":"pv-x","model":"m-x","output":"summary"}},
		{"key":"x","name":"提取","kind":"extract","after":["a"],"config":{"fields":"客户名, 金额","from":"text"}},
		{"key":"c","name":"分类","kind":"classifier","after":["x"],"cases":[{"key":"bug","label":"缺陷"},{"key":"req","label":"需求"}],"config":{"from":"text"}},
		{"key":"i","name":"逐条处理","kind":"iterate","after":["c"],"branch":{"of":"c","case":"bug"},"config":{"list":"items","action":"建一条任务"}},
		{"key":"e","name":"结束","kind":"end","after":["i"],"config":{"outputs":"summary, extracted, results"}}]}`)
	rid := startRun(t, h, id, `{"input":{"text":"星河科技反馈登录报错，合同金额 3 万","items":["登录报错","导出超时"]}}`)["id"].(string)

	// 参数提取第一次拿到非 JSON：步骤失败，可以重试
	run := waitStatus(t, h, rid, "failed")
	x := step(run, "x")
	if x["status"] != "failed" || !strings.Contains(x["error"].(string), "不是 JSON") {
		t.Fatalf("extract 拿到非 JSON 应当失败：%v %v", x["status"], x["error"])
	}
	a := step(run, "a")
	if a["status"] != "done" || a["output"].(map[string]any)["summary"] != "这是摘要" {
		t.Fatalf("ai 输出 %v", a["output"])
	}
	if code, out := act(t, h, rid, `{"kind":"retry","step":"x"}`); code != 200 {
		t.Fatalf("重试 %d %s", code, errMsg(out))
	}
	run = waitStatus(t, h, rid, "done")
	ext := step(run, "x")["output"].(map[string]any)["extracted"].(map[string]any)
	if ext["客户名"] != "星河科技" || ext["金额"] != "3 万" || len(ext) != 2 {
		t.Fatalf("extract 输出 %v", ext)
	}
	c := step(run, "c")
	if c["route"] != "bug" || c["route_reason"] != "模型判断属于「缺陷」" {
		t.Fatalf("classifier route=%v reason=%v", c["route"], c["route_reason"])
	}
	res := step(run, "i")["output"].(map[string]any)["results"].([]any)
	if len(res) != 2 || res[0].(map[string]any)["result"] != "已建：登录报错" || res[1].(map[string]any)["item"] != "导出超时" {
		t.Fatalf("iterate 输出 %v", res)
	}
	end := step(run, "e")["output"].(map[string]any)
	if end["summary"] != "这是摘要" || len(end) != 3 {
		t.Fatalf("结束输出 %v", end)
	}
	// ai 节点带上了要求和配置的模型
	fa.mu.Lock()
	first := fa.reqs[0]
	fa.mu.Unlock()
	if first.Model != "m-x" || first.Provider != "pv-x" || !strings.Contains(first.Prompt, "把 星河科技反馈登录报错，合同金额 3 万 写成一句话") {
		t.Fatalf("ai 请求 %+v", first)
	}
}

func TestClassifierOutsideCasesGoesFirst(t *testing.T) {
	fa := &fakeAgent{complete: func(plugin.CompleteRequest) (string, error) { return "咨询", nil }}
	h := setupAgent(t, fa)
	id := newFlow(t, h, `{"name":"分类","steps":[
		{"key":"c","name":"分类","kind":"classifier","after":[],"cases":[{"key":"bug","label":"缺陷"},{"key":"req","label":"需求"}]},
		{"key":"b","name":"缺陷","kind":"auto","after":["c"],"branch":{"of":"c","case":"bug"}},
		{"key":"r","name":"需求","kind":"auto","after":["c"],"branch":{"of":"c","case":"req"}}]}`)
	rid := startRun(t, h, id, `{"input":{"text":"想问下价格"}}`)["id"].(string)
	run := waitStatus(t, h, rid, "done")
	c := step(run, "c")
	if c["route"] != "bug" || !strings.Contains(c["route_reason"].(string), "「咨询」不在分支里，归到第一类「缺陷」") {
		t.Fatalf("route=%v reason=%v", c["route"], c["route_reason"])
	}
	if step(run, "b")["status"] != "done" || step(run, "r")["status"] != "bypassed" {
		t.Fatalf("b=%v r=%v", step(run, "b")["status"], step(run, "r")["status"])
	}
}

func TestKnowledgeOnlyConfiguredKBs(t *testing.T) {
	fa := &fakeAgent{hits: []plugin.KBHit{
		{KbID: "kb_other", DocID: "d0", Title: "别的库", Text: "不该出现"},
		{KbID: "kb_a", DocID: "d1", Title: "退款规则", Text: "七天内可退"},
		{KbID: "kb_b", DocID: "d2", Title: "发票", Text: "月底开票"},
	}}
	h := setupAgent(t, fa)
	id := newFlow(t, h, `{"name":"检索","steps":[
		{"key":"k","name":"查资料","kind":"knowledge","after":[],"config":{"query":"{{customer}} 怎么退款","kbs":"kb_a, kb_b","top_k":"5"}}]}`)
	rid := startRun(t, h, id, `{"input":{"customer":"星河"}}`)["id"].(string)
	run := waitStatus(t, h, rid, "done")
	out := step(run, "k")["output"].(map[string]any)
	if out["query"] != "星河 怎么退款" {
		t.Fatalf("query %v", out["query"])
	}
	ms := out["matches"].([]any)
	if len(ms) != 2 {
		t.Fatalf("matches %v", ms)
	}
	for _, m := range ms {
		if kb := m.(map[string]any)["kb_id"]; kb != "kb_a" && kb != "kb_b" {
			t.Fatalf("返回了没配置的知识库 %v", kb)
		}
	}
	if got := fa.kbIDs[0]; !slices.Equal(got, []string{"kb_a", "kb_b"}) {
		t.Fatalf("搜的知识库 %v", got)
	}

	// 没配知识库：失败，不搜全部
	id2 := newFlow(t, h, `{"name":"检索 2","steps":[{"key":"k","name":"查资料","kind":"knowledge","after":[],"config":{"query":"退款"}}]}`)
	run = waitStatus(t, h, startRun(t, h, id2, `{}`)["id"].(string), "failed")
	if e := step(run, "k")["error"]; e != "没有配置要检索的知识库" {
		t.Fatalf("error %v", e)
	}
}

func TestAgentNodeWaitsForConfirm(t *testing.T) {
	fa := &fakeAgent{
		run: plugin.AgentRunResult{AgentID: "ag_1", AgentName: "客服助手", SessionID: "as_1", MessageID: "m1",
			Reply: "【等你确认】新建「回访」，确认后才会执行。", Waiting: true, Pending: "新建「回访」", CallIDs: []string{"atc_1"}},
	}
	fa.state = fa.run
	h := setupAgent(t, fa)
	id := newFlow(t, h, `{"name":"交给 Agent","steps":[
		{"key":"g","name":"处理","kind":"agent","after":[],"config":{"agent":"客服助手","prompt":"认出 {{customer}} 是谁"}},
		{"key":"z","name":"收尾","kind":"template","after":["g"],"config":{"template":"回复：{{agent_reply}}"}}]}`)
	rid := startRun(t, h, id, `{"input":{"customer":"周屿"}}`)["id"].(string)
	run := waitStatus(t, h, rid, "waiting")
	g := step(run, "g")
	if g["status"] != "review" || !hasLog(g, "等你在会话里确认") || hasLog(g, "等待人工检查") {
		t.Fatalf("agent 应当停在 review：%v %v", g["status"], g["log"])
	}
	if ag := g["output"].(map[string]any)["agent"].(map[string]any); ag["session_id"] != "as_1" || ag["status"] != "waiting" || ag["call_ids"].([]any)[0] != "atc_1" {
		t.Fatalf("agent 输出 %v", ag)
	}
	fa.mu.Lock()
	req := fa.runReqs[0]
	fa.mu.Unlock()
	if req.Agent != "客服助手" || !strings.HasPrefix(req.Prompt, "认出 周屿 是谁") {
		t.Fatalf("run 请求 %+v", req)
	}
	// 还没确认：一直等着
	time.Sleep(50 * time.Millisecond)
	if s := step(getRun(t, h, rid), "g")["status"]; s != "review" {
		t.Fatalf("没确认不能往下走：%v", s)
	}
	// 会话里又冒出一张确认卡片：还是等
	fa.setState(plugin.AgentRunResult{SessionID: "as_1", MessageID: "m2", Reply: "【等你确认】再建一条", Waiting: true})
	time.Sleep(50 * time.Millisecond)
	if s := step(getRun(t, h, rid), "g")["status"]; s != "review" {
		t.Fatalf("还在等确认不能往下走：%v", s)
	}
	// 确认后 Agent 回了话：这一步完成，运行继续
	fa.setState(plugin.AgentRunResult{SessionID: "as_1", MessageID: "m3", Reply: "已经建好回访任务"})
	run = waitStatus(t, h, rid, "done")
	g = step(run, "g")
	if !hasLog(g, "会话里已经确认") || g["output"].(map[string]any)["agent_reply"] != "已经建好回访任务" {
		t.Fatalf("agent 完成后 %v %v", g["log"], g["output"])
	}
	if z := step(run, "z")["output"].(map[string]any)["text"]; z != "回复：已经建好回访任务" {
		t.Fatalf("下游 %v", z)
	}
}

func TestAgentNodeApprovedByHand(t *testing.T) {
	fa := &fakeAgent{run: plugin.AgentRunResult{SessionID: "as_1", MessageID: "m1", Waiting: true, Pending: "x"}}
	fa.state = fa.run
	h := setupAgent(t, fa)
	id := newFlow(t, h, `{"name":"手动放行","steps":[{"key":"g","name":"处理","kind":"agent","after":[],"config":{"agent":"a"}}]}`)
	rid := startRun(t, h, id, `{}`)["id"].(string)
	waitStatus(t, h, rid, "waiting")
	if code, out := act(t, h, rid, `{"kind":"approve","step":"g"}`); code != 200 {
		t.Fatalf("放行 %d %s", code, errMsg(out))
	}
	waitStatus(t, h, rid, "done")
}

func TestHTTPNode(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	var gotAuth, gotBody, gotType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotAuth, gotBody, gotType = r.Header.Get("Authorization"), string(b), r.Header.Get("Content-Type")
		if fail.Load() {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"id":42}`))
	}))
	defer srv.Close()
	h := setupAgent(t, nil)
	cfg, _ := json.Marshal(map[string]string{"method": "POST", "url": srv.URL + "/tickets?api_key={{key}}",
		"headers": "Authorization: Bearer {{token}}\nX-Trace: t1", "body": `{"title":"{{title}}"}`})
	id := newFlow(t, h, `{"name":"HTTP","steps":[{"key":"h","name":"建工单","kind":"http","after":[],"config":`+string(cfg)+`}]}`)
	rid := startRun(t, h, id, `{"input":{"token":"sekret-1","key":"k-9","title":"登录报错"}}`)["id"].(string)
	run := waitStatus(t, h, rid, "failed")
	s := step(run, "h")
	if s["error"] != "HTTP 500：对方服务出错" {
		t.Fatalf("500 应当失败：%v", s["error"])
	}
	if gotAuth != "Bearer sekret-1" || gotBody != `{"title":"登录报错"}` || gotType != "application/json" {
		t.Fatalf("请求 auth=%q body=%q type=%q", gotAuth, gotBody, gotType)
	}
	logs, _ := json.Marshal(s["log"])
	if strings.Contains(string(logs), "sekret-1") || strings.Contains(string(logs), "k-9") || !strings.Contains(string(logs), "Authorization: ***") || !strings.Contains(string(logs), "X-Trace: t1") {
		t.Fatalf("日志里凭证要打码：%s", logs)
	}
	fail.Store(false)
	if code, out := act(t, h, rid, `{"kind":"retry","step":"h"}`); code != 200 {
		t.Fatalf("重试 %d %s", code, errMsg(out))
	}
	run = waitStatus(t, h, rid, "done")
	res := step(run, "h")["output"].(map[string]any)["http"].(map[string]any)
	if res["status"] != float64(200) || res["body"].(map[string]any)["id"] != float64(42) || strings.Contains(res["url"].(string), "k-9") || !strings.HasSuffix(res["url"].(string), "api_key=***") {
		t.Fatalf("http 输出 %v", res)
	}
}

func TestHTTPBodyTruncated(t *testing.T) {
	big := strings.Repeat("a", httpBodyMax+100)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(big)) }))
	defer srv.Close()
	res := runHTTP(context.Background(), stepDef{Kind: "http", Config: map[string]string{"method": "GET", "url": srv.URL}}, Json{})
	h := res.output["http"].(map[string]any)
	if res.err != "" || len(h["body"].(string)) != httpBodyMax || h["truncated"] != true || !strings.Contains(res.log, "已截断") {
		t.Fatalf("响应体要截到 64KB：err=%q len=%d", res.err, len(h["body"].(string)))
	}
	res = runHTTP(context.Background(), stepDef{Kind: "http", Config: map[string]string{"url": srv.URL, "body": big}}, Json{})
	if !strings.Contains(res.err, "超过 64KB") {
		t.Fatalf("请求体超过 64KB 要失败：%q", res.err)
	}
	if res = runHTTP(context.Background(), stepDef{Kind: "http", Config: map[string]string{"url": "ftp://x"}}, Json{}); !strings.Contains(res.err, "http://") {
		t.Fatalf("地址校验 %q", res.err)
	}
}

func TestCodeNodeUnsupportedAndNoModel(t *testing.T) {
	h := setupAgent(t, nil)
	id := newFlow(t, h, `{"name":"代码","steps":[
		{"key":"c","name":"算总数","kind":"code","after":[],"config":{"code":"function main(i){return i}"}},
		{"key":"a","name":"写摘要","kind":"ai","after":[]}]}`)
	run := waitStatus(t, h, startRun(t, h, id, `{}`)["id"].(string), "failed")
	waitFor(t, "两步都失败", func() bool {
		run = getRun(t, h, run["id"].(string))
		return step(run, "c")["status"] == "failed" && step(run, "a")["status"] == "failed"
	})
	if e := step(run, "c")["error"]; e != "代码节点暂不支持在后端执行" {
		t.Fatalf("code error %v", e)
	}
	if e := step(run, "a")["error"].(string); !strings.Contains(e, "模型和 Agent 还没接上") {
		t.Fatalf("没接模型时 ai error %v", e)
	}
}
