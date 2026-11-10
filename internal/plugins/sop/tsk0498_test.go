// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// TSK-0498：条件存成一句话时的提前发现（列表带 rule_text 体检问题）、执行失败的文案和错误码、运行异常「现象」同文案。

const sentenceRule = "IM 消息来源群组 = C0BNCBRL5C0 且 消息中未 @ 我"

const twoCases = `"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}]`

// sentenceSteps 是一句话条件分支的步骤，条件分支在第 2 步（下标 1）。
var sentenceSteps = `[{"key":"prep","name":"整理","kind":"template","after":[],"config":{"template":"x","output":"text"}},` +
	`{"key":"gate","name":"判断来源群组且未@我","kind":"decide","after":["prep"],` + twoCases + `,"rule":"` + sentenceRule + `"}]`

// legacySteps 是建流程时能存上的旧写法（保存校验只给 legacy_rule 警告）；建完再改库换成一句话，
// 模拟升级前存下的旧流程（现在新校验会拦一句话条件）。
var legacySteps = strings.ReplaceAll(sentenceSteps, `"rule":"`+sentenceRule+`"`, `"rule":"status 等于 done"`)

// saveAndPatch 建一条能存上的流程，再把库里的 steps、触发方式改成要测的样子。
func saveAndPatch(t *testing.T, p *Plugin, h http.Handler, trigger, steps string) string {
	t.Helper()
	id := newFlow(t, h, `{"name":"一句话条件","trigger":"`+trigger+`","steps":`+legacySteps+`}`)
	if _, err := p.core.Store().Exec(context.Background(), `UPDATE sop_flows SET steps = ?, trigger_desc = ? WHERE id = ?`, steps, trigger, id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestFlowIssuesRuleTextInList 验收 11：列表对条件是一句话的流程带 code=rule_text、step 正确；
// 旧写法的规则只给 legacy_rule、不带 rule_text；人工判断不带。
func TestFlowIssuesRuleTextInList(t *testing.T) {
	p := New()
	_, h := setup(t, p)
	sentence := saveAndPatch(t, p, h, "im", sentenceSteps)
	legacy := newFlow(t, h, `{"name":"旧写法","steps":`+legacySteps+`}`)
	manual := newFlow(t, h, `{"name":"人工判断","steps":[{"key":"gate","name":"人工判断","kind":"decide",`+twoCases+`}]}`)

	_, out := call(t, h, "GET", "/api/sop/flows", "")
	flows := map[string]map[string]any{}
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		flows[m["id"].(string)] = m
	}
	codesOf := func(m map[string]any) []string {
		var cs []string
		if is, ok := m["issues"].([]any); ok {
			for _, x := range is {
				cs = append(cs, x.(map[string]any)["code"].(string))
			}
		}
		return cs
	}

	f := flows[sentence]
	found := false
	if is, ok := f["issues"].([]any); ok {
		for _, x := range is {
			it := x.(map[string]any)
			if it["code"] != codeRuleText {
				continue
			}
			found = true
			if it["level"] != levelError || it["step"] != float64(1) ||
				!strings.Contains(it["text"].(string), "判断来源群组且未@我") || !strings.Contains(it["text"].(string), sentenceRule) {
				t.Fatalf("rule_text 体检问题 = %v", it)
			}
		}
	}
	if !found {
		t.Fatalf("列表对一句话条件应带 %s：%v", codeRuleText, f["issues"])
	}
	for _, m := range []map[string]any{flows[legacy], flows[manual]} {
		for _, c := range codesOf(m) {
			if c == codeRuleText {
				t.Fatalf("不该带 %s：%v", codeRuleText, m["issues"])
			}
		}
	}
	if !strings.Contains(strings.Join(codesOf(flows[legacy]), ","), codeLegacyRule) {
		t.Fatalf("旧写法应带 %s：%v", codeLegacyRule, flows[legacy]["issues"])
	}
	if _, ok := flows[manual]["issues"]; ok {
		t.Fatalf("人工判断不该带体检问题：%v", flows[manual]["issues"])
	}
	// 详情也带同一套（TSK-0490 起就有，这里确认没被列表改动影响）
	_, out = call(t, h, "GET", "/api/sop/flows/"+sentence, "")
	if is, _ := out["data"].(map[string]any)["issues"].([]any); len(is) == 0 || is[0].(map[string]any)["code"] != codeRuleText {
		t.Fatalf("详情 issues = %v", out["data"].(map[string]any)["issues"])
	}
}

// TestRuleSentenceFailsIMTrigger 验收 5：IM 触发的流程，一句话条件执行失败，错误文字是 4.3 两段拼接的全文，
// 执行接口回该步 error_code=rule_text。
func TestRuleSentenceFailsIMTrigger(t *testing.T) {
	p := New()
	_, h := setup(t, p)
	id := saveAndPatch(t, p, h, "im", sentenceSteps)
	run := waitStatus(t, h, startRun(t, h, id, `{}`)["id"].(string), "failed")
	s := step(run, "gate")
	want := ruleSentenceMessage(sentenceRule, true)
	if s["status"] != stFailed || s["error"] != want {
		t.Fatalf("失败原因 = %v\n要的是 = %s", s["error"], want)
	}
	if s["error_code"] != codeRuleText {
		t.Fatalf("error_code = %v", s["error_code"])
	}
	if !strings.Contains(want, "触发方式「IM 消息」下面选「只接这些会话」和「与我的关系」") {
		t.Fatalf("IM 触发应多一句用触发过滤：%s", want)
	}
	// 其他原因失败的步骤不带错误码
	if c, ok := step(run, "prep")["error_code"]; ok {
		t.Fatalf("成功的步骤不该带 error_code：%v", c)
	}
}

// TestRuleSentenceFailsManualTrigger 验收 6：手动触发时只有 4.3 第一段。
func TestRuleSentenceFailsManualTrigger(t *testing.T) {
	p := New()
	_, h := setup(t, p)
	id := saveAndPatch(t, p, h, "manual", sentenceSteps)
	run := waitStatus(t, h, startRun(t, h, id, `{}`)["id"].(string), "failed")
	s := step(run, "gate")
	want := ruleSentenceMessage(sentenceRule, false)
	if s["error"] != want || s["error_code"] != codeRuleText {
		t.Fatalf("失败原因 = %v / %v\n要的是 = %s", s["error"], s["error_code"], want)
	}
	if strings.Contains(want, "触发方式「IM 消息」下面选") {
		t.Fatalf("手动触发不该有 IM 那句：%s", want)
	}
}

// TestRuleSentenceLoopbackFails 验收 7：条件回退的 rule 是一句话，执行到它同样失败，文案同 4.3。
func TestRuleSentenceLoopbackFails(t *testing.T) {
	loopSteps := `[{"key":"draft","name":"起草","kind":"template","after":[],"config":{"template":"x","output":"text"}},` +
		`{"key":"gate","name":"评审不通过就退回","kind":"loopback","after":["draft"],"rule":"` + sentenceRule + `","config":{"target":"draft"},` +
		`"cases":[{"key":"pass","label":"通过"},{"key":"over","label":"超限"}]},` +
		`{"key":"go","name":"进开发","kind":"template","branch":{"of":"gate","case":"pass"},"config":{"template":"ok","output":"done"}},` +
		`{"key":"human","name":"人工裁决","kind":"review","branch":{"of":"gate","case":"over"}}]`
	p := New()
	_, h := setup(t, p)
	legacyLoop := strings.ReplaceAll(loopSteps, `"rule":"`+sentenceRule+`"`, `"rule":"verdict 等于 reject"`)
	id := newFlow(t, h, `{"name":"条件回退","steps":`+legacyLoop+`}`)
	if _, err := p.core.Store().Exec(context.Background(), `UPDATE sop_flows SET steps = ? WHERE id = ?`, loopSteps, id); err != nil {
		t.Fatal(err)
	}
	run := waitStatus(t, h, startRun(t, h, id, `{}`)["id"].(string), "failed")
	s := step(run, "gate")
	want := ruleSentenceMessage(sentenceRule, false)
	if s["error"] != want || s["error_code"] != codeRuleText {
		t.Fatalf("条件回退失败 = %v / %v\n要的是 = %s", s["error"], s["error_code"], want)
	}
}

// TestRuleSentenceIncident 验收 12：这一步失败记的运行异常，「现象」（Message）用同一段文字。
func TestRuleSentenceIncident(t *testing.T) {
	p := New()
	r, h := setup(t, p)
	f := &fakeIncidents{}
	r.SetIncidents(f)
	id := saveAndPatch(t, p, h, "im", sentenceSteps)
	waitStatus(t, h, startRun(t, h, id, `{}`)["id"].(string), "failed")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.got) != 1 {
		t.Fatalf("应记一条运行异常：%+v", f.got)
	}
	if want := ruleSentenceMessage(sentenceRule, true); f.got[0].Message != want {
		t.Fatalf("运行异常「现象」= %q\n要的是 = %q", f.got[0].Message, want)
	}
}
