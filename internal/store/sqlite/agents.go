// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// --- Agent 配置（AG-01b1，0032） ---

const agentCols = `id, name, description, color, avatar, provider_id, model, instructions,
	skills, mcps, kbs, triggers, thinking, enabled, created_at, updated_at`

// agentColors 同原型 AGENT_COLORS，新建没给颜色时随机挑一个。
var agentColors = []string{"#3d4fd6", "#7a4fd6", "#0f8a8a", "#b0570b", "#2f7d43", "#c0352b", "#e8590c", "#23221e"}

// agentIcons 同原型 AVATAR_ICONS。
var agentIcons = []string{"robot", "chat", "doc", "chart", "flow", "search", "mail", "calendar", "shield", "spark"}

var agentTriggerKinds = []string{domain.TriggerManual, domain.TriggerIM, domain.TriggerSchedule, domain.TriggerTask}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// 长度上限按字符数
const (
	agentNameMax         = 100
	agentDescMax         = 500
	agentInstructionsMax = 20000
	agentTriggerMax      = 200
	agentListMax         = 100
	agentImageMax        = 1 << 20 // 头像图片解码后的字节数
)

func agentTime() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// agentInvalid 是中文的校验错误，整句给前端，不拼字段名前缀。
func agentInvalid(format string, args ...any) error {
	return &wrapped{msg: fmt.Sprintf(format, args...), sentinel: domain.ErrValidation}
}

func scanAgent(sc rowScanner) (*domain.Agent, error) {
	var a domain.Agent
	var avatar, skills, mcps, kbs, triggers, created, updated string
	if err := sc.Scan(&a.ID, &a.Name, &a.Desc, &a.Color, &avatar, &a.ProviderID, &a.Model, &a.Instructions,
		&skills, &mcps, &kbs, &triggers, &a.Thinking, &a.Enabled, &created, &updated); err != nil {
		return nil, err
	}
	// 列是自己写的 JSON，解析失败按空值处理，不让一行坏数据拖垮整个列表
	_ = json.Unmarshal([]byte(avatar), &a.Avatar)
	_ = json.Unmarshal([]byte(skills), &a.Skills)
	_ = json.Unmarshal([]byte(mcps), &a.MCPs)
	_ = json.Unmarshal([]byte(kbs), &a.KBs)
	_ = json.Unmarshal([]byte(triggers), &a.Triggers)
	if a.Avatar.Kind == "" {
		a.Avatar.Kind = domain.AvatarText
	}
	if !slices.Contains(domain.ThinkingLevels, a.Thinking) {
		a.Thinking = domain.ThinkingDefault
	}
	a.Skills, a.MCPs, a.KBs = nonNilStrs(a.Skills), nonNilStrs(a.MCPs), nonNilStrs(a.KBs)
	if a.Triggers == nil {
		a.Triggers = []domain.AgentTrigger{}
	}
	a.CreatedAt, a.UpdatedAt = parseTime(created), parseTime(updated)
	return &a, nil
}

