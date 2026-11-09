package sop

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// 条件回退节点（AUTO-02）：条件满足（规则写法同条件分支，比如「result.verdict 等于 reject」）时自动把指定的上游步骤退回重做，
// 本步的输入（通常是评审意见）作为上游重做时的额外输入 feedback；条件不满足走「通过」出口往下走。
// 每个回退节点最多自动退回 max_rounds 轮（默认 3，1 到 10），超了走「超限」出口（通常接人工检查）；没有步骤挂在「超限」上时这一步失败。
//
// 回退目标写在配置里，不是依赖，所以不算环；保存时校验它必须是本步的上游（沿依赖往上找得到）。
// 重做复用人工「退回上游重做」的重置（engine.go 的 rework）：目标步骤重新执行，目标下游的步骤（含本步）回到未开始，
// 记上第几轮和退回原因，执行详情里显示「第 N 轮」。

const loopbackKind = "loopback"

// 条件回退的两个出口。
const (
	loopPass = "pass"
	loopOver = "over"
	// loopBack 是 runNode 里条件成立时的内部结果，不是出口
	loopBack = "back"
)

const (
	loopDefaultRounds = 3
	loopMaxRounds     = 10
)

// loopRounds 解析 max_rounds：留空 3，要是 1 到 10 的整数。
func loopRounds(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return loopDefaultRounds, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > loopMaxRounds {
		return 0, fmt.Errorf("最多退回几轮要是 1 到 %d 的整数", loopMaxRounds)
	}
	return n, nil
}

// runLoopback 求条件：成立回 loopBack（由 runner 决定退回还是超限），不成立走「通过」；im 是流程的触发方式是不是 IM 消息。
func runLoopback(def stepDef, input Json, im bool) nodeResult {
	if !hasCondition(def) {
		return nodeResult{err: "还没填回退条件"}
	}
	ok, rule, err := judge(def, im)(input)
	if err != nil {
		return nodeResult{err: err.Error(), errCode: errorCode(err)}
	}
	if ok {
		return nodeResult{output: input, route: loopBack, reason: fmt.Sprintf("条件「%s」成立", rule)}
	}
	return nodeResult{output: input, route: loopPass, reason: fmt.Sprintf("条件「%s」不成立", rule)}
}

// ancestors 是第 i 步沿依赖往上能找到的所有步骤（不含自己）。
func ancestors(steps []stepDef, idx map[string]int, i int) map[int]bool {
	out := map[int]bool{}
	var walk func(k int)
	walk = func(k int) {
		for _, j := range depsOf(steps, idx, k) {
			if !out[j] {
				out[j] = true
				walk(j)
			}
		}
	}
	walk(i)
	return out
}

