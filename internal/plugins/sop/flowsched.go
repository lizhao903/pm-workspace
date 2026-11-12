// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 定时触发（TSK-0463）：触发方式是 schedule 的流程，时间规则存在一条随流程管理的内核定时任务里（动作 sop、action.managed 为真），
// 一个流程最多一条，经 Core.SOP() 的 SaveFlowSchedule 等读写。流程接口的 schedule 字段就是这一条，没有为 null（「定时，未配置」）。
//
// 写流程时 body 可以带：
//   - schedule：{rule, enabled}，触发方式是 schedule 时新建或改这一条（rule、enabled 都可以不给，不给不改；还没有这一条时不给 rule 不新建）；
//     名字始终跟着流程名。触发方式不是 schedule 时忽略。
//   - schedule_off：触发方式从 schedule 改成别的时怎么处理这一条，disable 停用（默认）、delete 删掉。
//
// 旧的触发方式 daily（每天 09:00）、weekly（每周一 18:00）、cron（只是个「定时」标签）不再是选项：
// 写流程时传它们，存成 schedule，没有这一条时按等价规则新建；库里已有的由后台任务 legacyJob 转换（幂等，见 migrateLegacy）。

const (
	triggerSchedule = "schedule"
	offDisable      = "disable"
	offDelete       = "delete"
	// legacyEvery 是旧触发方式转换任务隔多久查一次：插件先于内核接上定时任务启动，第一次可能还转不了
	legacyEvery = time.Minute
)

// legacyRule 是旧触发方式等价的规则；cron 原来只是标签，没有规则，ok 为真、rule 为 nil。
func legacyRule(trigger string) (rule *plugin.SOPScheduleRule, ok bool) {
	switch trigger {
	case "daily":
		return &plugin.SOPScheduleRule{Freq: "daily", Time: "09:00", Weekdays: []int{}}, true
	case "weekly":
		return &plugin.SOPScheduleRule{Freq: "weekly", Time: "18:00", Weekdays: []int{1}}, true
	case "cron":
		return nil, true
	}
	return nil, false
}

// schedIn 是 body 里的 schedule 和 schedule_off。
type schedIn struct {
	Rule    *plugin.SOPScheduleRule
	Enabled *bool
	Off     string
	// legacy 是这次传的是旧触发方式，没有这一条时按它的等价规则建（认领用户手建的等价条目）
	legacy *plugin.SOPScheduleRule
}

// readSchedIn 读 body 里的 schedule、schedule_off，规则先校验，免得流程存了、定时任务没存上。
func readSchedIn(c plugin.Core, raw map[string]json.RawMessage) (*schedIn, error) {
	in := &schedIn{Off: offDisable}
	if v, ok := raw["schedule"]; ok && string(v) != "null" {
		var b struct {
			Rule    *plugin.SOPScheduleRule `json:"rule"`
			Enabled *bool                   `json:"enabled"`
		}
		if err := json.Unmarshal(v, &b); err != nil {
			return nil, apiErr(errValidation, "schedule 必须是对象：{rule, enabled}")
		}
		if b.Rule != nil {
			r, err := c.SOP().CheckScheduleRule(*b.Rule)
			if errors.Is(err, plugin.ErrNoSOPSchedules) {
				return nil, apiErr(errValidation, "定时任务没有启用，存不了定时规则")
			}
			if err != nil {
				return nil, apiErr(errValidation, "定时规则不对：%s", ruleReason(err))
			}
			b.Rule = &r
		}
		in.Rule, in.Enabled = b.Rule, b.Enabled
	}
	if v, ok := raw["schedule_off"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &in.Off); err != nil || (in.Off != offDisable && in.Off != offDelete) {
			return nil, apiErr(errValidation, "schedule_off 只能是 disable 或 delete")
		}
	}
	return in, nil
}

// ruleReason 去掉校验错误的「validation failed: 」前缀。
func ruleReason(err error) string {
	msg := err.Error()
	if _, after, ok := strings.Cut(msg, ": "); ok {
		return after
	}
	return msg
}

// normalizeTrigger 把旧触发方式换成 schedule，记下等价规则。
func normalizeTrigger(f *Flow, in *schedIn) {
	if rule, ok := legacyRule(f.Trigger); ok {
		f.Trigger = triggerSchedule
		in.legacy = rule
	}
}

