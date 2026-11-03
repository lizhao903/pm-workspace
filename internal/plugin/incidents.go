package plugin

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

// 记运行异常句柄（INC-01a），见 docs/plugin-api.md 2.13.20。
// 实现是 internal/incident 的 Store，cmd/pmw 用 SetIncidents 接上；没接上时回 ErrNoIncidents。

// Incident 是插件记的一条运行异常。Fingerprint 必填，同一个问题用同一个指纹（建议「<插件 id 或对象前缀>:<对象 id>:<错误类型>」），
// 内核按它合并：次数加一、更新最近时间；已忽略、已解决的再出现会重新打开。Level 是 error / warn，空记 error。
// Module 是运行异常页的模块名（「项目原型」「IM 消息」「SOP」……），Context 的值可以是对象，键用给人看的中文。
type Incident struct {
	Fingerprint string
	Level       string
	Module      string
	Title       string
	Message     string
	Stack       string
	Context     map[string]any
}

// IncidentRecorder 落一条运行异常，*incident.Store 满足它。
type IncidentRecorder interface {
	Record(ctx context.Context, r incident.Report) (*incident.Incident, error)
}

// IncidentService 是插件用的运行异常句柄（Core.Incidents()）。
type IncidentService interface {
	// Record 记一条；来源记为 plugin:<插件 id>。参数不合法回错误，调用方一般只记日志、不挡自己的业务。
	Record(ctx context.Context, in Incident) error
}

// ErrNoIncidents：注册表没接上运行异常（测试里没接时）。
var ErrNoIncidents = errors.New("运行异常还没接上")

type incidentsBox struct{ r IncidentRecorder }

// SetIncidents 接上运行异常，可以在 Start 之后调（用时现取）。
func (r *Registry) SetIncidents(rec IncidentRecorder) { r.incidents.Store(&incidentsBox{rec}) }

func (c *core) Incidents() IncidentService { return incidentService{c} }

type incidentService struct{ c *core }

func (s incidentService) Record(ctx context.Context, in Incident) error {
	if strings.TrimSpace(in.Fingerprint) == "" {
		return errors.New("运行异常的 fingerprint 必填")
	}
	if in.Level == "" {
		in.Level = incident.LevelError
	}
	if s.c.reg == nil {
		return ErrNoIncidents
	}
	b := s.c.reg.incidents.Load()
	if b == nil || b.r == nil {
		return ErrNoIncidents
	}
	_, err := b.r.Record(context.WithoutCancel(ctx), incident.Report{
		Fingerprint: in.Fingerprint, Level: in.Level, Module: in.Module, Title: in.Title, Message: in.Message,
		Stack: in.Stack, Context: in.Context, Source: incident.SourcePlugin + s.c.id,
	})
	if err != nil {
		return fmt.Errorf("记运行异常：%w", err)
	}
	return nil
}
