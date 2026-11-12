// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"strings"
	"testing"
)

// 会话来源（0047）：不给、null 为没有；不是对象、太长 400
func TestParseSourceRef(t *testing.T) {
	for _, raw := range []string{"", "null", " null "} {
		if m, err := parseSourceRef(json.RawMessage(raw)); m != nil || err != nil {
			t.Fatalf("%q: %v %v", raw, m, err)
		}
	}
	m, err := parseSourceRef(json.RawMessage(`{"kind":"im_message","message_id":"imm_1"}`))
	if err != nil || m["message_id"] != "imm_1" {
		t.Fatalf("对象：%v %v", m, err)
	}
	for _, raw := range []string{`"x"`, `[1]`, `{bad`, `{"t":"` + strings.Repeat("a", sourceRefMax) + `"}`} {
		if _, err := parseSourceRef(json.RawMessage(raw)); err == nil {
			t.Fatalf("%.20q 应该 400", raw)
		}
	}
}
