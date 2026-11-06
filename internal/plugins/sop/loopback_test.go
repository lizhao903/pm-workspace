package sop

import (
	"fmt"
	"strings"
	"testing"
)

// 条件回退测试（AUTO-02）：条件成立自动退回上游重做并带 feedback、超限走「超限」出口、没接超限时失败、保存校验。

// loopFlow：起草 → 评审（模板，按输入 verdicts 列表和轮次给结论）→ 条件回退（不通过退回起草）→ 通过 / 超限人工。
// 评审结论取 verdicts[第几轮-1]，首轮没有 feedback 算第 1 轮。
func loopFlow(maxRounds string, withOver bool) string {
	over := ""
	if withOver {
		over = `,{"key":"human","name":"人工裁决","kind":"review","after":["gate"],"branch":{"of":"gate","case":"over"}}`
	}
	cfg := `"target":"draft"`
	if maxRounds != "" {
		cfg += `,"max_rounds":"` + maxRounds + `"`
	}
	return fmt.Sprintf(`{"name":"评审回退","fields":[{"key":"verdicts","label":"结论","type":"text"}],"steps":[
		{"key":"draft","name":"起草","kind":"template","after":[],"config":{"template":"第{{feedback.round}}轮 意见:{{feedback.issue}}","output":"text"}},
		{"key":"review","name":"评审","kind":"code","after":["draft"],"config":{"code":"x"}},
		{"key":"gate","name":"评审不通过就退回","kind":"loopback","after":["review"],"rule":"verdict 等于 reject","config":{%s},
			"cases":[{"key":"pass","label":"通过"},{"key":"over","label":"超限"}]},
		{"key":"go","name":"进开发","kind":"template","branch":{"of":"gate","case":"pass"},"config":{"template":"ok","output":"done"}}%s
	]}`, cfg, over)
}

// reviewHook 把「评审」换成按轮次给结论：verdicts 是每一轮的结论，第 n 轮取第 n 个。
// 评审是 code 节点（原型不执行代码），测试里用执行前钩子改不了输出，所以直接用 template 代替：见 loopFlowTpl。
func loopFlowTpl(maxRounds string, withOver bool, verdict string) string {
	return strings.Replace(loopFlow(maxRounds, withOver),
		`{"key":"review","name":"评审","kind":"code","after":["draft"],"config":{"code":"x"}}`,
		`{"key":"review","name":"评审","kind":"template","after":["draft"],"config":{"template":"`+verdict+`","output":"verdict"}}`, 1)
}

func TestLoopbackReworkThenOver(t *testing.T) {
	_, h := setup(t, New())
	// 评审一直不通过：退回 2 轮后第 3 次判断超限，走人工裁决
	fid := newFlow(t, h, loopFlowTpl("2", true, "reject"))
	id := startRun(t, h, fid, `{"input":{"verdicts":"x"}}`)["id"].(string)
	run := waitStatus(t, h, id, "waiting")
	gate, draft := step(run, "gate"), step(run, "draft")
	if gate["route"] != "over" || gate["loops"] != float64(2) || !strings.Contains(gate["route_reason"].(string), "已经自动退回 2 轮") {
		t.Fatalf("回退节点 = %v", gate)
	}
	if step(run, "human")["status"] != stReview || step(run, "go")["status"] != stBypassed {
		t.Fatalf("超限出口 = %v / %v", step(run, "human")["status"], step(run, "go")["status"])
	}
	// 起草跑了 3 次（首轮 + 2 轮重做），当前第 3 轮，带着回退原因和 feedback
	if draft["attempts"] != float64(3) || draft["round"] != float64(3) || !strings.Contains(draft["rework_reason"].(string), "评审不通过就退回") {
		t.Fatalf("起草 = %v", draft)
	}
	fb, _ := draft["input"].(map[string]any)["feedback"].(map[string]any)
	if fb["round"] != float64(3) || fb["verdict"] != "reject" || fb["from"] != "gate" {
		t.Fatalf("feedback = %v", fb)
	}
	if out := draft["output"].(map[string]any)["text"]; !strings.HasPrefix(out.(string), "第3轮") {
		t.Fatalf("起草拿到 feedback = %v", out)
	}
	if step(run, "review")["round"] != float64(3) || !hasLog(draft, "第 2 轮：被「评审不通过就退回」条件「verdict 等于 reject」成立退回重做") {
		t.Fatalf("轮次日志 = %v", draft["log"])
	}
}

