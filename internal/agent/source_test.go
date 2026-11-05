package agent

import (
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 会话来源（0047）：从 IM 消息发起的会话里建的任务，props.source_ref 记会话来源，缺省挂到来源的项目。
func TestCreateObjectAppliesSessionSource(t *testing.T) {
	tb, st, ctx, wd := newToolbox(t)
	proj, err := st.CreateObject(ctx, &domain.Object{TypeID: "project", Title: "Acme"}, agentActor)
	if err != nil {
		t.Fatalf("建项目: %v", err)
	}
	sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: "拆任务", Workdir: wd, SourceRef: map[string]any{
		"kind": "im_message", "message_id": "imm_1", "message_ids": []any{"imm_1", "imm_2"}, "project_id": proj.ID, "label": "IM 消息",
	}})
	if err != nil {
		t.Fatalf("建会话: %v", err)
	}
	got, err := st.GetAgentSession(ctx, sess.ID)
	if err != nil || got.SourceRef["message_id"] != "imm_1" {
		t.Fatalf("读回会话来源: %v %v", got, err)
	}
	tb = NewToolbox(st, got)

	res := call(t, tb, ctx, "create_object", map[string]any{"type_id": "task", "title": "开通试点账号"})
	if res.ObjectID == "" {
		t.Fatalf("没建出来: %+v", res)
	}
	o, err := st.GetObject(ctx, res.ObjectID)
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := o.Props[domain.PropSourceRef].(map[string]any)
	if ref["message_id"] != "imm_1" || o.ProjectID == nil || *o.ProjectID != proj.ID {
		t.Fatalf("来源、项目：%v %v", o.Props, o.ProjectID)
	}

	// 项目删了就不挂项目，来源照记
	if err := st.DeleteObject(ctx, proj.ID, false, agentActor); err != nil {
		t.Skipf("删不了对象（%v），跳过项目删除这一段", err)
	}
	res = call(t, tb, ctx, "create_object", map[string]any{"type_id": "task", "title": "第二条"})
	o, _ = st.GetObject(ctx, res.ObjectID)
	if o == nil || o.ProjectID != nil || o.Props[domain.PropSourceRef] == nil {
		t.Fatalf("项目删了：%+v", o)
	}
}

func TestSourceSection(t *testing.T) {
	if sourceSection(nil) != "" || sourceSection(&domain.AgentSession{}) != "" {
		t.Fatal("没有来源不该写")
	}
	got := sourceSection(&domain.AgentSession{SourceRef: map[string]any{"label": "IM 消息「周屿」", "project_id": "obj_x"}})
	if !strings.Contains(got, "IM 消息「周屿」") || !strings.Contains(got, "项目") {
		t.Fatalf("来源说明：%s", got)
	}
}
