package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// defaultOllama 是「一个供应商都没配」时自动建出来的那一条。
// 用户本机已经装了 Ollama 并拉了这个模型，对话框因此开箱即用——
// 否则第一次打开工作台想记条待办，得先绕到设置页配一遍供应商才能说话。
const (
	defaultOllamaName    = "本机 Ollama"
	defaultOllamaBaseURL = "http://localhost:11434"
	defaultOllamaModel   = "qwen3.5:4b"
)

// --- 会话 ---

// handleListAgentSessions 要求调用方明确说自己要哪一批：object_id 给某个工作对象的
// （详情抽屉用），unscoped=true 给全局的（底部对话框用）。两个都不给返回空列表——
// 这个默认值是故意反直觉的，理由见 store.ListAgentSessions。
//
// 两个都给时以 object_id 为准，不报 400：这两个参数在前端是两处独立代码各自拼的，
// 真同时出现只可能是拼串出错，而此时返回「这个对象的会话」至少还是一批说得通的数据，
// 400 则会让抽屉整个打不开。
func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	p := newParams(r)
	unscoped, err := p.boolean("unscoped")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListAgentSessions(r.Context(), domain.AgentSessionFilter{
		ObjectID: p.str("object_id"),
		Unscoped: unscoped,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

type createSessionReq struct {
	Title      string `json:"title"`
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
	Workdir    string `json:"workdir"`
	// ObjectID 省略即全局会话。挂给一个不存在的对象是 404，不是静默落成全局——
	// 这是前端显式指定的归属，猜错了会话就出现在错误的地方。
	// （/api/agent/chat 里的同名字段是另一回事，见 sessionForChat。）
	ObjectID string `json:"object_id"`
	// AgentID 给了就用这个 Agent 的服务商和模型，provider_id / model 忽略；Agent 不存在 404。
	AgentID string `json:"agent_id"`
	// SourceRef 是会话的来源（0047），JSON 对象，最多 sourceRefMax 字节；null 和不给一样。
	// 只在 POST /api/agent/sessions 认，chat 里新建会话不带。
	SourceRef json.RawMessage `json:"source_ref"`
}

// sourceRefMax 是会话来源 JSON 的上限：来源只放定位用的几项和一段摘录，不放全文
const sourceRefMax = 16 << 10

// parseSourceRef 校验会话来源：不给、null 为 nil；不是对象、太长 400。
func parseSourceRef(raw json.RawMessage) (map[string]any, error) {
	t := strings.TrimSpace(string(raw))
	if t == "" || t == "null" {
		return nil, nil
	}
	if len(t) > sourceRefMax {
		return nil, validationf("source_ref 太长了，最多 %d 字节", sourceRefMax)
	}
	var out map[string]any
	if !strings.HasPrefix(t, "{") || json.Unmarshal([]byte(t), &out) != nil {
		return nil, validationf("source_ref 必须是 JSON 对象")
	}
	return out, nil
}

func (s *Server) handleCreateAgentSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionReq
	// 字段全是可选的，空 body 等同于「用默认供应商开一个全局的新会话」。
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.newSession(r.Context(), req)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

// newSession 建会话，并在 provider_id / model 缺省时补上默认值。
func (s *Server) newSession(ctx context.Context, req createSessionReq) (*domain.AgentSession, error) {
	providerID, model := strings.TrimSpace(req.ProviderID), strings.TrimSpace(req.Model)
	var agentID *string
	if v := strings.TrimSpace(req.AgentID); v != "" {
		ag, err := s.st.GetAgent(ctx, v)
		if err != nil {
			return nil, err
		}
		agentID, providerID, model = &ag.ID, ag.ProviderID, ag.Model
	}
	if agentID == nil && (providerID == "" || model == "") {
		p, err := s.resolveProvider(ctx, providerID)
		if err != nil {
			return nil, err
		}
		providerID = p.ID
		if model == "" {
			model = p.Model
		}
	}
	var objectID *string
	if v := strings.TrimSpace(req.ObjectID); v != "" {
		objectID = &v
	}
	sourceRef, err := parseSourceRef(req.SourceRef)
	if err != nil {
		return nil, err
	}
	return s.st.CreateAgentSession(ctx, &domain.AgentSession{
		Title:      req.Title,
		ObjectID:   objectID,
		ProviderID: providerID,
		Model:      model,
		Workdir:    strings.TrimSpace(req.Workdir),
		AgentID:    agentID,
		SourceRef:  sourceRef,
	})
}

func (s *Server) handleUpdateAgentSession(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	raw, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	title, err := patchField[string](raw, "title", "a string")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	workdir, err := patchField[string](raw, "workdir", "a string")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	providerID, err := patchField[string](raw, "provider_id", "a string")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	model, err := patchField[string](raw, "model", "a string")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	override, err := patchField[bool](raw, "model_override", "a boolean")
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// 换模型（TSK-0720）先做：校验不过整条 PATCH 不生效
	var out *domain.AgentSession
	if providerID != nil || model != nil || override != nil {
		if out, err = s.switchSessionModel(r.Context(), r.PathValue("id"), providerID, model, override); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if out == nil || title != nil || workdir != nil {
		if out, err = s.st.UpdateAgentSession(r.Context(), r.PathValue("id"), title, workdir, nil, nil); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	respondData(w, http.StatusOK, out)
}

func (s *Server) handleDeleteAgentSession(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteAgentSession(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

func (s *Server) handleListAgentMessages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// 先确认会话存在：直接查消息的话，一个不存在的会话会安静地回一个空列表。
	if _, err := s.st.GetAgentSession(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListAgentMessages(r.Context(), id, 0)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// maxRemoveMessages 一次最多移除的消息条数
const maxRemoveMessages = 500

// handleRemoveAgentMessages 从会话里移除几条消息（SPEC-sessions-1.43）：body {ids}，回 {removed}。
// 这一轮还在跑时 409，免得删到正在写的回复；移除后这些消息不再进模型的上下文，已经执行的工具调用不撤回
func (s *Server) handleRemoveAgentMessages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	ids := make([]string, 0, len(req.IDs))
	seen := map[string]bool{}
	for _, x := range req.IDs {
		if x = strings.TrimSpace(x); x != "" && !seen[x] {
			seen[x] = true
			ids = append(ids, x)
		}
	}
	if len(ids) == 0 || len(ids) > maxRemoveMessages {
		s.fail(w, r, validationf("ids 要 1 到 %d 条", maxRemoveMessages))
		return
	}
	if s.turns.running(id) {
		s.fail(w, r, conflictf("这一轮还在跑，先停止或等它跑完再移除"))
		return
	}
	n, err := s.st.DeleteAgentMessages(r.Context(), id, ids)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, map[string]any{"session_id": id, "removed": n})
}

func (s *Server) handleListAgentArtifacts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.st.GetAgentSession(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	// 产物已经统一到 artifacts 表，这里按会话过滤。路由保持原样是因为
	// 「这个会话产出了什么」仍然是对话框侧栏的一个真实读法；
	// 它现在只是同一份数据的一个切片，而不是另一份数据。
	items, _, err := s.st.ListArtifacts(r.Context(), domain.ArtifactFilter{SessionID: id})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// --- 产物目录检查 ---

func (s *Server) handleCheckWorkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	// 目录不可用不是 HTTP 错误，是一个正常的检查结果：一律 200，前端看字段。
	respondData(w, http.StatusOK, agent.CheckWorkdir(req.Path))
}

// --- 对话 ---

type chatReq struct {
	SessionID  string `json:"session_id"`
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
	Workdir    string `json:"workdir"`
	// ObjectID 是用户此刻打开的工作对象。可以不传（全局对话框里没选中任何东西时）。
	ObjectID string `json:"object_id"`
	// AgentID 只在没给 session_id、要新建会话时用，同 POST /api/agent/sessions。
	AgentID string `json:"agent_id"`
	Message string `json:"message"`
}

// handleAgentChat 是唯一的流式接口。
//
// 错误处理在这里是反常的：一旦 SSE 的响应头发出去，就不能再改状态码了，
// 所以除了「还没开始写流」的那几步参数校验之外，后面所有失败都只能作为
// 一条 error 事件写进流里，然后正常结束。前端据此在气泡里显示错误。
func (s *Server) handleAgentChat(w http.ResponseWriter, r *http.Request) {
	var req chatReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		s.fail(w, r, validationf("message is required"))
		return
	}
	// 没有 Flusher 就没法做流式，这种情况只可能是中间件包错了，属于服务端 bug。
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, r, fmt.Errorf("response writer does not support streaming"))
		return
	}

	ctx := r.Context()

	// 对象在这里解析一次，两处共用：后端自动建会话时要把归属一起落库，
	// Runner 要拿它做指代。查不到一律当没传（见 currentObject），所以一个失效的
	// 选中态最多让这条会话落成全局的，不会把整条流打断。
	object := s.currentObject(ctx, req.ObjectID)

	// 要新建挂 Agent 的会话时先查 Agent，停用的不留一条空会话
	if strings.TrimSpace(req.SessionID) == "" && strings.TrimSpace(req.AgentID) != "" {
		if _, err := s.st.GetAgent(ctx, strings.TrimSpace(req.AgentID)); err != nil {
			s.fail(w, r, err)
			return
		}
		if _, err := s.chatAgent(ctx, strings.TrimSpace(req.AgentID)); err != nil {
			s.fail(w, r, err)
			return
		}
	}

	// 准备阶段的失败仍然可以走普通 JSON 错误，因为还没写过任何响应。
	session, err := s.sessionForChat(ctx, req, object)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 挂了 Agent 的会话：没单独换过模型的按 Agent 当前的服务商和模型跑，换过的按会话自己的（TSK-0720）；删了或停用了回 409
	var ag *domain.Agent
	if session.AgentID != nil {
		if ag, err = s.chatAgent(ctx, *session.AgentID); err != nil {
			s.fail(w, r, err)
			return
		}
		session = followAgentModel(session, ag)
	}
	provider, err := s.resolveProvider(ctx, session.ProviderID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 明文密钥在这里取出，只交给 agent.New 放进请求头/query，绝不进响应或日志。
	key, err := s.st.ProviderAPIKey(ctx, provider.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	chat, err := agent.New(provider.Kind, provider.BaseURL, key)
	if err != nil {
		s.fail(w, r, validationf("%v", err))
		return
	}

	model := session.Model
	if model == "" {
		model = provider.Model
	}
	if model == "" {
		s.fail(w, r, validationf("该供应商尚未设置模型，请先在设置页填写模型名"))
		return
	}

	// 工具授权（AG-02a）：没挂 Agent 的会话为 nil，行为不变
	policy, err := s.agentPolicy(ctx, ag)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// 从这里开始就是流了。
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// 关掉 nginx 一类反代的缓冲，否则增量会被攒起来一次性吐出，流式就白做了。
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	emit := func(ev agent.StreamEvent) {
		writeSSE(w, ev)
		flusher.Flush()
	}

	runner := &agent.Runner{
		Store: s.st, Chat: chat, Model: model, Session: session,
		Object: object, Agent: ag, Skills: s.agentSkills(ctx, ag), Policy: policy,
	}
	baseCtx, cancel := agentRunCtx(ctx)
	defer cancel()
	runCtx, done := s.turns.start(baseCtx, session.ID)
	defer done()
	msgID, err := runner.Run(runCtx, req.Message, emit)
	if err != nil && stoppedByUser(runCtx) {
		s.noteAgentStopped(baseCtx, session.ID)
		emit(agent.StreamEvent{Type: "error", Message: "已手动停止"})
		return
	}
	if err != nil {
		s.log.Warn("agent chat failed",
			"session", session.ID, "provider", provider.ID, "kind", provider.Kind, "err", err)
		s.noteAgentFailure(baseCtx, session.ID, err)
		emit(agent.StreamEvent{Type: "error", Message: err.Error()})
		return
	}
	emit(agent.StreamEvent{Type: "done", SessionID: session.ID, MessageID: msgID})
}

// followAgentModel 没单独换过模型的会话用 Agent 当前的服务商和模型（读会话时已经是，这里防读和跑之间 Agent 刚改过）。
// 不写回库：读会话时现算，快照只在换模型时记。
func followAgentModel(sess *domain.AgentSession, ag *domain.Agent) *domain.AgentSession {
	if sess.ModelOverride || ag == nil {
		return sess
	}
	c := *sess
	c.ProviderID, c.Model = ag.ProviderID, ag.Model
	return &c
}

// agentRunTimeout 是一轮对话（含工具调用）最长跑多久。
const agentRunTimeout = 10 * time.Minute

// agentRunCtx 让一轮对话和浏览器连接脱钩：页面刷新、切走、关掉对话框时照样跑完并存下回复。
// 原来绑在请求上，连接一断就取消、什么都不存，历史里只剩已经执行了的工具调用，后面没有下文。
// 连接断了以后写流只是写不出去，不影响执行。
func agentRunCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), agentRunTimeout)
}

// noteAgentStopped 手动停止时存一句说明，和出错区分开。
func (s *Server) noteAgentStopped(ctx context.Context, sessionID string) {
	msg := "已手动停止这一轮。上面已经执行的工具调用不会撤回，要接着做可以再发一句。"
	if _, e := s.st.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: sessionID, Role: domain.RoleAssistant, Content: msg}); e != nil {
		s.log.Warn("save agent stop note failed", "session", sessionID, "err", e)
	}
}

