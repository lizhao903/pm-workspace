// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package webhook

import (
	"context"
	"encoding/hex"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

type hookEnv struct {
	t  *testing.T
	st *sqlite.Store
	ws *Store
}

func newHookEnv(t *testing.T) *hookEnv {
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
	return &hookEnv{t: t, st: st, ws: New(st.DB(), v)}
}

// create 按种子建一个 Webhook，回 token 和密钥明文
func (e *hookEnv) create(seed Webhook) (*Webhook, string) {
	e.t.Helper()
	m := seed.Mapping
	wh, plain, err := e.ws.Create(context.Background(), Input{Name: seed.Name, Mapping: m, Filter: seed.Filter,
		Dedupe: seed.Dedupe, Defaults: &seed.Defaults})
	if err != nil {
		e.t.Fatal(err)
	}
	return wh, plain
}

func sig(secret, body string) string { return hex.EncodeToString(Sign(secret, []byte(body))) }

func (e *hookEnv) post(wh *Webhook, secret, body, deliveryID string) *Delivery {
	e.t.Helper()
	d, err := e.ws.Receive(context.Background(), wh.Token, []byte(body), sig(secret, body), deliveryID, e.st)
	if err != nil {
		e.t.Fatalf("receive: %v", err)
	}
	return d
}

func (e *hookEnv) mustResult(d *Delivery, result, reason string) {
	e.t.Helper()
	if d.Result != result || d.Reason != reason {
		e.t.Fatalf("delivery = %s %q, want %s %q", d.Result, d.Reason, result, reason)
	}
}

// 原型 seedDeliveries 五条按顺序投一遍：建、重复、过滤、建、标题取不到
func TestReceiveSeedDeliveries(t *testing.T) {
	e := newHookEnv(t)
	ctx := context.Background()
	zhou, err := e.st.CreateStakeholder(ctx, &domain.Stakeholder{Name: "周屿"})
	if err != nil {
		t.Fatal(err)
	}
	sentry, sentrySecret := e.create(seedSentry)
	form, formSecret := e.create(seedForm)
	s1 := sentryPayload("b902ee", "Export job timeout after 300s", "fatal", "created")

	d1 := e.post(sentry, sentrySecret, s1, "")
	e.mustResult(d1, ResultCreated, "")
	task, err := e.st.GetObject(ctx, *d1.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Title != "Export job timeout after 300s" || task.Body != "src/pages/Export.tsx in runExport" ||
		task.Priority != "P0" || task.Source != domain.TaskSourceWebhook || task.TypeID != "task" {
		t.Fatalf("task = %+v", task)
	}
	if task.OwnerID == nil || *task.OwnerID != zhou.ID {
		t.Errorf("默认负责人 周屿 应对上干系人，owner_id = %v", task.OwnerID)
	}
	ref, _ := task.Props[domain.PropSourceRef].(map[string]any)
	if ref["hook_id"] != sentry.ID || ref["delivery_id"] != d1.ID {
		t.Errorf("source_ref = %v", task.Props)
	}
	if d1.DedupeKey != "p:event.id=b902ee" || d1.TaskRef != task.Ref {
		t.Errorf("delivery = %+v", d1)
	}

	d2 := e.post(sentry, sentrySecret, s1, "")
	e.mustResult(d2, ResultSkipped, "event.id = b902ee 已经建过任务，按重复推送忽略")
	if d2.TaskID == nil || *d2.TaskID != task.ID || d2.TaskRef != task.Ref {
		t.Errorf("重复推送应指向之前的任务，task_id = %v", d2.TaskID)
	}

	d3 := e.post(sentry, sentrySecret, sentryPayload("c11d04", "Slow query on /api/audit", "warning", "resolved"), "")
	e.mustResult(d3, ResultSkipped, "不满足过滤条件 action == created（实际是「resolved」）")
	if d3.TaskID != nil || d3.Mapped.Title != "Slow query on /api/audit" {
		t.Errorf("过滤不通过 = %+v", d3)
	}

	d4 := e.post(form, formSecret, seedFormSample, "")
	e.mustResult(d4, ResultCreated, "负责人「林予安」不在干系人名册里，没设负责人")
	ft, _ := e.st.GetObject(ctx, *d4.TaskID)
	if ft.Priority != "P1" || ft.DueAt == nil || ft.DueAt.In(time.Local).Format("2006-01-02") != "2026-11-19" || ft.OwnerID != nil {
		t.Errorf("form task = %+v", ft)
	}

	d5 := e.post(form, formSecret, seedFormNoNeed, "")
	e.mustResult(d5, ResultFailed, "标题路径 answers.need 取不到值")
	if d5.Mapped.Desc != "希望审批能接企业微信" || d5.Mapped.Priority != "中" {
		t.Errorf("失败时映射结果也要留着：%+v", d5.Mapped)
	}

	// 记录查得到，新的在前；usage 按 hook_id 统计
	list, total, err := e.ws.ListDeliveries(ctx, sentry.ID, "", 50, 0)
	if err != nil || total != 3 || len(list) != 3 || list[0].ID != d3.ID || list[2].ID != d1.ID {
		t.Fatalf("list = %d %v %v", total, list, err)
	}
	if string(list[2].Payload) != s1 {
		t.Errorf("payload = %s", list[2].Payload)
	}
	if _, total, _ := e.ws.ListDeliveries(ctx, sentry.ID, ResultSkipped, 50, 0); total != 2 {
		t.Errorf("skipped = %d", total)
	}
	if _, _, err := e.ws.ListDeliveries(ctx, sentry.ID, "bogus", 50, 0); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("bad result filter = %v", err)
	}
	if u, _ := e.ws.Usage(ctx, sentry.ID); u.Tasks != 1 {
		t.Errorf("usage = %+v", u)
	}
}

// 删掉任务（软删、硬删）后同一投递重放会重新建；没删时重放只建一条
func TestReceiveReplayAfterDelete(t *testing.T) {
	e := newHookEnv(t)
	ctx := context.Background()
	form, secret := e.create(seedForm) // 没配 dedupe 路径：按请求体哈希
	first := e.post(form, secret, seedFormSample, "")
	e.mustResult(first, ResultCreated, "负责人「林予安」不在干系人名册里，没设负责人")
	again := e.post(form, secret, seedFormSample, "")
	e.mustResult(again, ResultSkipped, "同样的推送内容已经建过任务，按重复推送忽略")

	if err := e.st.DeleteObject(ctx, *first.TaskID, false, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	second := e.post(form, secret, seedFormSample, "")
	if second.Result != ResultCreated || *second.TaskID == *first.TaskID {
		t.Fatalf("软删后重放应重新建：%+v", second)
	}
	e.mustResult(e.post(form, secret, seedFormSample, ""), ResultSkipped, "同样的推送内容已经建过任务，按重复推送忽略")

	if err := e.st.DeleteObject(ctx, *second.TaskID, true, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	third := e.post(form, secret, seedFormSample, "")
	if third.Result != ResultCreated {
		t.Fatalf("硬删后重放应重新建：%+v", third)
	}
	list, _, _ := e.ws.ListDeliveries(ctx, form.ID, ResultCreated, 50, 0)
	if len(list) != 3 || !list[1].TaskDeleted || !list[2].TaskDeleted || list[0].TaskDeleted || list[1].TaskRef != "" {
		t.Errorf("task_deleted / task_ref = %+v", list)
	}

	// 投递 id：同一个 id 重放只建一条，换个 id 算新投递
	e.mustResult(e.post(form, secret, seedFormNoNeed, "evt-1"), ResultFailed, "标题路径 answers.need 取不到值")
	body := `{"answers":{"need":"导出加 CSV"}}`
	a := e.post(form, secret, body, "evt-2")
	b := e.post(form, secret, body, "evt-2")
	e.mustResult(b, ResultSkipped, "投递 id evt-2 已经建过任务，按重复推送忽略")
	if a.Result != ResultCreated || a.DedupeKey != "id:evt-2" || a.ExternalID != "evt-2" {
		t.Fatalf("a = %+v", a)
	}
	if c := e.post(form, secret, body, "evt-3"); c.Result != ResultCreated {
		t.Errorf("换投递 id 应算新投递：%+v", c)
	}
}

func TestReceiveRejectsAndEdgeCases(t *testing.T) {
	e := newHookEnv(t)
	ctx := context.Background()
	sentry, secret := e.create(seedSentry)
	body := sentryPayload("x1", "boom", "error", "created")

	// 签名不对、没签名、token 不对：拒收，不留记录
	for _, s := range []string{"", "nothex", sig("wrong-secret-0000", body), "sha256=" + sig(secret, body+" ")} {
		if _, err := e.ws.Receive(ctx, sentry.Token, []byte(body), s, "", e.st); !errors.Is(err, ErrBadSignature) {
			t.Errorf("signature %q: err = %v", s, err)
		}
	}
	if _, err := e.ws.Receive(ctx, "nope", []byte(body), sig(secret, body), "", e.st); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("unknown token: %v", err)
	}
	if _, total, _ := e.ws.ListDeliveries(ctx, sentry.ID, "", 50, 0); total != 0 {
		t.Fatalf("拒收的不该留记录，total = %d", total)
	}
	// sha256= 前缀也认
	d, err := e.ws.Receive(ctx, sentry.Token, []byte(body), "sha256="+sig(secret, body), "", e.st)
	if err != nil || d.Result != ResultCreated {
		t.Fatalf("prefixed signature: %v %+v", err, d)
	}

	// 轮换后旧密钥失效
	_, newSecret, err := e.ws.RotateSecret(ctx, sentry.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.ws.Receive(ctx, sentry.Token, []byte(body), sig(secret, body), "", e.st); !errors.Is(err, ErrBadSignature) {
		t.Errorf("旧密钥应失效：%v", err)
	}
	secret = newSecret

	// 不是 JSON 对象：记 failed
	e.mustResult(e.post(sentry, secret, `[1,2]`, ""), ResultFailed, "推送内容不是 JSON 对象")
	e.mustResult(e.post(sentry, secret, `not json`, ""), ResultFailed, "推送内容不是 JSON 对象")

	// 停用：只记录不建任务
	off := false
	if _, err := e.ws.Update(ctx, sentry.ID, Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	e.mustResult(e.post(sentry, secret, sentryPayload("x2", "boom", "error", "created"), ""), ResultSkipped, "Webhook 已停用，只记录不建任务")

	// dedupe 路径取不到值时退回请求体哈希
	on := true
	if _, err := e.ws.Update(ctx, sentry.ID, Patch{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	noID := `{"action":"created","event":{"title":"no id"}}`
	if d := e.post(sentry, secret, noID, ""); d.Result != ResultCreated || len(d.DedupeKey) != len("sha256:")+64 {
		t.Fatalf("no id = %+v", d)
	}
	e.mustResult(e.post(sentry, secret, noID, ""), ResultSkipped, "同样的推送内容已经建过任务，按重复推送忽略")

	// 删 Webhook 时投递记录一起删
	if _, err := e.ws.Delete(ctx, sentry.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT COUNT(*) FROM webhook_deliveries`).Scan(&n); err != nil || n != 0 {
		t.Errorf("deliveries left = %d %v", n, err)
	}
}

// 同一投递并发重试只建一条
func TestReceiveConcurrentReplay(t *testing.T) {
	e := newHookEnv(t)
	sentry, secret := e.create(seedSentry)
	body := sentryPayload("cc01", "race", "error", "created")
	var wg sync.WaitGroup
	results := make([]string, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d, err := e.ws.Receive(context.Background(), sentry.Token, []byte(body), sig(secret, body), "", e.st)
			if err == nil {
				results[i] = d.Result
			}
		}(i)
	}
	wg.Wait()
	created := 0
	for _, r := range results {
		if r == ResultCreated {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("results = %v", results)
	}
}
