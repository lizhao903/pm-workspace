// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// 保存校验里按节点声明查的几条（TSK-0490），分两级：
//   - 错误（level=error）拦保存：条件写成一句话、结构化条件写法不对或字段这一步拿不到（上游都声明了时）、
//     IM 触发的流程有必填又没默认值、IM 消息也不带的输入字段（每条消息都会被跳过）。
//   - 警告（level=warning）能存，保存后和打开时提示：旧写法的一行规则（执行仍按它判断，建议改成结构化条件）、
//     配置里有节点不认的键、自动执行节点被当成写操作用、条件字段拿不到但上游有没声明输出的节点、
//     定时触发的流程有必填又没默认值的输入字段、不是条件节点却写了条件。
// 已有流程不会因为这些打不开、跑不了、升级不了：校验只在保存时拦，旧规则执行照旧；打开时 GET 把问题带在 issues 里提示。
// 原型 checkSop 里只是提醒的几条（没有人工检查点、分支下没有步骤、多个起点）仍在 assist.go 的 warnings，不在这里。

const (
	levelError   = "error"
	levelWarning = "warning"
)

// Issue.Code 的取值，前端和 AI 协助按它决定怎么处理（比如旧规则给「转成结构化条件」按钮、AI 草稿有这几种就返修）。
const (
	codeRuleText      = "rule_text"      // 条件是一句话
	codeLegacyRule    = "legacy_rule"    // 旧写法的一行规则
	codeCond          = "cond"           // 结构化条件写法不对
	codeCondField     = "cond_field"     // 条件的字段这一步拿不到
	codeInputUnfilled = "input_unfilled" // 自动触发补不上的必填输入字段
	codeUnknownConfig = "unknown_config" // 配置里有节点不认的键
	codeAutoWrite     = "auto_write"     // 自动执行节点被当成写操作用
	codeUnusedCond    = "unused_cond"    // 不是条件节点却写了条件
)

// autoWriteRe 认步骤名、说明里像是要改数据的说法：自动执行节点不做这些。
var autoWriteRe = regexp.MustCompile(`标记|标为|忽略|设为|设置成|改成|改为|创建|新建|建任务|写入|写进|发送|发消息|通知|回复|更新|删除|归到|列入|归档|分配|派给`)

// writeHints 是常见写操作该用的节点，auto 节点的警告里列出来。
const writeHints = "标记消息（忽略、已处理）用 im_mark_message，建任务用 task，改任务用 task_update，写文档用 doc，回复原消息用 im_reply_message，发消息用 im_send_message"

