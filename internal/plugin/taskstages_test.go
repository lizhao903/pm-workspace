// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
)

// ObjectReader.TaskStages（AUTO-05）：按来源消息、联系人、IM 发送者查；删了、归档的、不是任务的不出；没条件回空。
func TestTaskStages(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	if _, err := d.W.Exec(`INSERT INTO objects (id, type_id, ref, title, status, props, deleted_at, archived_at, created_at, updated_at) VALUES
	  ('o1', 'task', 'TSK-1', '一', 'doing', '{"stage":"developing","source_ref":{"message_id":"imm_1"},"requester":{"contact_id":"stk_a","name":"甲","channel":"slack","sender_id":"U1"}}', NULL, NULL, 'x', '2026-11-04T02:00:00Z'),
	  ('o2', 'task', 'TSK-2', '二', 'todo', '{"requester":{"name":"路人","channel":"slack","sender_id":"U9","sender_name":"路人"}}', NULL, NULL, 'x', '2026-11-04T01:00:00Z'),
	  ('o3', 'task', 'TSK-3', '删了', 'todo', '{"requester":{"contact_id":"stk_a","name":"甲"}}', 'x', NULL, 'x', 'x'),
	  ('o4', 'task', 'TSK-4', '归档', 'todo', '{"requester":{"contact_id":"stk_a","name":"甲"}}', NULL, 'x', 'x', 'x'),
	  ('o5', 'requirement', 'REQ-5', '需求', 'todo', '{"requester":{"contact_id":"stk_a","name":"甲"}}', NULL, NULL, 'x', 'x')`); err != nil {
		t.Fatal(err)
	}
	r := objectReader{&core{reg: &Registry{DB: d}}}

	rows, err := r.TaskStages(ctx, TaskStageQuery{MessageID: "imm_1"})
	if err != nil || len(rows) != 1 {
		t.Fatalf("按消息：%v %v", rows, err)
	}
	if g := rows[0]; g.ID != "o1" || g.Stage != "developing" || g.StageLabel != "开发中" || g.MessageID != "imm_1" || g.Requester == nil || g.Requester.ContactID != "stk_a" {
		t.Fatalf("按消息：%+v", g)
	}
	if rows, _ := r.TaskStages(ctx, TaskStageQuery{RequesterID: "stk_a"}); len(rows) != 1 || rows[0].ID != "o1" {
		t.Fatalf("按联系人（不含删了、归档、非任务）：%+v", rows)
	}
	if rows, _ := r.TaskStages(ctx, TaskStageQuery{Channel: "slack", SenderID: "U9"}); len(rows) != 1 || rows[0].ID != "o2" || rows[0].Stage != "" || rows[0].Requester.Name != "路人" {
		t.Fatalf("按发送者：%+v", rows)
	}
	if rows, _ := r.TaskStages(ctx, TaskStageQuery{Channel: "slack"}); len(rows) != 0 {
		t.Fatalf("只给渠道等于没条件：%+v", rows)
	}
}
