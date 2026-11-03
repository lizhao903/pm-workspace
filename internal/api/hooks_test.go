package api

import (
	"context"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/webhook"
)

func hookSig(secret, body string) [2]string {
	return [2]string{webhook.SignatureHeader, hex.EncodeToString(webhook.Sign(secret, []byte(body)))}
}

// 收件端点走完整链路：签名、建任务、重放、删任务后再重放、投递记录接口
func TestReceiveHookEndpoint(t *testing.T) {
	s, _ := newWebhookServer(t)
	h, _ := createHook(t, s, hookBody)
	id, secret, token := h["id"].(string), h["secret"].(string), h["token"].(string)
	url := "/api/hooks/" + token
	body := `{"action":"created","event":{"id":"e1","title":"线上 500","culprit":"api/orders","level":"fatal"}}`

	w := do(s, "POST", url, body, hookSig(secret, body))
	mustCode(t, w, http.StatusCreated, "first delivery")
	d := decodeEnvelope(t, w)["data"].(map[string]any)
	taskID, _ := d["task_id"].(string)
	if d["result"] != "created" || !strings.HasPrefix(d["id"].(string), "dl_") || taskID == "" {
		t.Fatalf("delivery = %v", d)
	}
	// 操作者记 webhook#<id>
	o := decodeEnvelope(t, do(s, "GET", "/api/objects/"+taskID, ""))["data"].(map[string]any)
	if o["source"] != "webhook" || o["title"] != "线上 500" {
		t.Fatalf("task = %v", o)
	}
	revs, err := s.st.ListRevisions(context.Background(), taskID, 10)
	if err != nil || len(revs) == 0 || revs[0].Actor != "webhook#"+id {
		t.Errorf("revisions = %v %v", revs, err)
	}

	w = do(s, "POST", url, body, hookSig(secret, body))
	mustCode(t, w, http.StatusOK, "replay")
	if d := decodeEnvelope(t, w)["data"].(map[string]any); d["result"] != "skipped" || d["task_id"] != taskID {
		t.Fatalf("replay = %v", d)
	}

	mustCode(t, do(s, "DELETE", "/api/objects/"+taskID, ""), http.StatusOK, "delete task")
	w = do(s, "POST", url, body, hookSig(secret, body))
	mustCode(t, w, http.StatusCreated, "replay after delete")

	// 拒收：签名不对 401、token 不对 404、超限 413，都不留记录
	assertError(t, do(s, "POST", url, body), http.StatusUnauthorized, "unauthorized")
	assertError(t, do(s, "POST", url, body, hookSig("x", body)), http.StatusUnauthorized, "unauthorized")
	assertError(t, do(s, "POST", "/api/hooks/nope", body, hookSig(secret, body)), http.StatusNotFound, "not_found")
	big := `{"x":"` + strings.Repeat("a", webhook.MaxPayload) + `"}`
	assertError(t, do(s, "POST", url, big, hookSig(secret, big)), http.StatusRequestEntityTooLarge, "payload_too_large")

	// 过滤不通过：200，有原因
	resolved := `{"action":"resolved","event":{"id":"e2","title":"x"}}`
	w = do(s, "POST", url, resolved, hookSig(secret, resolved))
	mustCode(t, w, http.StatusOK, "filtered")
	if d := decodeEnvelope(t, w)["data"].(map[string]any); d["reason"] != "不满足过滤条件 action == created（实际是「resolved」）" {
		t.Fatalf("filtered = %v", d)
	}

	w = do(s, "GET", "/api/webhooks/"+id+"/deliveries?limit=2", "")
	mustCode(t, w, http.StatusOK, "list deliveries")
	env := decodeEnvelope(t, w)
	items := env["data"].([]any)
	if meta := env["meta"].(map[string]any); meta["total"] != float64(4) || len(items) != 2 {
		t.Fatalf("list = %v", env)
	}
	if first := items[0].(map[string]any); first["result"] != "skipped" || first["payload"].(map[string]any)["action"] != "resolved" {
		t.Errorf("newest = %v", first)
	}
	w = do(s, "GET", "/api/webhooks/"+id+"/deliveries?result=created", "")
	created := decodeEnvelope(t, w)["data"].([]any)
	if len(created) != 2 || created[1].(map[string]any)["task_deleted"] != true || created[0].(map[string]any)["task_deleted"] != false {
		t.Errorf("created = %v", created)
	}
	assertError(t, do(s, "GET", "/api/webhooks/"+id+"/deliveries?result=x", ""), http.StatusBadRequest, "validation")
	assertError(t, do(s, "GET", "/api/webhooks/wh_nope/deliveries", ""), http.StatusNotFound, "not_found")

	// usage 按 hook_id 统计：删掉的不算
	if u := decodeEnvelope(t, do(s, "GET", "/api/webhooks/"+id+"/usage", ""))["data"].(map[string]any); u["tasks"] != float64(1) {
		t.Errorf("usage = %v", u)
	}
}
