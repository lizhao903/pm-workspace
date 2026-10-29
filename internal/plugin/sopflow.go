package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// 插件随安装写进 SOP 的内置流程（VID-03d），见 docs/plugin-api.md 2.7。
// 内核只转交：插件经 Core.SOP().InstallFlow 写入、RemoveFlow 撤下，SOP 插件登记的执行引擎另外实现 SOPFlowInstaller 才接得住。
// 流程 id 必须是 sop_<插件 id>_ 开头，靠前缀认归属：一个插件只能写入、撤下自己的流程。
// 用户复制出来的副本是新 id，不归插件，撤下时不会碰到。

// ErrNoSOPFlowInstaller：SOP 编排插件没在跑，或者它不支持写入内置流程。
var ErrNoSOPFlowInstaller = errors.New("SOP 编排插件没在运行，或者不支持写入内置流程")

// SOPFlowTemplate 是一条内置流程，形状同 POST /api/sop/flows 的请求体（原型 web-next/src/sopflow.ts 的 Sop）。
type SOPFlowTemplate struct {
	ID      string          `json:"id"` // sop_<插件 id>_ 开头
	Name    string          `json:"name"`
	Desc    string          `json:"desc"`
	Trigger string          `json:"trigger"`
	Fields  json.RawMessage `json:"fields"`
	Steps   json.RawMessage `json:"steps"`
	Layout  json.RawMessage `json:"layout,omitempty"`
}

// SOPFlowInstaller 是 SOP 插件的执行引擎可选实现的接口。caller 是调用的插件 id，id 前缀内核已经查过。
type SOPFlowInstaller interface {
	// InstallFlow 没有这个 id 的流程时按第 1 版写入，回 true；已经有了（用户可能改过）不动，回 false。定义不合法回错误。
	InstallFlow(ctx context.Context, caller string, t SOPFlowTemplate) (bool, error)
	// RemoveFlow 删掉还是第 1 版、没有进行中的执行、没被定时任务引用的流程，回 true；
	// 不存在回 false、nil；改过或删不了回 false 和原因（不算出错，调用方留着它）。
	RemoveFlow(ctx context.Context, caller, id string) (bool, string, error)
}

var flowTemplateIDRe = regexp.MustCompile(`^sop_[a-z0-9_]{1,60}$`)

// templateID 查 id 是不是本插件的：sop_<插件 id>_ 开头，后面同 SOP 流程 id 的规则。
func (s sopService) templateID(id string) error {
	prefix := "sop_" + s.c.id + "_"
	if !strings.HasPrefix(id, prefix) || len(id) == len(prefix) || !flowTemplateIDRe.MatchString(id) {
		return fmt.Errorf("内置流程的 id 必须是 %s 开头，后面只能是小写字母、数字、下划线", prefix)
	}
	return nil
}

func (s sopService) installer() (SOPFlowInstaller, error) {
	eng, err := s.engine()
	if err != nil {
		return nil, ErrNoSOPFlowInstaller
	}
	in, ok := eng.(SOPFlowInstaller)
	if !ok {
		return nil, ErrNoSOPFlowInstaller
	}
	return in, nil
}

func (s sopService) InstallFlow(ctx context.Context, t SOPFlowTemplate) (bool, error) {
	if err := s.templateID(t.ID); err != nil {
		return false, err
	}
	in, err := s.installer()
	if err != nil {
		return false, err
	}
	return in.InstallFlow(ctx, s.c.id, t)
}

func (s sopService) RemoveFlow(ctx context.Context, id string) (bool, string, error) {
	if err := s.templateID(id); err != nil {
		return false, "", err
	}
	in, err := s.installer()
	if err != nil {
		return false, "", err
	}
	return in.RemoveFlow(ctx, s.c.id, id)
}
