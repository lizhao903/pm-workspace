package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 插件节点（SOP-03a）：别的插件登记的节点类型，经内核的 SOP 句柄取目录、执行（plugin/sopnode.go）。
// Run 返回 plugin.ErrWaiting 时步骤停在 running，输出里落一个 waiting 标记，重启后接着等；
// 提供节点的插件之后调 Core.SOP().Resume 唤醒，由引擎的 Resume 接住（engine.go）。
// 插件停用后节点不在目录里，流程定义不动，用到它的步骤执行时失败。

// kindLookup 查节点类型，保存校验用。
type kindLookup func(kind string) (NodeType, bool)

// kindsOf 认内置的、在跑的插件登记的；插件停用了但清单里声明过的也认，只是不查必填，免得改不动这条流程。
func kindsOf(c plugin.Core) kindLookup {
	return func(kind string) (NodeType, bool) {
		if t, ok := nodeType(kind); ok {
			return t, true
		}
		s := c.SOP()
		for _, n := range s.Nodes() {
			if n.Kind == kind {
				return pluginNodeType(n), true
			}
		}
		if id, ok := s.Provider(kind); ok {
			return NodeType{Kind: kind, Group: "插件", Required: []ConfigField{}, Source: id}, true
		}
		return NodeType{}, false
	}
}

func pluginNodeType(n plugin.SOPNode) NodeType {
	req := make([]ConfigField, len(n.Required))
	for i, f := range n.Required {
		req[i] = ConfigField{Key: f.Key, Label: f.Label}
	}
	return NodeType{Kind: n.Kind, Group: n.Group, Required: req, Source: n.Source}
}

// isPluginKind：不是内置节点的都按插件节点执行。
func isPluginKind(kind string) bool {
	_, builtin := nodeType(kind)
	return !builtin
}

const waitingKey = "waiting"

// pluginWaiting 是挂起等插件唤醒的步骤：插件节点、还在 running、输出里有 waiting 标记。
func pluginWaiting(def stepDef, s RunStep) bool {
	if s.Status != stRunning || !isPluginKind(def.Kind) {
		return false
	}
	_, ok := s.Output[waitingKey].(map[string]any)
	return ok
}

func waitingMark(kind, reason string) Json {
	return Json{waitingKey: map[string]any{"kind": kind, "reason": reason, "since": ts(now())}}
}

// runPluginNode 用提供节点的插件执行一次。输出要能转成 JSON。
func runPluginNode(ctx context.Context, c plugin.Core, wr writeRun, def stepDef, input Json) nodeResult {
	cfg := make(map[string]string, len(def.Config))
	for k, v := range def.Config {
		cfg[k] = v
	}
	out, err := c.SOP().RunNode(ctx, def.Kind, plugin.SOPNodeInput{
		RunID: wr.runID, FlowID: wr.flowID, Step: wr.step, Attempt: wr.attempt, Input: input, Config: cfg,
	})
	switch {
	case errors.Is(err, plugin.ErrWaiting):
		return nodeResult{waiting: waitReason(err)}
	case errors.Is(err, plugin.ErrNodeUnavailable):
		if _, ok := c.SOP().Provider(def.Kind); !ok {
			return nodeResult{err: fmt.Sprintf("节点类型 %s 不存在", def.Kind)}
		}
		return nodeResult{err: plugin.ErrNodeUnavailable.Error()}
	case err != nil:
		return nodeResult{err: err.Error()}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nodeResult{err: "节点的输出不能转成 JSON：" + err.Error()}
	}
	var res Json
	_ = json.Unmarshal(b, &res)
	return nodeResult{output: orEmpty(res)}
}

// waitReason 是挂起的原因：插件包了一层说明就用说明，去掉末尾的 ErrWaiting 原文。
func waitReason(err error) string {
	s, base := err.Error(), plugin.ErrWaiting.Error()
	for _, sep := range []string{"：", ": "} {
		if r := strings.TrimSuffix(s, sep+base); r != s && strings.TrimSpace(r) != "" {
			return r
		}
	}
	return s
}

/* ---------- 唤醒 ---------- */

// resumeMsg 是插件唤醒挂起步骤的请求，runner 处理完写库后回 reply。
type resumeMsg struct {
	caller, step string
	output       Json
	reply        chan error
}

// Resume 实现 plugin.SOPEngine：把唤醒交给这条执行的 runner，等它写完库。
// 服务刚起来时先等引擎把没结束的执行接着调度上。
func (e *engine) Resume(ctx context.Context, caller, runID, step string, output map[string]any) error {
	if _, err := e.waitReady(ctx); err != nil {
		return plainErr(err)
	}
	r := e.runner(runID)
	if r == nil {
		run, err := loadRun(ctx, e.c.Store(), runID)
		if err != nil {
			return plainErr(err)
		}
		if run.Stopped || run.EndedAt != nil {
			return errors.New("这次执行已经结束")
		}
		return errors.New("这次执行没在调度里，稍后再试")
	}
	b, err := json.Marshal(output)
	if err != nil {
		return fmt.Errorf("输出不能转成 JSON：%w", err)
	}
	var out Json
	_ = json.Unmarshal(b, &out)
	reply := make(chan error, 1)
	select {
	case r.inbox <- resumeMsg{caller: caller, step: step, output: orEmpty(out), reply: reply}:
	case <-r.done:
		return errors.New("这次执行已经结束")
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-reply:
		return err
	case <-r.done:
		select {
		case err := <-reply:
			return err
		default:
			return errors.New("这次执行已经结束")
		}
	case <-ctx.Done():
		return ctx.Err()
	}
}

// plainErr 去掉内部的错误分类前缀，给调 Resume 的插件看。
func plainErr(err error) error {
	if !errors.Is(err, errNotFound) && !errors.Is(err, errConflict) && !errors.Is(err, errValidation) {
		return err
	}
	_, msg, _ := cutKind(err)
	return errors.New(msg)
}

// resumeStep 在 runner 里结算被唤醒的步骤：只有挂起中的、调用方自己提供的节点能唤醒。
func (r *runner) resumeStep(m resumeMsg) error {
	i, ok := r.idx[m.step]
	if !ok {
		return fmt.Errorf("步骤 %s 不存在", m.step)
	}
	s := &r.run.Steps[i]
	def := r.defs[i]
	if !pluginWaiting(def, *s) {
		return fmt.Errorf("步骤 %s 没在等唤醒", m.step)
	}
	if id, _ := r.e.c.SOP().Provider(def.Kind); id != m.caller {
		return fmt.Errorf("步骤 %s 的节点 %s 不是插件 %s 提供的", m.step, def.Kind, m.caller)
	}
	r.cancelStep(i)
	t := now()
	s.Status, s.Output, s.EndedAt = stDone, m.output, &t
	r.log(i, t, fmt.Sprintf("插件 %s 唤醒，这一步完成", m.caller))
	return nil
}
