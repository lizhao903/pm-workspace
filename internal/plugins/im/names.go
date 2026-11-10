// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// 查询回填名字（TSK-0494，插件迁移 0016_name_lookups.sql）：群组管理里只显示渠道编号的行（私聊对方、群成员是 Slack 的 U…，
// 群名为空或就是编号），回渠道查名字补回。
//   - POST /api/im/conversations/{conversation_id}/refill-names 补一个会话，之前查不到的也重查；
//   - POST /api/im/conversations/refill-names 批量，body {conversation_ids?, retry_failed?}，不给 conversation_ids 是全部有缺的会话。
//
// 口径：先在本地找（同一个人别的消息里的名字、IM 身份上的名字、之前查到的），找不到才回渠道查；一次最多回渠道查 refillNamesLimit 个，
// 撞上限流就停，回已补的和还剩几个。只补空的：im_messages 里 sender_name 为空的、conversation_name 为空或就是编号的，
// 联系人、IM 身份、内核会话表都不动（联系人名本来就优先显示）；不新增会话、不改消息状态，也不当新消息通知或触发 SOP。
// 每个编号查的结果记进 im_name_lookups：查不到的记原因，批量时跳过（retry_failed 为真时重查），单个会话的总是重查。

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// NameResolver 能回渠道按编号查人名、会话名。查不到的放进 FailedUsers / FailedConversations（带原因）；
// 撞上限流时 Limited 为真，没来得及查的既不在查到的里也不在失败里。整次调不了（Token 失效等）回 error。
type NameResolver interface {
	Adapter
	ResolveNames(ctx context.Context, connectorID string, q NameQuery) (NameAnswer, error)
}

// NameQuery 是一次要查的编号：Users 是发信人编号，Conversations 是会话编号。
type NameQuery struct {
	Users         []string
	Conversations []string
}

// NameAnswer 是查的结果，键是编号。
type NameAnswer struct {
	Users               map[string]string
	Conversations       map[string]string
	FailedUsers         map[string]NameFailure
	FailedConversations map[string]NameFailure
	Limited             bool
}

// NameFailure 是一个编号查不到的原因；Code 是渠道的错误码或 not_found、empty，Message 是给人看的中文。
type NameFailure struct {
	Code    string
	Message string
}

// refillNamesLimit 是一次最多回渠道查几个编号（Slack users.info 约每分钟 100 次）；没补完再点一次。
const refillNamesLimit = 100

// NameFilled 是补上的一个名字；Kind 为 user（发信人）或 conversation（会话名）；Source 为 local（本地已有）或 channel（回渠道查的）。
type NameFilled struct {
	ConversationID string `json:"conversation_id"`
	Kind           string `json:"kind"`
	ExternalID     string `json:"external_id"`
	Name           string `json:"name"`
	Source         string `json:"source"`
}

// NameFailed 是没补上的一个；Code 见契约，Message 是给人看的中文原因。ExternalID 为空表示整个会话都没查（渠道没连接等）。
type NameFailed struct {
	ConversationID string `json:"conversation_id"`
	Kind           string `json:"kind"`
	ExternalID     string `json:"external_id"`
	Code           string `json:"code"`
	Message        string `json:"message"`
}

// NameRefillResult 是一次查询回填的结果。Checked 是这次看了几个缺名字的编号；Remaining 是限流或到了上限没来得及查的；
// Skipped 是之前查过、查不到，这次没重查的（批量、retry_failed 为假时）。
type NameRefillResult struct {
	Conversations int          `json:"conversations"`
	Checked       int          `json:"checked"`
	Filled        []NameFilled `json:"filled"`
	Failed        []NameFailed `json:"failed"`
	Skipped       int          `json:"skipped"`
	Remaining     int          `json:"remaining"`
}

func (in *inbox) nameResolverFor(channel string) NameResolver {
	for _, a := range in.adapters {
		if f, ok := a.(NameResolver); ok && a.Channel() == channel {
			return f
		}
	}
	return nil
}

