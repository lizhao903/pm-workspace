// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 消息转项目资料（0009）：
//   - 资料由前端调项目插件的 POST /api/projects/{id}/materials 建（消息正文拼成的笔记，或附件），
//     再调 POST /api/im/materials 把「这条资料来自哪些消息」记到本插件；插件之间不互读表，所以资料本身在不在本插件不知道。
//   - 消息读出来带 materials（新的在前），界面显示「已转资料」能跳到资料；项目资料页按 GET /api/im/materials?project_id= 显示出处、点回消息。
//   - 资料在项目里移除时前端调 DELETE /api/im/materials/{material_id} 清掉记录；项目硬删时外键级联，软删的读的时候跳过。

// MaterialKinds 是资料的来源种类：messages 消息正文拼成的笔记，attachment 消息附件。
var MaterialKinds = []string{"messages", "attachment"}

const (
	// materialTitleMax 同项目资料的名称上限
	materialTitleMax = 200
	// materialIDMax 是资料 id 的长度上限（项目插件的 id 是 mt 前缀加一段随机串，远小于它）
	materialIDMax = 64
)

// MaterialSource 是一条资料的出处：登记时的快照，消息以后被清理了也还在。
type MaterialSource struct {
	MaterialID     string   `json:"material_id"`
	ProjectID      string   `json:"project_id"`
	Kind           string   `json:"kind"`
	AttachmentID   string   `json:"attachment_id"`
	Title          string   `json:"title"`
	Channel        string   `json:"channel"`
	ConversationID *string  `json:"conversation_id"`
	Conversation   string   `json:"conversation"`
	Senders        []string `json:"senders"`
	MessageIDs     []string `json:"message_ids"`
	FirstAt        string   `json:"first_at"`
	LastAt         string   `json:"last_at"`
	CreatedAt      string   `json:"created_at"`
}

// MessageMaterial 是消息上的「已转资料」：转成的那条资料、在哪个项目、那条资料一共来自几条消息（判断是不是同一组）。
// 项目删了（含软删）的不列。
type MessageMaterial struct {
	MaterialID   string `json:"material_id"`
	ProjectID    string `json:"project_id"`
	ProjectName  string `json:"project_name"`
	Kind         string `json:"kind"`
	AttachmentID string `json:"attachment_id"`
	Title        string `json:"title"`
	Count        int    `json:"count"`
	At           string `json:"at"`
}

// fillMaterials 补 materials；没有为空数组。
func (in *inbox) fillMaterials(ctx context.Context, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	idx := map[string]int{}
	ph := make([]string, len(ms))
	args := make([]any, len(ms))
	for i := range ms {
		ms[i].Materials = []MessageMaterial{}
		idx[ms[i].ID] = i
		ph[i], args[i] = "?", ms[i].ID
	}
	rows, err := in.c.Store().Query(ctx, `SELECT l.message_id, s.material_id, s.project_id, s.kind, s.attachment_id, s.title, s.created_at,
		(SELECT COUNT(*) FROM im_material_messages c WHERE c.material_id = s.material_id)
		FROM im_material_messages l JOIN im_material_sources s ON s.material_id = l.material_id
		WHERE l.message_id IN (`+strings.Join(ph, ",")+`) ORDER BY s.created_at DESC, s.rowid DESC`, args...)
	if err != nil {
		return err
	}
	type row struct {
		mid string
		mm  MessageMaterial
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.mid, &r.mm.MaterialID, &r.mm.ProjectID, &r.mm.Kind, &r.mm.AttachmentID, &r.mm.Title, &r.mm.At, &r.mm.Count); err != nil {
			_ = rows.Close()
			return err
		}
		got = append(got, r)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	seen := map[string]*plugin.ObjectInfo{}
	for _, r := range got {
		i, ok := idx[r.mid]
		if !ok {
			continue
		}
		o, err := cached(seen, r.mm.ProjectID, func() (plugin.ObjectInfo, error) { return in.c.Objects().Get(ctx, r.mm.ProjectID) })
		if err != nil {
			return err
		}
		if o == nil || o.Deleted {
			continue
		}
		r.mm.ProjectName = o.Title
		ms[i].Materials = append(ms[i].Materials, r.mm)
	}
	return nil
}