// syncSchedule 在流程写进库之后改随它管理的定时任务；prev 是改之前的触发方式（新建为空）。
// 内核没接定时任务、又没要求改定时任务时什么都不做。
func syncSchedule(ctx context.Context, c plugin.Core, f Flow, prev string, in *schedIn) error {
	svc := c.SOP()
	if f.Trigger == triggerSchedule {
		q := plugin.SOPFlowScheduleInput{Name: f.Name, Rule: in.Rule, Enabled: in.Enabled}
		if q.Enabled == nil && prev != triggerSchedule {
			// 从别的触发方式改回定时：停用着的那一条重新启用
			on := true
			q.Enabled = &on
		}
		if q.Rule == nil && in.legacy != nil {
			cur, err := svc.FlowSchedule(ctx, f.ID)
			if err != nil && !errors.Is(err, plugin.ErrNoSOPSchedules) {
				return err
			}
			if cur == nil {
				q.Rule, q.Adopt = in.legacy, true
			}
		}
		_, err := svc.SaveFlowSchedule(ctx, f.ID, q)
		if errors.Is(err, plugin.ErrNoSOPSchedules) && in.Rule == nil {
			// 没明确要改定时任务（只是旧触发方式的等价规则、改名）时不拦；明确给了规则的在 readSchedIn 里已经拦了
			return nil
		}
		return err
	}
	cur, err := svc.FlowSchedule(ctx, f.ID)
	if errors.Is(err, plugin.ErrNoSOPSchedules) || (err == nil && cur == nil) {
		return nil
	}
	if err != nil {
		return err
	}
	if in.Off == offDelete {
		_, err = svc.DeleteFlowSchedule(ctx, f.ID)
		return err
	}
	if !cur.Enabled {
		return nil
	}
	off := false
	_, err = svc.SaveFlowSchedule(ctx, f.ID, plugin.SOPFlowScheduleInput{Name: f.Name, Enabled: &off})
	return err
}

// withSchedule 给流程填上随它管理的定时任务；内核没接定时任务时留 nil。
func withSchedule(ctx context.Context, c plugin.Core, f *Flow) error {
	sc, err := c.SOP().FlowSchedule(ctx, f.ID)
	if errors.Is(err, plugin.ErrNoSOPSchedules) {
		return nil
	}
	f.Schedule = sc
	return err
}

// legacyJob 把库里旧触发方式 daily、weekly、cron 的流程转成定时（TSK-0463）。幂等：转完的流程不再是旧触发方式，下次查不到；
// 中途失败（定时任务建了、流程没改）的下次重跑时找到已有的那一条，只改规则，不重复建。
func legacyJob(ctx context.Context, c plugin.Core) error {
	_, err := migrateLegacy(ctx, c)
	if errors.Is(err, plugin.ErrNoSOPSchedules) {
		return nil
	}
	return err
}

// legacyResult 是转换了哪些流程，测试和日志用。
type legacyResult struct {
	FlowID   string
	Trigger  string
	Schedule string // 定时任务 id，cron 没有规则时为空
	Adopted  bool
	Enabled  bool
}

// migrateLegacy 转换旧触发方式：
//   - 已经有随流程管理的那一条：只把规则改成等价规则（上次中途失败的情况）；
//   - 用户手建了一条指向这个流程、规则等价的定时任务：认领那一条（标成随流程管理，启停、名字照旧），不另建，免得同一时刻执行两次；
//   - 都没有：按等价规则新建。必填输入都有默认值（定时发起不带输入也能跑）时启用，否则建成停用，免得到点只记一条失败；
//   - cron 原来只是标签：只改触发方式，流程页显示「定时，未配置」。
//
// 流程的版本号、更新时间不动：这是数据转换，不是用户改的；开着编辑器的人保存时照常（旧值也认）。
func migrateLegacy(ctx context.Context, c plugin.Core) ([]legacyResult, error) {
	svc := c.SOP()
	if _, err := svc.FlowSchedules(ctx); err != nil {
		return nil, err
	}
	rows, err := c.Store().Query(ctx, `SELECT `+flowSel+` FROM sop_flows WHERE trigger_desc IN ('daily', 'weekly', 'cron') ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	var list []Flow
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		list = append(list, f)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []legacyResult
	for _, f := range list {
		rule, _ := legacyRule(f.Trigger)
		res := legacyResult{FlowID: f.ID, Trigger: f.Trigger}
		if rule != nil {
			_, startErr := fillInput(f, Json{})
			on := startErr == nil
			got, err := svc.SaveFlowSchedule(ctx, f.ID, plugin.SOPFlowScheduleInput{Name: f.Name, Rule: rule, Enabled: &on, Adopt: true})
			if err != nil {
				return out, err
			}
			res.Schedule, res.Adopted, res.Enabled = got.Schedule.ID, got.Adopted, got.Schedule.Enabled
		}
		if _, err := c.Store().Exec(ctx, `UPDATE sop_flows SET trigger_desc = ? WHERE id = ? AND trigger_desc = ?`, triggerSchedule, f.ID, f.Trigger); err != nil {
			return out, err
		}
		c.Log().Info("sop legacy trigger migrated", "flow", f.ID, "from", f.Trigger, "schedule", res.Schedule, "adopted", res.Adopted, "enabled", res.Enabled)
		out = append(out, res)
	}
	return out, nil
}
