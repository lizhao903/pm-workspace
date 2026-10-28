package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/conversation"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func newConversationServer(t *testing.T) (*Server, *audit.Log, *sqlite.Store) {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	return New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Audit: al,
		Identities: imident.New(st.DB()), Conversations: conversation.New(st.DB())}), al, st
}

func decodeConversation(t *testing.T, body []byte) conversation.Conversation {
	t.Helper()
	var env struct {
		Data conversation.Conversation `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func mkIdentity(t *testing.T, s *Server, stakeholder, channel, ext string) string {
	t.Helper()
	w := do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+stakeholder+`","channel":"`+channel+`","external_id":"`+ext+`"}`)
	mustCode(t, w, http.StatusCreated, "create identity "+ext)
	return decodeIdentity(t, w.Body.Bytes()).ID
}

// 改名只改 name：id、渠道编号、成员不变，引用它的数据照样连得上
func TestConversationRenameKeepsID(t *testing.T) {
	s, _, st := newConversationServer(t)
	lin := mkStakeholder(t, s, "林予安")
	lid := mkIdentity(t, s, lin, "slack", "U04LINYUAN")

	w := do(s, "POST", "/api/conversations", `{"channel":"slack","external_id":" C0PRODUCT ","kind":"group","name":"#product","members":["`+lid+`"]}`)
	mustCode(t, w, http.StatusCreated, "create")
	c := decodeConversation(t, w.Body.Bytes())
	if !strings.HasPrefix(c.ID, "cv_") || c.ExternalID != "C0PRODUCT" || c.Kind != "group" || !slices.Equal(c.Members, []string{lid}) {
		t.Fatalf("created = %+v", c)
	}

	// 模拟以后的项目绑定（PJ-02）：一张按 id 引用会话的表
	ctx := context.Background()
	if _, err := st.DB().W.ExecContext(ctx, `CREATE TABLE test_bindings (
		project_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id))`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().W.ExecContext(ctx, `INSERT INTO test_bindings VALUES ('obj_p1', ?)`, c.ID); err != nil {
		t.Fatal(err)
	}

	w = do(s, "PATCH", "/api/conversations/"+c.ID, `{"name":"#product-v2"}`)
	mustCode(t, w, http.StatusOK, "rename")
	got := decodeConversation(t, w.Body.Bytes())
	if got.ID != c.ID || got.Name != "#product-v2" || got.ExternalID != "C0PRODUCT" || !slices.Equal(got.Members, []string{lid}) {
		t.Fatalf("renamed = %+v", got)
	}

	var name string
	if err := st.DB().R.QueryRowContext(ctx, `SELECT c.name FROM test_bindings b JOIN conversations c ON c.id = b.conversation_id
		WHERE b.project_id = 'obj_p1'`).Scan(&name); err != nil || name != "#product-v2" {
		t.Errorf("binding after rename: name=%q err=%v", name, err)
	}
	// 按 id、按渠道加编号都还查得到同一个
	mustCode(t, do(s, "GET", "/api/conversations/"+c.ID, ""), http.StatusOK, "get by id")
	w = do(s, "GET", "/api/conversations/resolve?channel=slack&external_id=C0PRODUCT", "")
	mustCode(t, w, http.StatusOK, "resolve")
	if r := decodeConversation(t, w.Body.Bytes()); r.ID != c.ID || r.Name != "#product-v2" {
		t.Errorf("resolve after rename = %+v", r)
	}
	// 按身份、按联系人反查
	for _, q := range []string{"identity_id=" + lid, "stakeholder_id=" + lin, "channel=slack&kind=group"} {
		w = do(s, "GET", "/api/conversations?"+q, "")
		mustCode(t, w, http.StatusOK, "list "+q)
		if !strings.Contains(w.Body.String(), c.ID) || !strings.Contains(w.Body.String(), `"total":1`) {
			t.Errorf("list %s = %s", q, w.Body.String())
		}
	}

	// 改编号（Telegram 群升级换 chat id 这类）：id 照样不变，旧编号查不到
	w = do(s, "PATCH", "/api/conversations/"+c.ID, `{"external_id":"C1PRODUCT"}`)
	mustCode(t, w, http.StatusOK, "change external id")
	if decodeConversation(t, w.Body.Bytes()).ID != c.ID {
		t.Error("id changed with external id")
	}
	mustCode(t, do(s, "GET", "/api/conversations/resolve?channel=slack&external_id=C0PRODUCT", ""), http.StatusNotFound, "old external id")
	// 渠道和类型不能改
	mustCode(t, do(s, "PATCH", "/api/conversations/"+c.ID, `{"channel":"lark"}`), http.StatusBadRequest, "channel immutable")
	mustCode(t, do(s, "PATCH", "/api/conversations/"+c.ID, `{"kind":"direct"}`), http.StatusBadRequest, "kind immutable")
	mustCode(t, do(s, "PATCH", "/api/conversations/"+c.ID, `{"name":"  "}`), http.StatusBadRequest, "group needs a name")
}

func TestConversationUniqueAndValidation(t *testing.T) {
	s, _, _ := newConversationServer(t)
	xu := mkStakeholder(t, s, "许知行")
	lark := mkIdentity(t, s, xu, "lark", "ou_7f3a9c21")
	tg := mkIdentity(t, s, xu, "telegram", "xuzx")

	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_yc01","kind":"group","name":"远川试点项目群"}`), http.StatusCreated, "create")
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"Lark","external_id":"oc_yc01","kind":"group","name":"同一个群"}`), http.StatusConflict, "same channel+external id")
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"slack","external_id":"oc_yc01","kind":"group","name":"别的渠道"}`), http.StatusCreated, "same id other channel")
	// 同名不同编号是两个群
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_yc02","kind":"group","name":"远川试点项目群"}`), http.StatusCreated, "same name")

	// 私聊可以没名字；telegram 去 @
	w := do(s, "POST", "/api/conversations", `{"channel":"telegram","external_id":"@xuzx","kind":"direct","members":["`+tg+`"]}`)
	mustCode(t, w, http.StatusCreated, "direct")
	dm := decodeConversation(t, w.Body.Bytes())
	if dm.ExternalID != "xuzx" || dm.Name != "" {
		t.Errorf("direct = %+v", dm)
	}
	mustCode(t, do(s, "GET", "/api/conversations/resolve?channel=telegram&external_id=%40xuzx", ""), http.StatusOK, "resolve with @")

	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_x","kind":"group"}`), http.StatusBadRequest, "group without name")
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_x","kind":"channel","name":"x"}`), http.StatusBadRequest, "bad kind")
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_x","kind":"group","name":"x","members":["idn_nope"]}`), http.StatusBadRequest, "unknown member")
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_x","kind":"group","name":"x","members":["`+tg+`"]}`), http.StatusBadRequest, "member on another channel")
	mustCode(t, do(s, "POST", "/api/conversations", `{"channel":"telegram","external_id":"x2","kind":"direct","members":["`+tg+`","`+tg+`"]}`), http.StatusCreated, "dup members collapse")

	// 改编号撞上已有会话
	w = do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_yc03","kind":"group","name":"第三个","members":["`+lark+`"]}`)
	mustCode(t, w, http.StatusCreated, "third")
	third := decodeConversation(t, w.Body.Bytes())
	mustCode(t, do(s, "PATCH", "/api/conversations/"+third.ID, `{"external_id":"oc_yc01"}`), http.StatusConflict, "patch onto taken external id")
	mustCode(t, do(s, "GET", "/api/conversations/resolve?channel=lark&external_id=nobody", ""), http.StatusNotFound, "unknown")
	mustCode(t, do(s, "GET", "/api/conversations/resolve?channel=lark", ""), http.StatusBadRequest, "missing external_id")
}

