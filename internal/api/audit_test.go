package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// newAuditServer 按 cmd/pmw 的接法起服务：真库、真保险箱、审计包装。
func newAuditServer(t *testing.T) (*Server, *sqlite.Store) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	if _, err := st.AttachVault(ctx, v); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	s := New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Vault: v, Audit: al})
	return s, st
}

var agentHeaders = [][2]string{{"X-Actor-Source", "agent"}, {"X-Actor-Name", "claude-code"}, {"X-Actor-Session", "sess-1"}}

func listAudits(t *testing.T, s *Server, query string) []map[string]any {
	t.Helper()
	w := do(s, "GET", "/api/audits?"+query, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/audits?%s = %d %s", query, w.Code, w.Body.String())
	}
	env := decodeEnvelope(t, w)
	out := []map[string]any{}
	for _, it := range env["data"].([]any) {
		out = append(out, it.(map[string]any))
	}
	if total := env["meta"].(map[string]any)["total"].(float64); int(total) != len(out) {
		t.Fatalf("meta.total = %v, 本页 %d 条", total, len(out))
	}
	return out
}

func mustCode(t *testing.T, w interface{ Result() *http.Response }, want int, what string) {
	t.Helper()
	if got := w.Result().StatusCode; got != want {
		t.Fatalf("%s = %d, want %d", what, got, want)
	}
}

func createObjectID(t *testing.T, s *Server, body string, headers ...[2]string) string {
	t.Helper()
	w := do(s, "POST", "/api/objects", body, headers...)
	mustCode(t, w, http.StatusCreated, "create object")
	return decodeEnvelope(t, w)["data"].(map[string]any)["id"].(string)
}

// 验收：删除对象、改字典、MCP 写入各产生一条审计；按对象和时间区间查询正确。
func TestAuditAcceptance(t *testing.T) {
	s, _ := newAuditServer(t)
	start := time.Now().UTC().Add(-time.Second)

	// 界面新建不记，界面删除记一条
	id := createObjectID(t, s, `{"type_id":"task","title":"待删的任务"}`, [2]string{"X-Actor-Source", "ui"})
	if got := listAudits(t, s, ""); len(got) != 0 {
		t.Fatalf("界面新建不该记审计: %v", got)
	}
	mustCode(t, do(s, "DELETE", "/api/objects/"+id, "", [2]string{"X-Actor-Source", "ui"}), http.StatusOK, "delete")
	got := listAudits(t, s, "target_type=object&target_id="+id)
	if len(got) != 1 || got[0]["kind"] != "delete" || got[0]["action"] != "delete" || got[0]["source"] != "ui" {
		t.Fatalf("删除对象的审计: %v", got)
	}
	if !strings.Contains(got[0]["summary"].(string), "待删的任务") {
		t.Errorf("summary = %v", got[0]["summary"])
	}
	// 删不存在的不记
	mustCode(t, do(s, "DELETE", "/api/objects/obj_missing", ""), http.StatusNotFound, "delete missing")

	// 改字典
	mustCode(t, do(s, "PATCH", "/api/dict-items/dit_prio_p0", `{"label":"紧急"}`), http.StatusOK, "patch dict item")
	got = listAudits(t, s, "target_type=dict_item&target_id=dit_prio_p0")
	if len(got) != 1 || got[0]["kind"] != "config" || got[0]["action"] != "update" || got[0]["actor"] != "me" {
		t.Fatalf("改字典的审计: %v", got)
	}
	if f := got[0]["detail"].(map[string]any)["fields"].([]any); len(f) != 1 || f[0] != "label" {
		t.Errorf("fields = %v", f)
	}

	// MCP 写入（pmw-mcp 带 X-Actor-Source: agent）
	mid := time.Now().UTC()
	aid := createObjectID(t, s, `{"type_id":"task","title":"Agent 建的"}`, agentHeaders...)
	got = listAudits(t, s, "target_id="+aid)
	if len(got) != 1 || got[0]["kind"] != "agent" || got[0]["action"] != "create" ||
		got[0]["actor"] != "claude-code#sess-1" || got[0]["source"] != "agent" {
		t.Fatalf("MCP 写入的审计: %v", got)
	}

	// 按操作者
	if got := listAudits(t, s, "actor=claude-code"); len(got) != 1 || got[0]["target_id"] != aid {
		t.Errorf("按操作者: %v", got)
	}
	// 按时间区间：start 起三条；until 在 mid 之前只剩前两条；since 在未来为空
	q := func(k string, v time.Time) string { return k + "=" + url.QueryEscape(v.Format(time.RFC3339)) }
	if got := listAudits(t, s, q("since", start)); len(got) != 3 {
		t.Errorf("since=start: %d 条 %v", len(got), got)
	}
	for _, e := range listAudits(t, s, q("since", start)+"&"+q("until", mid.Add(-time.Second))) {
		if e["target_id"] == aid {
			t.Errorf("until 之前不该有 Agent 那条: %v", e)
		}
	}
	if got := listAudits(t, s, q("since", time.Now().Add(time.Hour))); len(got) != 0 {
		t.Errorf("since 未来: %v", got)
	}
	today := time.Now().Format("2006-01-02")
	if got := listAudits(t, s, "since="+today+"&until="+today+"&target_id="+id); len(got) != 1 {
		t.Errorf("纯日期区间加对象: %v", got)
	}
	// 按对象 + 时间区间组合
	if got := listAudits(t, s, "target_id="+id+"&"+q("since", time.Now().Add(time.Hour))); len(got) != 0 {
		t.Errorf("对象加未来时间: %v", got)
	}
	mustCode(t, do(s, "GET", "/api/audits?since=yesterday", ""), http.StatusBadRequest, "非法 since")
}

