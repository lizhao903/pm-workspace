// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func newIdentityServer(t *testing.T) (*Server, *audit.Log) {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	return New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Audit: al, Identities: imident.New(st.DB())}), al
}

func mkStakeholder(t *testing.T, s *Server, name string) string {
	t.Helper()
	w := do(s, "POST", "/api/stakeholders", `{"name":"`+name+`"}`)
	mustCode(t, w, http.StatusCreated, "create stakeholder "+name)
	var env struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &env)
	return env.Data.ID
}

func decodeIdentity(t *testing.T, body []byte) imident.Identity {
	t.Helper()
	var env struct {
		Data imident.Identity `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func TestIdentityOneOwnerPerChannelID(t *testing.T) {
	s, _ := newIdentityServer(t)
	lin := mkStakeholder(t, s, "林予安")
	zhou := mkStakeholder(t, s, "周屿")

	w := do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+lin+`","channel":"wechat","external_id":" linyuan_fe ","display_name":"予安"}`)
	mustCode(t, w, http.StatusCreated, "create")
	it := decodeIdentity(t, w.Body.Bytes())
	if !strings.HasPrefix(it.ID, "idn_") || it.ExternalID != "linyuan_fe" || it.DisplayName != "予安" {
		t.Fatalf("created = %+v", it)
	}
	// 同一联系人多个渠道
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+lin+`","channel":"slack","external_id":"U04LINYUAN"}`), http.StatusCreated, "second channel")

	// 挂到另一个联系人：409，message 写明在谁身上
	w = do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+zhou+`","channel":"WeChat","external_id":"linyuan_fe"}`)
	mustCode(t, w, http.StatusConflict, "same identity on another contact")
	// message 原样进界面（SPEC-messages-2.29）：中文、不带 "conflict:" 前缀
	if !strings.Contains(w.Body.String(), `"message":"wechat 编号 linyuan_fe 已经挂在 林予安 身上，一个编号只能属于一个联系人"`) {
		t.Errorf("409 message 应是中文并写明身份在谁身上: %s", w.Body.String())
	}
	// 同一人再挂一次也是 409
	w = do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+lin+`","channel":"wechat","external_id":"linyuan_fe"}`)
	mustCode(t, w, http.StatusConflict, "duplicate on same contact")
	if !strings.Contains(w.Body.String(), `"message":"林予安 已经有 wechat 编号 linyuan_fe 了"`) {
		t.Errorf("同一人重复挂的 409 message: %s", w.Body.String())
	}
	// 同一编号在别的渠道不算撞
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+zhou+`","channel":"qq","external_id":"linyuan_fe"}`), http.StatusCreated, "same id other channel")

	// 改挂到别人：给了一个已存在的身份也 409
	zw := do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+zhou+`","channel":"wechat","external_id":"zhouyu1990"}`)
	mustCode(t, zw, http.StatusCreated, "zhou wechat")
	zid := decodeIdentity(t, zw.Body.Bytes()).ID
	mustCode(t, do(s, "PATCH", "/api/im-identities/"+zid, `{"external_id":"linyuan_fe"}`), http.StatusConflict, "patch onto taken identity")
	// 改挂联系人本身可以
	w = do(s, "PATCH", "/api/im-identities/"+zid, `{"stakeholder_id":"`+lin+`"}`)
	mustCode(t, w, http.StatusOK, "move to another contact")
	if got := decodeIdentity(t, w.Body.Bytes()); got.StakeholderID != lin || got.ExternalID != "zhouyu1990" {
		t.Errorf("moved = %+v", got)
	}

	// 校验
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"stk_nope","channel":"wechat","external_id":"x"}`), http.StatusBadRequest, "unknown stakeholder")
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+lin+`","channel":"微信","external_id":"x"}`), http.StatusBadRequest, "bad channel")
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+lin+`","channel":"telegram","external_id":" @ "}`), http.StatusBadRequest, "empty external id")
}

