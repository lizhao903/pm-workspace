// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// --- 会话级追加要求进系统提示词（S-2，0057） ---

// 会话 instruction 非空时，每一轮的系统提示词最后带上它；为空时既有结构一字不改。
func TestBuildHistorySessionInstruction(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	types, err := st.ListObjectTypes(ctx)
	if err != nil {
		t.Fatal(err)
	}

	withIns, err := st.CreateAgentSession(ctx, &domain.AgentSession{
		Title: "带要求的会话", Instruction: "这次只讨论前端，不要建任务",
	})
	if err != nil {
		t.Fatal(err)
	}
	r := &Runner{Store: st, Session: withIns}
	hist, err := r.buildHistory(ctx, types)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) == 0 || hist[0].Role != RoleSystem {
		t.Fatalf("历史 = %+v", hist)
	}
	system := hist[0].Content
	if !strings.Contains(system, "这次会话的追加要求") || !strings.Contains(system, "这次只讨论前端，不要建任务") {
		t.Fatalf("系统提示词没带上会话追加要求：%s", system)
	}
	// 追加在最后：既有系统提示词结构不变，新要求压在最后一段
	if !strings.HasSuffix(strings.TrimSpace(system), "这次只讨论前端，不要建任务") {
		t.Fatalf("追加要求应在系统提示词最后：%s", system)
	}
	if !strings.HasPrefix(system, "你是「产品工作台」里的助理") {
		t.Fatalf("既有系统提示词结构被改了：%s", system[:40])
	}

	plain, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: "没要求的会话"})
	if err != nil {
		t.Fatal(err)
	}
	hist, err = (&Runner{Store: st, Session: plain}).buildHistory(ctx, types)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(hist[0].Content, "这次会话的追加要求") {
		t.Fatalf("没有 instruction 时不该多出这一段：%s", hist[0].Content)
	}

	// nil 会话（历史构造的边界）安全
	if instructionSection(nil) != "" {
		t.Fatal("nil 会话应回空串")
	}
}