func nonNilStrs(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

func (s *Store) ListAgents(ctx context.Context) ([]*domain.Agent, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+agentCols+` FROM agents ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*domain.Agent{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetAgent(ctx context.Context, id string) (*domain.Agent, error) {
	a, err := scanAgent(s.db.R.QueryRowContext(ctx, `SELECT `+agentCols+` FROM agents WHERE id = ?`, id))
	if noRows(err) {
		return nil, notFound("agent")
	}
	if err != nil {
		return nil, fmt.Errorf("get agent: %w", err)
	}
	return a, nil
}

// CreateAgent 没给的字段取原型 newAgent 的默认值；provider_id 必填，model 不给取服务商的默认模型。
func (s *Store) CreateAgent(ctx context.Context, in domain.AgentInput) (*domain.Agent, error) {
	a := &domain.Agent{
		Color:    agentColors[rand.IntN(len(agentColors))],
		Avatar:   domain.AgentAvatar{Kind: domain.AvatarText},
		Skills:   []string{},
		MCPs:     []string{},
		KBs:      []string{},
		Triggers: []domain.AgentTrigger{{Kind: domain.TriggerManual}},
		Thinking: domain.ThinkingDefault,
		Enabled:  true,
	}
	if in.ProviderID == nil || strings.TrimSpace(*in.ProviderID) == "" {
		return nil, agentInvalid("模型必须带服务商：provider_id 必填")
	}
	if err := s.applyAgentInput(ctx, a, in); err != nil {
		return nil, err
	}
	if a.Model == "" {
		return nil, agentInvalid("模型还没选：model 必填，服务商也没有默认模型")
	}
	a.ID = idgen.Prefixed("ag")
	now := agentTime()
	args, err := agentArgs(a)
	if err != nil {
		return nil, err
	}
	// 工具授权按原型 newAgent 的默认值，和 Agent 同一个事务（AG-02a）
	if err := s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO agents (`+agentCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			append(append([]any{a.ID}, args...), now, now)...); err != nil {
			return fmt.Errorf("insert agent: %w", err)
		}
		return replaceGrants(ctx, tx, a.ID, newAgentGrants)
	}); err != nil {
		return nil, err
	}
	return s.GetAgent(ctx, a.ID)
}

// UpdateAgent 只改给了的字段；改了的照建时同样校验。
func (s *Store) UpdateAgent(ctx context.Context, id string, in domain.AgentInput) (*domain.Agent, error) {
	a, err := s.GetAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	if in.Model != nil && strings.TrimSpace(*in.Model) == "" {
		return nil, agentInvalid("模型还没选：model 不能为空")
	}
	if err := s.applyAgentInput(ctx, a, in); err != nil {
		return nil, err
	}
	args, err := agentArgs(a)
	if err != nil {
		return nil, err
	}
	res, err := s.db.W.ExecContext(ctx, `UPDATE agents SET name=?, description=?, color=?, avatar=?, provider_id=?, model=?,
		instructions=?, skills=?, mcps=?, kbs=?, triggers=?, thinking=?, enabled=?, updated_at=? WHERE id=?`,
		append(args, agentTime(), id)...)
	if err != nil {
		return nil, fmt.Errorf("update agent: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound("agent")
	}
	return s.GetAgent(ctx, id)
}

func (s *Store) DeleteAgent(ctx context.Context, id string) (*domain.Agent, error) {
	a, err := s.GetAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM agents WHERE id = ?`, id)
	if err != nil {
		return nil, fmt.Errorf("delete agent: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound("agent")
	}
	// 授权跟着 Agent 走；要人确认的调用留着，会话回放要用
	if _, err := s.db.W.ExecContext(ctx, `DELETE FROM agent_tool_grants WHERE agent_id = ?`, id); err != nil {
		return nil, fmt.Errorf("delete agent grants: %w", err)
	}
	return a, nil
}

func (s *Store) CountAgentSessions(ctx context.Context, agentID string) (int, error) {
	var n int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_sessions WHERE agent_id = ?`, agentID).Scan(&n); err != nil {
		return 0, fmt.Errorf("count agent sessions: %w", err)
	}
	return n, nil
}

