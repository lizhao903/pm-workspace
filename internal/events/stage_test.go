package events_test

import (
	"context"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TestStageChangedEvent：props.stage 变了发 object.stage_changed（AUTO-05），别的 props 变了不发。
func TestStageChangedEvent(t *testing.T) {
	ctx := context.Background()
	rec := &recorder{}
	_, bus := setup(t, newPlugin(t, "rec", `,"subscribes":["object.stage_changed","object.updated"]`, rec.handle))
	st, _ := newStore(t, bus)

	o, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "阶段", Props: map[string]any{"acceptance": "x"}}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	rec.reset()

	props := map[string]any{"acceptance": "x", domain.PropStage: "received"}
	if _, err := st.UpdateObject(ctx, o.ID, domain.ObjectPatch{Props: &props}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	if got := rec.find(t, events.ObjectStageChanged); got["id"] != o.ID || got["from"] != "" || got["to"] != "received" || got["type_id"] != "task" {
		t.Fatalf("object.stage_changed = %v", got)
	}

	// 只改别的 props：发 object.updated，不发阶段事件
	rec.reset()
	props2 := map[string]any{"acceptance": "y", domain.PropStage: "received"}
	if _, err := st.UpdateObject(ctx, o.ID, domain.ObjectPatch{Props: &props2}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	for _, typ := range rec.types() {
		if typ == events.ObjectStageChanged {
			t.Fatalf("阶段没变却发了 object.stage_changed：%v", rec.types())
		}
	}
}