func TestConversationMembersAndCascade(t *testing.T) {
	s, al, _ := newConversationServer(t)
	he := mkStakeholder(t, s, "何牧")
	liang := mkStakeholder(t, s, "梁晚晴")
	a := mkIdentity(t, s, he, "lark", "ou_hemu")
	b := mkIdentity(t, s, liang, "lark", "ou_liangwq")

	w := do(s, "POST", "/api/conversations", `{"channel":"lark","external_id":"oc_g1","kind":"group","name":"群一"}`, agentHeaders...)
	mustCode(t, w, http.StatusCreated, "agent create")
	c := decodeConversation(t, w.Body.Bytes())

	// 逐个加，重复加不报错
	for _, id := range []string{a, b, a} {
		mustCode(t, do(s, "POST", "/api/conversations/"+c.ID+"/members", `{"identity_id":"`+id+`"}`), http.StatusOK, "add "+id)
	}
	w = do(s, "GET", "/api/conversations/"+c.ID, "")
	if got := decodeConversation(t, w.Body.Bytes()); !slices.Equal(got.Members, []string{a, b}) {
		t.Fatalf("members = %v", got.Members)
	}
	// 整体替换：留下的保留加入顺序
	w = do(s, "PATCH", "/api/conversations/"+c.ID, `{"members":["`+b+`"]}`)
	mustCode(t, w, http.StatusOK, "replace members")
	if got := decodeConversation(t, w.Body.Bytes()); !slices.Equal(got.Members, []string{b}) {
		t.Errorf("replaced = %v", got.Members)
	}
	mustCode(t, do(s, "DELETE", "/api/conversations/"+c.ID+"/members/"+a, ""), http.StatusNotFound, "remove non-member")
	mustCode(t, do(s, "POST", "/api/conversations/"+c.ID+"/members", `{"identity_id":"`+a+`"}`), http.StatusOK, "re-add")

	// 删身份（联系人删除时也一样）：成员关系跟着删，会话还在
	mustCode(t, do(s, "DELETE", "/api/im-identities/"+a, ""), http.StatusOK, "delete identity")
	w = do(s, "GET", "/api/conversations/"+c.ID, "")
	if got := decodeConversation(t, w.Body.Bytes()); !slices.Equal(got.Members, []string{b}) {
		t.Errorf("after identity delete = %v", got.Members)
	}
	mustCode(t, do(s, "DELETE", "/api/conversations/"+c.ID+"/members/"+b, ""), http.StatusOK, "remove member")

	// 删会话：身份不动
	mustCode(t, do(s, "DELETE", "/api/conversations/"+c.ID, ""), http.StatusOK, "delete")
	mustCode(t, do(s, "DELETE", "/api/conversations/"+c.ID, ""), http.StatusNotFound, "delete again")
	mustCode(t, do(s, "GET", "/api/im-identities/"+b, ""), http.StatusOK, "identity kept")

	items, _, err := al.List(context.Background(), audit.Filter{TargetType: "conversation", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, e := range items {
		kinds = append(kinds, e.Kind+"/"+e.Action)
	}
	// 人做的增删成员不记，Agent 建的记，删除一律记；最近的在前
	if strings.Join(kinds, ",") != "delete/delete,agent/create" {
		t.Errorf("audits = %v", kinds)
	}
}

func TestConversationsNotConfigured(t *testing.T) {
	s := New(newFakeStore(), Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	mustCode(t, do(s, "GET", "/api/conversations", ""), http.StatusInternalServerError, "unconfigured")
}
