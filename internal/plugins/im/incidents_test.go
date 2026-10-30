package im

import (
	"testing"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

// TestFetchBlockedRecordsIncident：连接器异常时取不到附件记一条 warn 运行异常（INC-01a）；暂停等别的原因不记。
func TestFetchBlockedRecordsIncident(t *testing.T) {
	e, _ := setupAttachments(t)
	e.r.SetIncidents(incident.New(e.st.DB(), nil))
	for _, c := range []struct{ ext, connector string }{{"x1", "cn_err"}, {"x2", "cn_paused"}} {
		mid := e.push(t, "fake", `{"external_id":"`+c.ext+`","connector_id":"`+c.connector+`","conversation_id":"C01","sender_id":"U04LIN",
		  "attachments":[{"id":"a1","name":"合同.docx","kind":"file"}]}`)
		if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", ""); code != 409 {
			t.Fatalf("%s 应被拦：%d %v", c.connector, code, out)
		}
	}
	var n int
	var level, module, title, msg, source string
	if err := e.st.DB().R.QueryRow(`SELECT COUNT(*) FROM incidents`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("应只记一条：%d %v", n, err)
	}
	if err := e.st.DB().R.QueryRow(`SELECT level, module, title, message, source FROM incidents WHERE fingerprint = 'att:cn_err'`).
		Scan(&level, &module, &title, &msg, &source); err != nil {
		t.Fatal(err)
	}
	if level != "warn" || module != "IM 消息" || title != "附件获取失败" || msg != "「合同.docx」没取到：连接器「Slack 坏了」异常" || source != "plugin:im" {
		t.Fatalf("记下的：%s %s %s %s %s", level, module, title, msg, source)
	}
}