// 验收：写保险箱、服务商密钥的审计里只有提示没有明文。
func TestAuditNeverHoldsSecrets(t *testing.T) {
	s, st := newAuditServer(t)
	const (
		plain1 = "sk-proj-AUDITplaintext-0001-xyz9"
		plain2 = "sk-proj-AUDITplaintext-0002-q7w8"
		plain3 = "sk-proj-AUDITproviderkey-0003-k4j5"
		plain4 = "sk-proj-AUDITproviderkey-0004-m1n2"
	)
	w := do(s, "POST", "/api/secrets", `{"name":"OpenAI","value":"`+plain1+`"}`, agentHeaders...)
	mustCode(t, w, http.StatusCreated, "create secret")
	sec := decodeEnvelope(t, w)["data"].(map[string]any)
	sid, hint1 := sec["id"].(string), sec["hint"].(string)
	w = do(s, "POST", "/api/secrets/"+sid+"/rotate", `{"value":"`+plain2+`"}`)
	mustCode(t, w, http.StatusOK, "rotate")
	hint2 := decodeEnvelope(t, w)["data"].(map[string]any)["hint"].(string)

	w = do(s, "POST", "/api/agent-providers", `{"name":"P","kind":"openai","model":"gpt-4o","api_key":"`+plain3+`"}`)
	mustCode(t, w, http.StatusCreated, "create provider")
	pv := decodeEnvelope(t, w)["data"].(map[string]any)
	pid, mask3 := pv["id"].(string), pv["api_key_masked"].(string)
	w = do(s, "PATCH", "/api/agent-providers/"+pid, `{"api_key":"`+plain4+`"}`)
	mustCode(t, w, http.StatusOK, "patch provider")
	mask4 := decodeEnvelope(t, w)["data"].(map[string]any)["api_key_masked"].(string)
	mustCode(t, do(s, "DELETE", "/api/secrets/"+sid, ""), http.StatusOK, "delete secret")

	got := listAudits(t, s, "target_type=secret&target_id="+sid)
	if len(got) != 3 {
		t.Fatalf("保险箱该有 3 条审计（设置、更新、删除）: %v", got)
	}
	want := map[string]string{"create": audit.SecretSet, "rotate": audit.SecretUpdated}
	for _, e := range got {
		if v, ok := want[e["action"].(string)]; ok && e["detail"].(map[string]any)["value"] != v {
			t.Errorf("%s 的提示 = %v, want %s", e["action"], e["detail"], v)
		}
	}
	if got[2]["source"] != "agent" || got[2]["kind"] != "config" {
		t.Errorf("Agent 写保险箱按配置变更记，来源 agent: %v", got[2])
	}
	pa := listAudits(t, s, "target_type=agent_provider&target_id="+pid)
	if len(pa) != 2 || pa[0]["detail"].(map[string]any)["api_key"] != audit.SecretUpdated ||
		pa[1]["detail"].(map[string]any)["api_key"] != audit.SecretSet {
		t.Fatalf("服务商密钥只记提示: %v", pa)
	}

	// 直接扫审计表的每一列：明文、明文片段、脱敏提示（含明文尾号）都不能出现
	rows, err := st.DB().R.Query(`SELECT id, at, kind, action, target_type, target_id, actor, source, summary, detail FROM audits`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	n := 0
	needles := []string{plain1, plain2, plain3, plain4, "AUDITplaintext", "AUDITproviderkey", hint1, hint2, mask3, mask4,
		plain1[len(plain1)-4:], plain2[len(plain2)-4:], plain3[len(plain3)-4:], plain4[len(plain4)-4:]}
	for rows.Next() {
		cols := make([]string, 10)
		ptrs := make([]any, 10)
		for i := range cols {
			ptrs[i] = &cols[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		n++
		for _, c := range cols {
			for _, nd := range needles {
				if nd != "" && strings.Contains(c, nd) {
					t.Errorf("审计字段 %q 里出现了 %q", c, nd)
				}
			}
		}
	}
	if n != 5 {
		t.Fatalf("审计表应有 5 行，got %d", n)
	}
	// 查询接口同样不带
	body := do(s, "GET", "/api/audits", "").Body.String()
	for _, nd := range needles {
		if strings.Contains(body, nd) {
			t.Errorf("GET /api/audits 里出现了 %q", nd)
		}
	}
}

func TestAuditsNotConfigured(t *testing.T) {
	s := newTestServer(newFakeStore())
	assertError(t, do(s, "GET", "/api/audits", ""), http.StatusInternalServerError, "internal")
}