// noteAgentFailure 这一轮没跑完时存一条说明：流里的 error 事件只有当时开着页面的人看得到，
// 不存的话回头翻历史只看到工具调用、看不出为什么停了。存失败只记日志。
func (s *Server) noteAgentFailure(ctx context.Context, sessionID string, err error) {
	msg := "这一轮没跑完：" + err.Error() + "。上面已经执行的工具调用不会撤回，可以把要求再发一次接着做。"
	if _, e := s.st.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: sessionID, Role: domain.RoleAssistant, Content: msg}); e != nil {
		s.log.Warn("save agent failure note failed", "session", sessionID, "err", e)
	}
}

// currentObject 取出「用户此刻打开的那一条」。
//
// 查不到一律当没传，绝不让这次对话失败：前端的选中态可能指向一个刚被删掉的对象，
// 为此把整条流打断，用户看到的是「我明明在打字，它报了个错」，而代价只是模型少知道
// 一句「这个」指谁——它还可以反问，或者用户自己报编号。
func (s *Server) currentObject(ctx context.Context, id string) *domain.Object {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	o, err := s.st.GetObject(ctx, id)
	if err != nil {
		s.log.Debug("agent chat: object_id not found, ignoring", "object_id", id)
		return nil
	}
	return o
}

// sessionForChat 取出这次对话的会话：给了 session_id 就用它（顺带按需更新
// workdir / 模型），没给就新建一个。
//
// object 是已经解析过的当前对象，可以为 nil。自动建出来的会话要挂在它上面——
// 不挂的话，用户在 TSK-0015 的助手里聊完第一句，这条会话就落成了全局的，
// 刷新后从抽屉里消失、却出现在底部对话框的列表里。
//
// 已有会话的归属不会被改写：会话属于哪个对象是建的时候定下的，之后用户从
// 别处继续同一个会话（比如底部对话框选中了某个对象）不该把它搬走——
// 那会让它从原来的列表里消失，而用户并没有要求搬家。
func (s *Server) sessionForChat(ctx context.Context, req chatReq, object *domain.Object) (*domain.AgentSession, error) {
	id := strings.TrimSpace(req.SessionID)
	if id == "" {
		var objectID string
		if object != nil {
			objectID = object.ID
		}
		// 标题先用用户的第一句话，省得会话列表里全是「新对话」。
		return s.newSession(ctx, createSessionReq{
			Title:      titleFromMessage(req.Message),
			ObjectID:   objectID,
			ProviderID: req.ProviderID,
			Model:      req.Model,
			Workdir:    req.Workdir,
			AgentID:    req.AgentID,
		})
	}

	sess, err := s.st.GetAgentSession(ctx, id)
	if err != nil {
		return nil, err
	}
	// 请求里带的这几项视为「本次起生效」，写回会话，下一轮不必再传。
	var title, workdir, providerID, model *string
	if v := strings.TrimSpace(req.Workdir); v != "" && v != sess.Workdir {
		workdir = &v
	}
	// 挂了 Agent 的会话，服务商和模型跟 Agent 走，请求里带的不认
	if v := strings.TrimSpace(req.ProviderID); v != "" && v != sess.ProviderID && sess.AgentID == nil {
		providerID = &v
	}
	if v := strings.TrimSpace(req.Model); v != "" && v != sess.Model && sess.AgentID == nil {
		model = &v
	}
	if workdir == nil && providerID == nil && model == nil {
		return sess, nil
	}
	return s.st.UpdateAgentSession(ctx, id, title, workdir, providerID, model)
}