func TestLoopbackPass(t *testing.T) {
	_, h := setup(t, New())
	fid := newFlow(t, h, loopFlowTpl("", true, "pass"))
	id := startRun(t, h, fid, `{"input":{"verdicts":"x"}}`)["id"].(string)
	run := waitStatus(t, h, id, "done")
	if g := step(run, "gate"); g["route"] != "pass" || g["loops"] != nil {
		t.Fatalf("通过 = %v", g)
	}
	if step(run, "draft")["attempts"] != float64(1) || step(run, "human")["status"] != stBypassed {
		t.Fatal("通过时不该退回")
	}
}

// 没有步骤接在「超限」上：超过上限这一步失败；默认上限 3 轮
func TestLoopbackOverWithoutExitFails(t *testing.T) {
	_, h := setup(t, New())
	fid := newFlow(t, h, loopFlowTpl("", false, "reject"))
	id := startRun(t, h, fid, `{"input":{"verdicts":"x"}}`)["id"].(string)
	run := waitStatus(t, h, id, "failed")
	g := step(run, "gate")
	if !strings.Contains(g["error"].(string), "已经自动退回 3 轮") || !strings.Contains(g["error"].(string), "超限") {
		t.Fatalf("失败原因 = %v", g["error"])
	}
	if step(run, "draft")["attempts"] != float64(4) {
		t.Fatalf("起草次数 = %v", step(run, "draft")["attempts"])
	}
}

// 校验：回退目标必须是上游、不算依赖环；上限 1 到 10；要有条件和两个出口
func TestLoopbackCheck(t *testing.T) {
	_, h := setup(t, New())
	// 合法的：回退指向上游，不报「依赖成环」
	if code, out := call(t, h, "POST", "/api/sop/flows", loopFlowTpl("10", true, "x")); code != 201 {
		t.Fatalf("合法流程 %d %v", code, out)
	}
	bad := []struct{ body, want string }{
		{strings.Replace(loopFlowTpl("", true, "x"), `"target":"draft"`, `"target":"go"`, 1), "只能退回到上游"},
		{strings.Replace(loopFlowTpl("", true, "x"), `"target":"draft"`, `"target":"gate"`, 1), "不能退回到自己"},
		{strings.Replace(loopFlowTpl("", true, "x"), `"target":"draft"`, `"target":"nope"`, 1), "不存在"},
		{loopFlowTpl("11", true, "x"), "1 到 10"},
		{loopFlowTpl("0", true, "x"), "1 到 10"},
		{strings.Replace(loopFlowTpl("", true, "x"), `"rule":"verdict 等于 reject",`, ``, 1), "还没填回退条件"},
		{strings.Replace(loopFlowTpl("", true, "x"), `"rule":"verdict 等于 reject"`, `"rule":"verdict 是 reject"`, 1), "是一句话"},
		{strings.Replace(loopFlowTpl("", false, "x"), `{"key":"over","label":"超限"}`, `{"key":"c2","label":"超限"}`, 1), "出口要有"},
	}
	for _, b := range bad {
		code, out := call(t, h, "POST", "/api/sop/flows", b.body)
		if code != 400 || !strings.Contains(fmt.Sprint(out), b.want) {
			t.Errorf("要拦「%s」：%d %v", b.want, code, out)
		}
		if strings.Contains(fmt.Sprint(out), "依赖成环") {
			t.Errorf("回退不该算环：%v", out)
		}
	}
}