// declIssues 是按节点声明和触发方式查的问题。steps、ok、idx 来自 checkFlow 的解析。
func declIssues(f *Flow, steps []stepDef, ok []bool, idx map[string]int, kinds kindLookup, label func(int) string) []Issue {
	var out []Issue
	add := func(level, code string, step int, format string, args ...any) {
		x := Issue{Text: fmt.Sprintf(format, args...), Level: level, Code: code}
		if step >= 0 {
			s := step
			x.Step = &s
		}
		out = append(out, x)
	}
	ff := newFlowFields(f, steps, ok, idx, kinds)

	// 自动触发补不上的必填输入字段
	if trig, found := triggerOf(f.Trigger); found && trig.Auto {
		var fields []sopField
		_ = json.Unmarshal(f.Fields, &fields)
		autoKeys := make([]string, len(trig.Outputs))
		for i, o := range trig.Outputs {
			autoKeys[i] = o.Path
		}
		var missing []string
		for _, fd := range fields {
			if fd.Required && strings.TrimSpace(fd.Default) == "" && !slices.Contains(autoKeys, fd.Key) {
				missing = append(missing, "「"+orDefault(fd.Label, fd.Key)+"」")
			}
		}
		if len(missing) > 0 {
			names := strings.Join(missing, "、")
			if trig.Key == imTrigger {
				add(levelError, codeInputUnfilled, -1,
					"触发方式是 IM 消息，输入字段%s必填又没有默认值，IM 消息不会带上它，每条消息都会被跳过：给它默认值、改成不必填或删掉；"+
						"IM 消息自动带上的是 %s，正文用「读取消息」（im_get_message）按 message_id 取", names, strings.Join(autoKeys, "、"))
			} else {
				add(levelWarning, codeInputUnfilled, -1,
					"触发方式是%s，自动发起时不填输入：%s必填又没有默认值，到点会执行失败；给它们填默认值，或改成不必填", trig.Label, names)
			}
		}
	}

	for i, s := range steps {
		if !ok[i] {
			continue
		}
		t, known := kinds(s.Kind)
		condKind := s.Kind == "decide" || s.Kind == loopbackKind
		switch {
		case condKind && s.Cond != nil && strings.TrimSpace(s.Rule) != "":
			add(levelError, codeCond, i, "「%s」同时有结构化条件（cond）和旧规则（rule），删掉 rule", label(i))
		case condKind && s.Cond != nil:
			for _, msg := range condProblems(s.Cond) {
				add(levelError, codeCond, i, "「%s」%s", label(i), msg)
			}
			for n, it := range s.Cond.Items {
				fd := strings.TrimSpace(it.Field)
				if fd == "" {
					continue
				}
				if found, open := ff.lookup(i, fd); !found {
					names, total := ff.names(i, 12, fd)
					avail := "这一步还拿不到任何字段"
					if total > 0 {
						avail = "能用的有 " + strings.Join(names, "、")
						if total > len(names) {
							avail += fmt.Sprintf(" 等 %d 个", total)
						}
					}
					if open {
						add(levelWarning, codeCondField, i, "「%s」第 %d 条条件的字段 %s 不在已声明的字段里（手动发起时发起方、或没声明输出的上游节点可能带进来，执行时取不到就是空值）；%s", label(i), n+1, fd, avail)
					} else {
						add(levelError, codeCondField, i, "「%s」第 %d 条条件的字段 %s 这一步拿不到，执行时永远是空值；%s", label(i), n+1, fd, avail)
					}
				}
			}
		case condKind && strings.TrimSpace(s.Rule) != "":
			r := strings.TrimSpace(s.Rule)
			if c, legacy := legacyCond(r); legacy {
				add(levelWarning, codeLegacyRule, i, "「%s」的条件还是旧写法「%s」，执行仍按它判断；建议改成结构化条件（%s）", label(i), r, condText(c))
			} else {
				add(levelError, codeRuleText, i, "「%s」的条件「%s」是一句话，程序没法照着判断：改成结构化条件（字段 + 运算符 + 值，从这一步能拿到的字段里选，可多条且 / 或），这句话可以写进步骤说明", label(i), r)
			}
		case !condKind && (s.Cond != nil || strings.TrimSpace(s.Rule) != ""):
			add(levelWarning, codeUnusedCond, i, "「%s」不是条件分支或条件回退，写的条件不起作用", label(i))
		}

		if !known {
			continue
		}
		if t.Params != nil {
			var extra []string
			for k := range s.Config {
				if !slices.ContainsFunc(t.Params, func(p Param) bool { return p.Key == k }) {
					extra = append(extra, k)
				}
			}
			slices.Sort(extra)
			if len(extra) > 0 {
				if s.Kind == "auto" {
					add(levelWarning, codeAutoWrite, i, "「%s」是自动执行节点，只把输入原样传下去、不做任何写操作，配置 %s 不起作用；要改数据用对应的写节点：%s",
						label(i), strings.Join(extra, "、"), writeHints)
				} else {
					add(levelWarning, codeUnknownConfig, i, "「%s」（%s）不认配置 %s，它们不起作用", label(i), orDefault(t.Label, s.Kind), strings.Join(extra, "、"))
				}
			} else if s.Kind == "auto" && autoWriteRe.MatchString(s.Name+" "+s.Desc) {
				add(levelWarning, codeAutoWrite, i, "「%s」是自动执行节点，只把输入原样传下去、不做任何写操作，看名字像是要改数据：%s", label(i), writeHints)
			}
		}
	}
	return out
}

// errorsOf 只留错误。
func errorsOf(issues []Issue) []Issue {
	var out []Issue
	for _, x := range issues {
		if x.Level != levelWarning {
			out = append(out, x)
		}
	}
	return out
}

// warningsOf 只留警告。
func warningsOf(issues []Issue) []Issue {
	var out []Issue
	for _, x := range issues {
		if x.Level == levelWarning {
			out = append(out, x)
		}
	}
	return out
}