func TestIdentityResolve(t *testing.T) {
	s, _ := newIdentityServer(t)
	xu := mkStakeholder(t, s, "许知行")
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+xu+`","channel":"telegram","external_id":"@xuzx"}`), http.StatusCreated, "create")
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+xu+`","channel":"lark","external_id":"ou_7f3a9c21"}`), http.StatusCreated, "create lark")

	// 带不带 @ 都认到同一个人
	for _, q := range []string{"channel=telegram&external_id=xuzx", "channel=telegram&external_id=%40xuzx", "channel=lark&external_id=ou_7f3a9c21"} {
		w := do(s, "GET", "/api/im-identities/resolve?"+q, "")
		mustCode(t, w, http.StatusOK, "resolve "+q)
		var env struct {
			Data struct {
				Identity    imident.Identity `json:"identity"`
				Stakeholder struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"stakeholder"`
			} `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		if env.Data.Stakeholder.ID != xu || env.Data.Stakeholder.Name != "许知行" {
			t.Errorf("resolve %s = %s", q, w.Body.String())
		}
	}
	mustCode(t, do(s, "GET", "/api/im-identities/resolve?channel=lark&external_id=OU_7F3A9C21", ""), http.StatusNotFound, "case kept for lark")
	mustCode(t, do(s, "GET", "/api/im-identities/resolve?channel=wechat&external_id=nobody", ""), http.StatusNotFound, "unknown")
	mustCode(t, do(s, "GET", "/api/im-identities/resolve?channel=wechat", ""), http.StatusBadRequest, "missing external_id")

	// 列表筛选
	w := do(s, "GET", "/api/im-identities?stakeholder_id="+xu+"&channel=lark", "")
	mustCode(t, w, http.StatusOK, "list")
	if !strings.Contains(w.Body.String(), `"total":1`) {
		t.Errorf("list filtered = %s", w.Body.String())
	}
}

func TestIdentityCascadeAndAudit(t *testing.T) {
	s, al := newIdentityServer(t)
	he := mkStakeholder(t, s, "何牧")
	w := do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+he+`","channel":"lark","external_id":"he.mu@example.com"}`, agentHeaders...)
	mustCode(t, w, http.StatusCreated, "agent create")
	id := decodeIdentity(t, w.Body.Bytes()).ID
	mustCode(t, do(s, "PATCH", "/api/im-identities/"+id, `{"display_name":"何牧"}`), http.StatusOK, "human update")
	mustCode(t, do(s, "DELETE", "/api/im-identities/"+id, ""), http.StatusOK, "delete")
	mustCode(t, do(s, "DELETE", "/api/im-identities/"+id, ""), http.StatusNotFound, "delete again")

	items, _, err := al.List(context.Background(), audit.Filter{TargetType: "im_identity", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, e := range items {
		kinds = append(kinds, e.Kind+"/"+e.Action)
	}
	// 人改的不记，Agent 建的记，删除一律记；最近的在前
	if strings.Join(kinds, ",") != "delete/delete,agent/create" {
		t.Errorf("audits = %v", kinds)
	}

	// 删联系人时身份跟着删，同一身份可以再挂到别人身上
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+he+`","channel":"qq","external_id":"10001"}`), http.StatusCreated, "create")
	mustCode(t, do(s, "DELETE", "/api/stakeholders/"+he, ""), http.StatusOK, "delete stakeholder")
	mustCode(t, do(s, "GET", "/api/im-identities/resolve?channel=qq&external_id=10001", ""), http.StatusNotFound, "cascaded")
	other := mkStakeholder(t, s, "梁晚晴")
	mustCode(t, do(s, "POST", "/api/im-identities", `{"stakeholder_id":"`+other+`","channel":"qq","external_id":"10001"}`), http.StatusCreated, "reuse after cascade")
}

func TestIdentitiesNotConfigured(t *testing.T) {
	s := New(newFakeStore(), Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	mustCode(t, do(s, "GET", "/api/im-identities", ""), http.StatusInternalServerError, "unconfigured")
}