// descendants 是第 j 步的所有下游（依赖它、或挂在它的分支上，层层往下），不含自己，按步骤顺序。
func descendants(steps []stepDef, idx map[string]int, j int) []int {
	in := map[int]bool{j: true}
	for changed := true; changed; {
		changed = false
		for k := range steps {
			if in[k] {
				continue
			}
			hit := slices.ContainsFunc(depsOf(steps, idx, k), func(d int) bool { return in[d] })
			if !hit && steps[k].Branch != nil {
				if b, ok := idx[steps[k].Branch.Of]; ok && in[b] {
					hit = true
				}
			}
			if hit {
				in[k], changed = true, true
			}
		}
	}
	delete(in, j)
	out := make([]int, 0, len(in))
	for k := range in {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// checkLoopback 是保存时对条件回退的检查：条件、目标是本步的上游、轮次上限、两个出口。
func checkLoopback(steps []stepDef, idx map[string]int, i int) []string {
	s := steps[i]
	var out []string
	if !hasCondition(s) {
		out = append(out, "还没填回退条件")
	}
	if t := strings.TrimSpace(s.Config["target"]); t != "" {
		j, ok := idx[t]
		switch {
		case !ok:
			out = append(out, fmt.Sprintf("退回的步骤 %s 不存在", t))
		case j == i:
			out = append(out, "不能退回到自己")
		case !ancestors(steps, idx, i)[j]:
			out = append(out, fmt.Sprintf("只能退回到上游的步骤，「%s」不在它上游", orDefault(steps[j].Name, t)))
		}
	}
	if _, err := loopRounds(s.Config["max_rounds"]); err != nil {
		out = append(out, err.Error())
	}
	keys := make([]string, 0, len(s.Cases))
	for _, c := range s.Cases {
		keys = append(keys, c.Key)
	}
	if !slices.Contains(keys, loopPass) || !slices.Contains(keys, loopOver) {
		out = append(out, "出口要有「通过」（pass）和「超限」（over）")
	}
	return out
}

// loopBack 在 runner 里结算条件成立的回退节点：没超限就退回目标重做，超限走「超限」出口（没有步骤挂在上面就失败）。
func (r *runner) loopBack(i int, res nodeResult, t time.Time) {
	s := &r.run.Steps[i]
	def := r.defs[i]
	name := orDefault(def.Name, def.Key)
	max, err := loopRounds(def.Config["max_rounds"])
	if err != nil {
		r.fail(i, t, err.Error())
		return
	}
	target := strings.TrimSpace(def.Config["target"])
	j, ok := r.idx[target]
	if !ok || !ancestors(r.defs, r.idx, i)[j] {
		r.fail(i, t, fmt.Sprintf("退回的步骤 %s 不是这一步的上游", target))
		return
	}
	tname := orDefault(r.defs[j].Name, target)
	if s.Loops >= max {
		why := fmt.Sprintf("已经自动退回 %d 轮，%s，超过上限", s.Loops, res.reason)
		hasOver := slices.ContainsFunc(r.defs, func(d stepDef) bool { return d.Branch != nil && d.Branch.Of == def.Key && d.Branch.Case == loopOver })
		if !hasOver {
			r.fail(i, t, why+"；没有步骤接在「超限」出口上")
			return
		}
		s.Status, s.Output, s.Route, s.RouteReason, s.EndedAt = stDone, res.output, loopOver, why, &t
		r.log(i, t, fmt.Sprintf("判断结果：走「%s」，%s", caseLabel(def, loopOver), why))
		return
	}
	s.Loops++
	round := s.Loops + 1
	reason := fmt.Sprintf("「%s」%s", name, res.reason)
	feedback := orEmpty(clone(res.output))
	// 上一轮的 feedback 也在输入里，不往下嵌套
	delete(feedback, "feedback")
	feedback["round"], feedback["reason"], feedback["from"] = round, reason, def.Key
	r.log(i, t, fmt.Sprintf("%s，退回「%s」重做（第 %d 轮，最多退回 %d 轮）", res.reason, tname, round, max))
	// 目标下游（含本步）回到未开始，等目标重做完再按依赖放出来
	for _, k := range descendants(r.defs, r.idx, j) {
		d := &r.run.Steps[k]
		r.cancelStep(k)
		if d.Status != stPending || k == i {
			d.Status, d.Output, d.EndedAt, d.Edited = stPending, nil, nil, ""
			d.Route, d.RouteReason, d.Error, d.WakeAt, d.ChildRunID, d.Claude = "", "", "", nil, "", nil
			if k != i {
				r.log(k, t, fmt.Sprintf("上游「%s」被退回重做，这一步重新等待", tname))
			}
		}
		d.Round, d.ReworkReason = round, ""
	}
	// 目标重新执行，输入带上 feedback（本步的输入，通常是评审意见，另加第几轮、原因、从哪退回）
	u := &r.run.Steps[j]
	r.cancelStep(j)
	input, _ := r.inputFor(j)
	u.Input = with(orEmpty(input), "feedback", feedback)
	u.Output, u.EndedAt, u.Edited = nil, nil, ""
	u.Route, u.RouteReason, u.Error, u.WakeAt, u.ChildRunID, u.Claude = "", "", "", nil, "", nil
	u.Round, u.ReworkReason = round, reason
	if r.run.StepThrough {
		u.Status = stPaused
		r.log(j, t, fmt.Sprintf("第 %d 轮：被%s退回重做，执行前暂停，等待确认输入", round, reason))
		return
	}
	u.Status, u.StartedAt = stRunning, &t
	u.Attempts++
	r.log(j, t, fmt.Sprintf("第 %d 轮：被%s退回重做", round, reason))
}