// refillNamesOne：单个会话。会话不存在 404；渠道查不了（没有消息所在的连接器、渠道不支持）、连接器暂停或断开 409；渠道整次调不了 502。
func (in *inbox) refillNamesOne(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cv, err := in.conversation(ctx, r.PathValue("conversation_id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	nr := &nameRefill{in: in, retry: true, budget: refillNamesLimit, res: newNameRefillResult()}
	if err := nr.conversation(ctx, cv, true); err != nil {
		fail(w, r, in.c, err)
		return
	}
	nr.audit(ctx)
	writeJSON(w, http.StatusOK, map[string]any{"data": nr.res})
}

// refillNamesBatch：批量。conversation_ids 不给是全部有缺名字的会话（按最近有消息的在前）；最多 maxConvBatch 个。
// 单个会话查不了的（渠道没连接等）记进 failed，不拦别的；渠道整次调不了（Token 失效）回 502。
func (in *inbox) refillNamesBatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		ConversationIDs []string `json:"conversation_ids"`
		RetryFailed     bool     `json:"retry_failed"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &body, 64<<10); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	if len(body.ConversationIDs) > maxConvBatch {
		fail(w, r, in.c, apiErr(errValidation, "at most %d conversations at a time", maxConvBatch))
		return
	}
	ids := body.ConversationIDs
	if len(ids) == 0 {
		var err error
		if ids, err = in.convsMissingNames(ctx); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	nr := &nameRefill{in: in, retry: body.RetryFailed, budget: refillNamesLimit, res: newNameRefillResult()}
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		cv, err := in.c.Conversations().Get(ctx, id)
		if errors.Is(err, plugin.ErrNoRows) {
			nr.res.Failed = append(nr.res.Failed, NameFailed{ConversationID: id, Kind: "conversation", Code: "not_found", Message: "会话不存在"})
			continue
		}
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if err := nr.conversation(ctx, cv, false); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	nr.audit(ctx)
	writeJSON(w, http.StatusOK, map[string]any{"data": nr.res})
}

func newNameRefillResult() NameRefillResult {
	return NameRefillResult{Filled: []NameFilled{}, Failed: []NameFailed{}}
}

// convsMissingNames 是有发信人没名字、或群名为空 / 就是编号的会话，最近有消息的在前。
func (in *inbox) convsMissingNames(ctx context.Context) ([]string, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT conversation_id FROM im_messages
		WHERE conversation_id IS NOT NULL AND (sender_name = '' OR (conversation_kind = 'group' AND (conversation_name = '' OR conversation_name = conversation_external_id)))
		GROUP BY conversation_id ORDER BY max(sent_at) DESC LIMIT ?`, maxConvBatch)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// nameRefill 是一次回填的进度：budget 是还能回渠道查几个，limited 是撞过限流（之后的都不再查，算 remaining）。
type nameRefill struct {
	in      *inbox
	retry   bool
	budget  int
	limited bool
	res     NameRefillResult
}

// lookupRec 是 im_name_lookups 的一行。
type lookupRec struct {
	name, code, message string
}

func (in *inbox) lookupRecs(ctx context.Context, channel, kind string, ids []string) (map[string]lookupRec, error) {
	out := map[string]lookupRec{}
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{channel, kind}
	for _, x := range ids {
		args = append(args, x)
	}
	rows, err := in.c.Store().Query(ctx, `SELECT external_id, name, code, message FROM im_name_lookups
		WHERE channel = ? AND kind = ? AND external_id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id string
		var r lookupRec
		if err := rows.Scan(&id, &r.name, &r.code, &r.message); err != nil {
			return nil, err
		}
		out[id] = r
	}
	return out, rows.Err()
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func (in *inbox) saveLookup(ctx context.Context, channel, kind, ext string, r lookupRec) error {
	_, err := in.c.Store().Exec(ctx, `INSERT INTO im_name_lookups (channel, kind, external_id, name, code, message, checked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (channel, kind, external_id) DO UPDATE SET name = excluded.name, code = excluded.code, message = excluded.message, checked_at = excluded.checked_at`,
		channel, kind, ext, r.name, r.code, r.message, in.clock().UTC().Format(timeLayout))
	return err
}

// missingSenders 是会话里发过言、有消息的渠道名字为空、也没认上有名字的联系人的发信人编号（最近发言的在前）。
func (in *inbox) missingSenders(ctx context.Context, cv plugin.ConversationInfo) ([]string, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT sender_external_id FROM im_messages
		WHERE conversation_id = ? AND sender_external_id <> '' GROUP BY sender_external_id
		HAVING min(sender_name) = '' ORDER BY max(sent_at) DESC`, cv.ID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var x string
		if err := rows.Scan(&x); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, x)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	out := ids[:0]
	for _, x := range ids {
		named, err := in.contactNamed(ctx, cv.Channel, x)
		if err != nil {
			return nil, err
		}
		if !named {
			out = append(out, x)
		}
	}
	return out, nil
}

// contactNamed：这个编号认上了联系人、联系人有名字（列表里显示联系人名，不算缺）。
func (in *inbox) contactNamed(ctx context.Context, channel, ext string) (bool, error) {
	idn, err := in.c.Identities().Find(ctx, channel, ext)
	if errors.Is(err, plugin.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ct, err := in.c.Contacts().Get(ctx, idn.StakeholderID)
	if errors.Is(err, plugin.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(ct.Name) != "", nil
}

// convNameMissing：群名为空或就是编号（登记会话时没有名字用编号代替）。私聊本来没有名字，不算。
func convNameMissing(cv plugin.ConversationInfo) bool {
	return cv.Kind == "group" && (strings.TrimSpace(cv.Name) == "" || cv.Name == cv.ExternalID)
}

// localName 在本地找一个发信人的名字：同渠道别的消息里的、IM 身份上的；都没有为空串。
func (in *inbox) localName(ctx context.Context, channel, ext string) (string, error) {
	var name string
	err := in.c.Store().QueryRow(ctx, `SELECT sender_name FROM im_messages WHERE channel = ? AND sender_external_id = ? AND sender_name <> ''
		ORDER BY sent_at DESC LIMIT 1`, channel, ext).Scan(&name)
	if err != nil && !errors.Is(err, plugin.ErrNoRows) {
		return "", err
	}
	if name != "" {
		return name, nil
	}
	idn, err := in.c.Identities().Find(ctx, channel, ext)
	if errors.Is(err, plugin.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(idn.DisplayName), nil
}

// knownName 是收消息时渠道没给名字的发信人在本地已知的名字：别的消息里的、IM 身份上的、之前查询回填查到的；都没有为空串。
func (in *inbox) knownName(ctx context.Context, channel, ext string) (string, error) {
	if ext == "" {
		return "", nil
	}
	name, err := in.localName(ctx, channel, ext)
	if err != nil || name != "" {
		return name, err
	}
	recs, err := in.lookupRecs(ctx, channel, "user", []string{ext})
	if err != nil {
		return "", err
	}
	return recs[ext].name, nil
}

// fillSender 把一个发信人的名字写进 sender_name 为空的消息（这个渠道里所有会话）。回改了几条。
func (in *inbox) fillSender(ctx context.Context, channel, ext, name string) (int64, error) {
	r, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET sender_name = ? WHERE channel = ? AND sender_external_id = ? AND sender_name = ''`,
		clip(name, maxName), channel, ext)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

// fillConvName 把会话名写进 conversation_name 为空或就是编号的消息。
func (in *inbox) fillConvName(ctx context.Context, cv plugin.ConversationInfo, name string) error {
	_, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET conversation_name = ?
		WHERE conversation_id = ? AND (conversation_name = '' OR conversation_name = conversation_external_id)`, clip(name, maxName), cv.ID)
	return err
}

// conversation 补一个会话。single 为真（单个会话的按钮）时渠道查不了回 409；批量时记进 failed。
func (nr *nameRefill) conversation(ctx context.Context, cv plugin.ConversationInfo, single bool) error {
	in := nr.in
	nr.res.Conversations++
	users, err := in.missingSenders(ctx, cv)
	if err != nil {
		return err
	}
	var convs []string
	if convNameMissing(cv) {
		convs = []string{cv.ExternalID}
	}
	if len(users) == 0 && len(convs) == 0 {
		return nil
	}
	nr.res.Checked += len(users) + len(convs)
	// 先在本地找人名
	var ask []string
	for _, x := range users {
		name, err := in.localName(ctx, cv.Channel, x)
		if err != nil {
			return err
		}
		if name == "" {
			ask = append(ask, x)
			continue
		}
		if err := nr.filledUser(ctx, cv, x, name, "local"); err != nil {
			return err
		}
	}
	// 之前查过的：查到的直接用，查不到的批量时跳过
	recs, err := in.lookupRecs(ctx, cv.Channel, "user", ask)
	if err != nil {
		return err
	}
	askUsers := ask[:0]
	for _, x := range ask {
		rec, ok := recs[x]
		switch {
		case ok && rec.name != "":
			if err := nr.filledUser(ctx, cv, x, rec.name, "local"); err != nil {
				return err
			}
		case ok && rec.code != "" && !nr.retry:
			nr.res.Skipped++
		default:
			askUsers = append(askUsers, x)
		}
	}
	var askConvs []string
	if len(convs) > 0 {
		crecs, err := in.lookupRecs(ctx, cv.Channel, "conversation", convs)
		if err != nil {
			return err
		}
		rec, ok := crecs[cv.ExternalID]
		switch {
		case ok && rec.name != "":
			if err := nr.filledConv(ctx, cv, rec.name, "local"); err != nil {
				return err
			}
		case ok && rec.code != "" && !nr.retry:
			nr.res.Skipped++
		default:
			askConvs = convs
		}
	}
	if len(askUsers) == 0 && len(askConvs) == 0 {
		return nil
	}

	// 回渠道查
	whole := func(code, msg string) error {
		if single {
			return blocked(code, msg)
		}
		nr.res.Failed = append(nr.res.Failed, NameFailed{ConversationID: cv.ID, Kind: "conversation", Code: code, Message: msg})
		return nil
	}
	f := in.nameResolverFor(cv.Channel)
	if f == nil {
		return whole("unsupported", "这个渠道不支持按编号查名字")
	}
	connID, err := in.lastConnector(ctx, cv.ID)
	if err != nil {
		return err
	}
	if connID == "" {
		return whole("no_connector", "这个会话没有记下是哪个连接器收的，查不了")
	}
	cn, err := in.c.Connectors().Get(ctx, connID)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		return whole("no_connector", "收这个会话的连接器已经删了，渠道没连接")
	case err != nil:
		return err
	case cn.Status == "paused":
		return whole("connector_paused", "连接器「"+cn.Name+"」已暂停")
	case cn.Status == "disconnected":
		return whole("connector_disconnected", "连接器「"+cn.Name+"」已断开")
	}
	// 到了上限或撞过限流：剩下的不查
	q := NameQuery{}
	for _, x := range askConvs {
		if nr.limited || nr.budget <= 0 {
			nr.res.Remaining++
			continue
		}
		q.Conversations = append(q.Conversations, x)
		nr.budget--
	}
	for _, x := range askUsers {
		if nr.limited || nr.budget <= 0 {
			nr.res.Remaining++
			continue
		}
		q.Users = append(q.Users, x)
		nr.budget--
	}
	if len(q.Users) == 0 && len(q.Conversations) == 0 {
		return nil
	}
	ans, err := f.ResolveNames(ctx, connID, q)
	if err != nil {
		in.c.Log().Warn("im refill names failed", "connector", connID, "conversation", cv.ID, "err", err)
		if single {
			return &actionError{status: http.StatusBadGateway, code: "refill_failed", msg: "查询失败：" + err.Error()}
		}
		nr.res.Failed = append(nr.res.Failed, NameFailed{ConversationID: cv.ID, Kind: "conversation", Code: "refill_failed", Message: "查询失败：" + err.Error()})
		return nil
	}
	if ans.Limited {
		nr.limited = true
	}
	for _, x := range q.Conversations {
		if err := nr.answer(ctx, cv, "conversation", x, ans.Conversations[x], ans.FailedConversations); err != nil {
			return err
		}
	}
	for _, x := range q.Users {
		if err := nr.answer(ctx, cv, "user", x, ans.Users[x], ans.FailedUsers); err != nil {
			return err
		}
	}
	return nil
}

// answer 记一个编号查的结果：查到写回，查不到记原因，限流没查到的算 remaining、不记。
func (nr *nameRefill) answer(ctx context.Context, cv plugin.ConversationInfo, kind, ext, name string, failed map[string]NameFailure) error {
	in := nr.in
	name = strings.TrimSpace(name)
	if name != "" {
		if err := in.saveLookup(ctx, cv.Channel, kind, ext, lookupRec{name: name}); err != nil {
			return err
		}
		if kind == "conversation" {
			return nr.filledConv(ctx, cv, name, "channel")
		}
		return nr.filledUser(ctx, cv, ext, name, "channel")
	}
	fl, ok := failed[ext]
	if !ok {
		nr.res.Remaining++
		return nil
	}
	if err := in.saveLookup(ctx, cv.Channel, kind, ext, lookupRec{code: fl.Code, message: fl.Message}); err != nil {
		return err
	}
	nr.res.Failed = append(nr.res.Failed, NameFailed{ConversationID: cv.ID, Kind: kind, ExternalID: ext, Code: fl.Code, Message: fl.Message})
	return nil
}

func (nr *nameRefill) filledUser(ctx context.Context, cv plugin.ConversationInfo, ext, name, source string) error {
	if _, err := nr.in.fillSender(ctx, cv.Channel, ext, name); err != nil {
		return err
	}
	nr.res.Filled = append(nr.res.Filled, NameFilled{ConversationID: cv.ID, Kind: "user", ExternalID: ext, Name: name, Source: source})
	return nil
}

func (nr *nameRefill) filledConv(ctx context.Context, cv plugin.ConversationInfo, name, source string) error {
	if err := nr.in.fillConvName(ctx, cv, name); err != nil {
		return err
	}
	nr.res.Filled = append(nr.res.Filled, NameFilled{ConversationID: cv.ID, Kind: "conversation", ExternalID: cv.ExternalID, Name: name, Source: source})
	return nil
}

// audit 补上了名字时记一条审计（操作者记为插件）。
func (nr *nameRefill) audit(ctx context.Context) {
	if len(nr.res.Filled) == 0 {
		return
	}
	names := make([]string, 0, 3)
	for _, f := range nr.res.Filled {
		if len(names) == 3 {
			break
		}
		if !slices.Contains(names, f.Name) {
			names = append(names, f.Name)
		}
	}
	summary := "查询回填 IM 名字 " + strconv.Itoa(len(nr.res.Filled)) + " 个：" + strings.Join(names, "、")
	if len(nr.res.Filled) > len(names) {
		summary += " 等"
	}
	nr.in.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "conversation", TargetID: nr.res.Filled[0].ConversationID,
		Summary: summary, Detail: map[string]any{"field": "names", "filled": len(nr.res.Filled), "failed": len(nr.res.Failed)}}, plugin.WriteMeta{})
}

// lastConnector 是会话里最近一条消息所在的连接器，没有为空串。
func (in *inbox) lastConnector(ctx context.Context, convID string) (string, error) {
	var id string
	err := in.c.Store().QueryRow(ctx, `SELECT connector_id FROM im_messages WHERE conversation_id = ? AND connector_id <> ''
		ORDER BY sent_at DESC LIMIT 1`, convID).Scan(&id)
	if errors.Is(err, plugin.ErrNoRows) {
		return "", nil
	}
	return id, err
}