// resolveProvider 按 id 取供应商；id 为空时取默认的；一个都没有时自动建一条
// 指向本机 Ollama 的配置。
//
// 自动创建是有意为之：对话框要开箱即用。它只在「库里一条供应商都没有」时发生，
// 不会覆盖或改动用户已经配好的任何东西。
func (s *Server) resolveProvider(ctx context.Context, id string) (*domain.AgentProvider, error) {
	if id = strings.TrimSpace(id); id != "" {
		return s.st.GetProvider(ctx, id)
	}

	list, err := s.st.ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	// ListProviders 把默认的排在最前。
	for _, p := range list {
		if p.IsDefault {
			return p, nil
		}
	}
	if len(list) > 0 {
		// 有供应商但没有一个被标为默认（比如刚删掉了原来的默认项），用第一条。
		return list[0], nil
	}

	s.log.Info("no agent provider configured, creating local ollama default",
		"base_url", defaultOllamaBaseURL, "model", defaultOllamaModel)
	return s.st.CreateProvider(ctx, &domain.AgentProvider{
		Name:    defaultOllamaName,
		Kind:    domain.ProviderOllama,
		BaseURL: defaultOllamaBaseURL,
		Model:   defaultOllamaModel,
		Enabled: true,
	}, "") // ollama 跑在本机，没有鉴权
}

