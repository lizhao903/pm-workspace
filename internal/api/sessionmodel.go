package api

// 会话里换模型（TSK-0720）：PATCH /api/agent/sessions/{id} 带 provider_id / model / model_override 时走这里。
//
// 规则（契约「Agent 对话」的「会话换模型」）：
//   - 挂 Agent 的会话：给了 provider_id / model 就是这个会话单独选的（model_override 置 true），之后按它跑，
//     Agent 改默认不影响它；model_override: false 是改回跟随 Agent 当前的默认。
//   - 不挂 Agent 的会话：provider_id / model 本来就是自己的，不认 model_override。
//   - 实际用的服务商或模型变了，会话里记一条 notice「已切换到 <服务商> · <模型>」，不进模型的上下文；
//     这一轮还在跑时 409，不排队。历史消息不重算。

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// sessionModelMax 是模型名的上限，模型 id 再长也到不了这么长
const sessionModelMax = 200

// switchSessionModel 换会话用的服务商和模型，回换完的会话（provider_id / model 是实际用的）。
// 三个参数都是 nil 表示 PATCH 里没给，调用方不该调进来。
func (s *Server) switchSessionModel(ctx context.Context, id string, providerID, model *string, override *bool) (*domain.AgentSession, error) {
	sess, err := s.st.GetAgentSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if sess.AgentID == nil && override != nil {
		return nil, validationf("这个会话不挂 Agent，没有 Agent 默认可跟随，不认 model_override")
	}
	if sess.AgentDeleted {
		return nil, conflictf("Agent 已删除，这个会话只能回看，换不了模型")
	}
	follow := override != nil && !*override
	if follow && (providerID != nil || model != nil) {
		return nil, validationf("改回跟随 Agent 默认时不用给 provider_id 和 model")
	}

	var pid, m string
	if follow {
		ag, err := s.st.GetAgent(ctx, *sess.AgentID)
		if errors.Is(err, domain.ErrNotFound) {
			return nil, conflictf("Agent 已删除，这个会话只能回看，换不了模型")
		}
		if err != nil {
			return nil, err
		}
		pid, m = ag.ProviderID, ag.Model
	} else {
		pid, m = sess.ProviderID, sess.Model
		if providerID != nil {
			if v := strings.TrimSpace(*providerID); v != pid {
				// 换了服务商没给模型，取新服务商的默认模型
				pid, m = v, ""
			}
		}
		if model != nil {
			m = strings.TrimSpace(*model)
		}
		if pid == "" {
			return nil, validationf("provider_id 不能为空")
		}
		if utf8.RuneCountInString(m) > sessionModelMax {
			return nil, validationf("模型名太长了，最多 %d 字", sessionModelMax)
		}
		p, err := s.st.GetProvider(ctx, pid)
		if errors.Is(err, domain.ErrNotFound) {
			return nil, validationf("服务商 %s 不存在", pid)
		}
		if err != nil {
			return nil, err
		}
		if !p.Enabled {
			return nil, validationf("服务商「%s」已停用，换一个", p.Name)
		}
		if m == "" {
			m = p.Model
		}
		if m == "" {
			return nil, validationf("服务商「%s」没设默认模型，要指定 model", p.Name)
		}
	}

	pinned := sess.AgentID != nil && !follow
	changed := pid != sess.ProviderID || m != sess.Model
	if !changed && pinned == sess.ModelOverride {
		return sess, nil
	}
	if changed && s.turns.running(id) {
		return nil, conflictf("正在回复，等这一轮跑完再换模型")
	}
	out, err := s.st.SetAgentSessionModel(ctx, id, pid, m, pinned)
	if err != nil {
		return nil, err
	}
	if changed {
		s.noteModelSwitch(ctx, out, follow)
		// 读回来：消息数、更新时间带上刚记的那条提示
		if again, err := s.st.GetAgentSession(ctx, id); err == nil {
			out = again
		}
	}
	return out, nil
}

// noteModelSwitch 在会话里记一条「已切换到 <服务商> · <模型>」，给人看、不进模型的上下文。记不上只写日志。
func (s *Server) noteModelSwitch(ctx context.Context, sess *domain.AgentSession, follow bool) {
	name := sess.ProviderID
	if p, err := s.st.GetProvider(ctx, sess.ProviderID); err == nil && strings.TrimSpace(p.Name) != "" {
		name = p.Name
	}
	msg := "已切换到 " + name + " · " + sess.Model
	if follow {
		msg += "（跟随 Agent 默认）"
	}
	msg += "，之后的回复用它，之前的回复不变"
	if _, err := s.st.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: sess.ID, Role: domain.RoleNotice, Content: msg, ProviderID: sess.ProviderID, Model: sess.Model,
	}); err != nil {
		s.log.Warn("save model switch note failed", "session", sess.ID, "err", err)
	}
}