// linkMaterial 是 POST /api/im/materials：把一条已建好的项目资料记成来自这组消息。
// body {material_id, project_id, message_ids, title?, kind?, attachment_id?}；回 201 + MaterialSource 和记好后的这组消息。
func (in *inbox) linkMaterial(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		MaterialID   string   `json:"material_id"`
		ProjectID    string   `json:"project_id"`
		MessageIDs   []string `json:"message_ids"`
		Title        string   `json:"title"`
		Kind         string   `json:"kind"`
		AttachmentID string   `json:"attachment_id"`
	}
	if err := decode(r, &body, 64<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	mid := strings.TrimSpace(body.MaterialID)
	if mid == "" {
		fail(w, r, in.c, apiErr(errValidation, "资料 material_id 还没给"))
		return
	}
	if len(mid) > materialIDMax {
		fail(w, r, in.c, apiErr(errValidation, "资料 material_id 太长"))
		return
	}
	kind := strings.TrimSpace(body.Kind)
	if kind == "" {
		kind = "messages"
	}
	if !slices.Contains(MaterialKinds, kind) {
		fail(w, r, in.c, apiErr(errValidation, "kind 只能是 messages 或 attachment"))
		return
	}
	title := strings.TrimSpace(body.Title)
	if utf8.RuneCountInString(title) > materialTitleMax {
		fail(w, r, in.c, apiErr(errValidation, "标题最多 %d 字", materialTitleMax))
		return
	}
	var ids []string
	for _, id := range body.MessageIDs {
		if id = strings.TrimSpace(id); id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		fail(w, r, in.c, apiErr(errValidation, "消息 message_ids 还没给"))
		return
	}
	if len(ids) > sessionLinkMax {
		fail(w, r, in.c, apiErr(errValidation, "一次最多 %d 条消息", sessionLinkMax))
		return
	}
	attID := strings.TrimSpace(body.AttachmentID)
	if kind == "attachment" && (attID == "" || len(ids) != 1) {
		fail(w, r, in.c, apiErr(errValidation, "附件要给 attachment_id，且只对应一条消息"))
		return
	}
	if kind == "messages" && attID != "" {
		fail(w, r, in.c, apiErr(errValidation, "消息正文转的资料不带 attachment_id"))
		return
	}
	pkey := strings.TrimSpace(body.ProjectID)
	if pkey == "" {
		fail(w, r, in.c, apiErr(errValidation, "项目 project_id 还没给"))
		return
	}
	p, err := in.findProject(ctx, pkey)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	ms, err := in.byIDs(ctx, ids)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	for _, id := range ids {
		if !slices.ContainsFunc(ms, func(m Message) bool { return m.ID == id }) {
			fail(w, r, in.c, apiErr(errNotFound, "消息 %s 不存在", id))
			return
		}
	}
	if kind == "attachment" {
		if _, ok := findAttachment(ms[0], attID); !ok {
			fail(w, r, in.c, apiErr(errValidation, "消息里没有附件 %s", attID))
			return
		}
	}

	src := sourceOf(ms)
	src.MaterialID, src.ProjectID, src.Kind, src.AttachmentID, src.Title = mid, p.ID, kind, attID, title
	src.CreatedAt = in.clock().UTC().Format(timeLayout)
	senders, _ := json.Marshal(src.Senders)
	// 插件句柄没有事务：先记出处，再一条语句记全部消息；后者失败时把出处删掉
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_material_sources (material_id, project_id, kind, attachment_id, title, channel,
		conversation_id, conversation, senders, first_at, last_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		src.MaterialID, src.ProjectID, src.Kind, src.AttachmentID, src.Title, src.Channel, src.ConversationID, src.Conversation,
		string(senders), src.FirstAt, src.LastAt, src.CreatedAt); err != nil {
		if isUniqueError(err) {
			fail(w, r, in.c, apiErr(errConflict, "资料 %s 已经记过出处", mid))
			return
		}
		fail(w, r, in.c, err)
		return
	}
	vals := make([]string, len(src.MessageIDs))
	largs := make([]any, 0, 2*len(src.MessageIDs))
	for i, id := range src.MessageIDs {
		vals[i] = "(?, ?)"
		largs = append(largs, src.MaterialID, id)
	}
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_material_messages (material_id, message_id) VALUES `+strings.Join(vals, ", "), largs...); err != nil {
		_, _ = in.c.Store().Exec(ctx, `DELETE FROM im_material_sources WHERE material_id = ?`, src.MaterialID)
		fail(w, r, in.c, err)
		return
	}
	ms, err = in.byIDs(ctx, ids)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"source": src, "messages": ms}})
}

// sourceOf 是一组消息的出处快照：渠道、会话取最新一条的；发信人按时间先后去重；message_ids 按时间正序。
func sourceOf(ms []Message) MaterialSource {
	xs := slices.Clone(ms)
	slices.SortStableFunc(xs, func(a, b Message) int { return strings.Compare(a.At, b.At) })
	last := xs[len(xs)-1]
	s := MaterialSource{Channel: last.Channel, ConversationID: last.ConversationID, Conversation: last.Conversation,
		Senders: []string{}, MessageIDs: []string{}, FirstAt: xs[0].At, LastAt: last.At}
	for _, m := range xs {
		who := m.ContactName
		if who == "" {
			who = m.SenderName
		}
		if who == "" {
			who = m.SenderID
		}
		if who != "" && !slices.Contains(s.Senders, who) {
			s.Senders = append(s.Senders, who)
		}
		s.MessageIDs = append(s.MessageIDs, m.ID)
	}
	return s
}

// listMaterials 是 GET /api/im/materials?project_id=：这个项目里来自消息的资料的出处，新的在前。
// 不带 project_id 400；项目不存在、已删除 400（同归项目的认法）。
func (in *inbox) listMaterials(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if key == "" {
		fail(w, r, in.c, apiErr(errValidation, "要带 project_id"))
		return
	}
	p, err := in.findProject(ctx, key)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	out, err := in.materialSources(ctx, `s.project_id = ?`, p.ID)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{"total": len(out)}})
}

// unlinkMaterial 是 DELETE /api/im/materials/{material_id}：资料移除了，出处一起清掉。没记过 404。
func (in *inbox) unlinkMaterial(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mid := r.PathValue("material_id")
	res, err := in.c.Store().Exec(ctx, `DELETE FROM im_material_sources WHERE material_id = ?`, mid)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, in.c, apiErr(errNotFound, "资料 %s 没有记过出处", mid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

func (in *inbox) materialSources(ctx context.Context, where string, args ...any) ([]MaterialSource, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT s.material_id, s.project_id, s.kind, s.attachment_id, s.title, s.channel, s.conversation_id,
		s.conversation, s.senders, s.first_at, s.last_at, s.created_at FROM im_material_sources s WHERE `+where+`
		ORDER BY s.created_at DESC, s.rowid DESC`, args...)
	if err != nil {
		return nil, err
	}
	out := []MaterialSource{}
	idx := map[string]int{}
	for rows.Next() {
		var s MaterialSource
		var senders string
		if err := rows.Scan(&s.MaterialID, &s.ProjectID, &s.Kind, &s.AttachmentID, &s.Title, &s.Channel, &s.ConversationID,
			&s.Conversation, &senders, &s.FirstAt, &s.LastAt, &s.CreatedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if json.Unmarshal([]byte(senders), &s.Senders) != nil || s.Senders == nil {
			s.Senders = []string{}
		}
		s.MessageIDs = []string{}
		idx[s.MaterialID] = len(out)
		out = append(out, s)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil || len(out) == 0 {
		return out, err
	}
	ph := make([]string, len(out))
	ids := make([]any, len(out))
	for i, s := range out {
		ph[i], ids[i] = "?", s.MaterialID
	}
	// 消息按时间正序；消息已被清理的排在最前（还按 id 记着），最后一条总是还在的最新一条（资料页点出处打开它）
	rows, err = in.c.Store().Query(ctx, `SELECT l.material_id, l.message_id FROM im_material_messages l
		LEFT JOIN im_messages m ON m.id = l.message_id
		WHERE l.material_id IN (`+strings.Join(ph, ",")+`) ORDER BY m.sent_at IS NOT NULL, m.sent_at, l.rowid`, ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var mid, msg string
		if err := rows.Scan(&mid, &msg); err != nil {
			return nil, err
		}
		if i, ok := idx[mid]; ok {
			out[i].MessageIDs = append(out[i].MessageIDs, msg)
		}
	}
	return out, rows.Err()
}

func isUniqueError(err error) bool {
	return err != nil && (strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") || strings.Contains(strings.ToUpper(err.Error()), "PRIMARY KEY"))
}