// --- 辅助 ---

// writeSSE 写一条 SSE 事件。事件类型放在 JSON 的 type 字段里而不是 SSE 的 event: 行，
// 前端只需监听默认的 message 事件，按 type 分发即可（契约见 types.ts 的 AgentStreamEvent）。
func writeSSE(w http.ResponseWriter, ev agent.StreamEvent) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	// SSE 以空行分隔事件，data 里的换行必须逐行拆开，否则会被当成事件边界。
	// JSON 编码后不会有裸换行，这里仍然按规范写全，避免将来改了编码方式踩坑。
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
}

// titleFromMessage 用第一句话当会话标题，截断到一个在侧栏放得下的长度。
func titleFromMessage(msg string) string {
	t := strings.TrimSpace(msg)
	if i := strings.IndexAny(t, "\n\r"); i >= 0 {
		t = t[:i]
	}
	r := []rune(t)
	if len(r) > 24 {
		return string(r[:24]) + "…"
	}
	if len(r) == 0 {
		return "新对话"
	}
	return string(r)
}

// decodeOptionalBody 与 decodeBody 的区别只在于允许空 body。
func decodeOptionalBody(r *http.Request, dst any) error {
	b, err := readBody(r)
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return validationf("malformed JSON body: %v", err)
	}
	return nil
}