// agentArgs 是 name 到 enabled 这 13 列的参数，顺序同 agentCols 去掉 id 和时间戳。
func agentArgs(a *domain.Agent) ([]any, error) {
	enc := func(v any) (string, error) {
		b, err := json.Marshal(v)
		if err != nil {
			return "", fmt.Errorf("encode agent: %w", err)
		}
		return string(b), nil
	}
	avatar, err := enc(a.Avatar)
	if err != nil {
		return nil, err
	}
	out := []any{a.Name, a.Desc, a.Color, avatar, a.ProviderID, a.Model, a.Instructions}
	for _, v := range []any{a.Skills, a.MCPs, a.KBs, a.Triggers} {
		j, err := enc(v)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return append(out, a.Thinking, a.Enabled), nil
}

// applyAgentInput 把给了的字段校验后写到 a 上。
func (s *Store) applyAgentInput(ctx context.Context, a *domain.Agent, in domain.AgentInput) error {
	if in.Name != nil {
		a.Name = strings.TrimSpace(*in.Name)
	}
	if a.Name == "" {
		return agentInvalid("名称还没填")
	}
	if utf8.RuneCountInString(a.Name) > agentNameMax {
		return agentInvalid("名称最多 %d 字", agentNameMax)
	}
	if in.Desc != nil {
		a.Desc = strings.TrimSpace(*in.Desc)
		if utf8.RuneCountInString(a.Desc) > agentDescMax {
			return agentInvalid("说明最多 %d 字", agentDescMax)
		}
	}
	if in.Color != nil {
		c := strings.TrimSpace(*in.Color)
		if !hexColor.MatchString(c) {
			return agentInvalid("头像底色要写成 #rrggbb")
		}
		a.Color = strings.ToLower(c)
	}
	if in.Avatar != nil {
		av, err := checkAvatar(*in.Avatar)
		if err != nil {
			return err
		}
		a.Avatar = av
	}
	if in.ProviderID != nil {
		pid := strings.TrimSpace(*in.ProviderID)
		if pid == "" {
			return agentInvalid("模型必须带服务商：provider_id 不能为空")
		}
		var exists int
		if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_providers WHERE id = ?`, pid).Scan(&exists); err != nil {
			return fmt.Errorf("check provider: %w", err)
		}
		if exists == 0 {
			return agentInvalid("服务商 %s 不存在", pid)
		}
		a.ProviderID = pid
	}
	if in.Model != nil {
		a.Model = strings.TrimSpace(*in.Model)
	}
	if a.Model == "" && in.ProviderID != nil {
		// 没给模型时取服务商的默认模型，同 POST /api/agent/sessions
		var m string
		if err := s.db.R.QueryRowContext(ctx, `SELECT model FROM agent_providers WHERE id = ?`, a.ProviderID).Scan(&m); err != nil {
			return fmt.Errorf("get provider model: %w", err)
		}
		a.Model = strings.TrimSpace(m)
	}
	if in.Instructions != nil {
		a.Instructions = strings.TrimSpace(*in.Instructions)
		if utf8.RuneCountInString(a.Instructions) > agentInstructionsMax {
			return agentInvalid("指令最多 %d 字", agentInstructionsMax)
		}
	}
	for _, f := range []struct {
		label string
		in    *[]string
		out   *[]string
	}{{"技能", in.Skills, &a.Skills}, {"MCP / 连接器", in.MCPs, &a.MCPs}, {"知识库", in.KBs, &a.KBs}} {
		if f.in == nil {
			continue
		}
		ids, err := cleanIDs(f.label, *f.in)
		if err != nil {
			return err
		}
		*f.out = ids
	}
	if in.Triggers != nil {
		ts, err := checkTriggers(*in.Triggers)
		if err != nil {
			return err
		}
		a.Triggers = ts
	}
	if in.Thinking != nil {
		t := strings.TrimSpace(*in.Thinking)
		if t == "" {
			t = domain.ThinkingDefault
		}
		if !slices.Contains(domain.ThinkingLevels, t) {
			return agentInvalid("思考只能是 default / off / low / medium / high，给的是 %q", t)
		}
		a.Thinking = t
	}
	if in.Enabled != nil {
		a.Enabled = *in.Enabled
	}
	return nil
}

func checkAvatar(av domain.AgentAvatar) (domain.AgentAvatar, error) {
	av.Value = strings.TrimSpace(av.Value)
	switch av.Kind {
	case domain.AvatarText:
		if utf8.RuneCountInString(av.Value) > 2 {
			return av, agentInvalid("头像文字只能一到两个字")
		}
	case domain.AvatarIcon:
		if !slices.Contains(agentIcons, av.Value) {
			return av, agentInvalid("头像图标 %q 不在内置图标里", av.Value)
		}
	case domain.AvatarImage:
		head, data, ok := strings.Cut(av.Value, ",")
		if !ok || !strings.HasPrefix(head, "data:image/") || !strings.HasSuffix(head, ";base64") {
			return av, agentInvalid("头像图片要是图片的 data URL（data:image/...;base64,...）")
		}
		if base64.StdEncoding.DecodedLen(len(data)) > agentImageMax+3 {
			return av, agentInvalid("头像图片要在 1MB 以内")
		}
		b, err := base64.StdEncoding.DecodeString(data)
		if err != nil {
			return av, agentInvalid("头像图片的 base64 不对")
		}
		if len(b) > agentImageMax {
			return av, agentInvalid("头像图片要在 1MB 以内")
		}
	default:
		return av, agentInvalid("头像 kind 只能是 text / icon / image，给的是 %q", av.Kind)
	}
	return av, nil
}

// cleanIDs 去空白、去重，保持顺序。
func cleanIDs(label string, in []string) ([]string, error) {
	out := []string{}
	for _, id := range in {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, agentInvalid("%s里有空的 id", label)
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) > agentListMax {
		return nil, agentInvalid("%s最多挂 %d 个", label, agentListMax)
	}
	return out, nil
}

func checkTriggers(in []domain.AgentTrigger) ([]domain.AgentTrigger, error) {
	if len(in) == 0 {
		return nil, agentInvalid("触发方式至少要有一条")
	}
	if len(in) > agentListMax {
		return nil, agentInvalid("触发方式最多 %d 条", agentListMax)
	}
	out := make([]domain.AgentTrigger, 0, len(in))
	for _, t := range in {
		if !slices.Contains(agentTriggerKinds, t.Kind) {
			return nil, agentInvalid("触发方式 kind 只能是 manual / im / schedule / task，给的是 %q", t.Kind)
		}
		t.Detail = strings.TrimSpace(t.Detail)
		if utf8.RuneCountInString(t.Detail) > agentTriggerMax {
			return nil, agentInvalid("触发条件最多 %d 字", agentTriggerMax)
		}
		m, err := checkTriggerMatch(t.Kind, t.Match)
		if err != nil {
			return nil, err
		}
		t.Match = m
		out = append(out, t)
	}
	return out, nil
}

// checkTriggerMatch 按 kind 只留自己的字段（AG-01b4）；manual、schedule 没有条件，给了也丢掉。
func checkTriggerMatch(kind string, m *domain.TriggerMatch) (*domain.TriggerMatch, error) {
	if m == nil {
		return nil, nil
	}
	switch kind {
	case domain.TriggerTask:
		tags := []string{}
		for _, t := range m.Tags {
			if t = strings.TrimSpace(t); t != "" && !slices.Contains(tags, t) {
				tags = append(tags, t)
			}
		}
		if len(tags) > agentListMax {
			return nil, agentInvalid("任务触发的标签最多 %d 个", agentListMax)
		}
		if !m.Assigned && len(tags) == 0 {
			return nil, agentInvalid("任务触发至少要选「分配给它」或者填标签")
		}
		return &domain.TriggerMatch{Assigned: m.Assigned, Tags: tags}, nil
	case domain.TriggerIM:
		return &domain.TriggerMatch{Tags: []string{}, ConnectorID: strings.TrimSpace(m.ConnectorID),
			Channel: strings.TrimSpace(m.Channel), ConversationID: strings.TrimSpace(m.ConversationID), OnlyMe: m.OnlyMe}, nil
	}
	return nil, nil
}

// --- Agent 这一块的小设置（0045 agent_settings） ---

func (s *Store) AgentSetting(ctx context.Context, key string) (json.RawMessage, error) {
	var v string
	err := s.db.R.QueryRowContext(ctx, `SELECT value FROM agent_settings WHERE key = ?`, key).Scan(&v)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get agent setting: %w", err)
	}
	return json.RawMessage(v), nil
}

func (s *Store) SetAgentSetting(ctx context.Context, key string, value json.RawMessage) error {
	if !json.Valid(value) {
		return agentInvalid("设置 %s 的值不是合法的 JSON", key)
	}
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO agent_settings (key, value, updated_at) VALUES (?,?,?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, string(value), agentTime()); err != nil {
		return fmt.Errorf("set agent setting: %w", err)
	}
	return nil
}
