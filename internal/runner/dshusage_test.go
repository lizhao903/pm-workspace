// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

const testDSHSessionLog = `{"type":"session","data":{"id":"session-test-1","cwd":"/tmp/module"}}
{"type":"system/message","data":{"turn":1,"step":1,"message":{"role":"system","content":[{"type":"text","text":"你是助手"}]}}}
{"type":"assistant/message","data":{"turn":1,"step":1,"usage":{"inputTokens":1000,"outputTokens":20,"totalTokens":1020}}}
{"type":"assistant/message","data":{"turn":1,"step":2,"usage":{"inputTokens":100,"outputTokens":30,"totalTokens":1212,"cacheReadTokens":1082}}}
{"type":"assistant/message","data":{"turn":2,"step":1,"usage":{"inputTokens":50,"outputTokens":10,"totalTokens":120,"cacheReadTokens":60}}}
`

func writePlainSessionLog(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "session.v2.jsonl")
	if err := os.WriteFile(path, []byte(testDSHSessionLog), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeZstdSessionLog(t *testing.T, path string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w, err := zstd.NewWriter(f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(testDSHSessionLog)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestReadDSHSessionUsagePlain(t *testing.T) {
	path := writePlainSessionLog(t, t.TempDir())
	u, err := ReadDSHSessionUsage(path)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if u.SessionID != "session-test-1" || u.Cwd != "/tmp/module" {
		t.Fatalf("会话信息不对: %+v", u)
	}
	if u.SystemPrompt != "你是助手" {
		t.Fatalf("系统提示不对: %q", u.SystemPrompt)
	}
	if len(u.Steps) != 3 {
		t.Fatalf("步数 %d，期望 3", len(u.Steps))
	}
	if u.CacheReadTokens != 1082+60 || u.UncachedInputTokens != 1000+100+50 || u.OutputTokens != 60 {
		t.Fatalf("汇总不对: %+v", u)
	}
	if u.PromptTokens != u.CacheReadTokens+u.UncachedInputTokens {
		t.Fatalf("总输入不对: %+v", u)
	}
	if got, want := u.FirstStep().UncachedInputTokens, 1000; got != want {
		t.Fatalf("首步未命中 %d，期望 %d", got, want)
	}
	if r := u.CacheHitRatio(); r <= 0.4 || r >= 1 {
		t.Fatalf("命中率 %v 不在合理范围", r)
	}
}

func TestReadDSHSessionUsageZstd(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.v4.jsonl.zstd")
	writeZstdSessionLog(t, path)
	u, err := ReadDSHSessionUsage(path)
	if err != nil {
		t.Fatalf("解析 zstd 失败: %v", err)
	}
	if u.CacheReadTokens != 1142 || u.Steps[1].CacheReadTokens != 1082 {
		t.Fatalf("zstd 汇总不对: %+v", u)
	}
}

func TestFindDSHSessionLog(t *testing.T) {
	home := t.TempDir()
	sessID := "session-abc"
	dirA := filepath.Join(home, "sessions", "--tmp-a--", sessID)
	dirB := filepath.Join(home, "sessions", "--tmp-b--", sessID)
	for _, d := range []string{dirA, dirB} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// 低版本 + 高版本：应取高版本。
	writeZstdSessionLog(t, filepath.Join(dirB, "session.v3.jsonl.zstd"))
	writeZstdSessionLog(t, filepath.Join(dirB, "session.v4.jsonl.zstd"))
	// 另一个 cwd 目录里的低版本不该被选中。
	writePlainSessionLog(t, dirA)

	got, err := FindDSHSessionLog(home, sessID)
	if err != nil {
		t.Fatalf("没找到: %v", err)
	}
	if !strings.HasSuffix(got, filepath.Join("--tmp-b--", sessID, "session.v4.jsonl.zstd")) {
		t.Fatalf("选错文件: %s", got)
	}

	if _, err := FindDSHSessionLog(home, "session-nope"); err == nil {
		t.Fatal("不存在的会话应该报错")
	}
}

func TestReadDSHSessionUsageIgnoresTruncatedTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.v4.jsonl")
	body := testDSHSessionLog + `{"type":"assistant/message","data":{"turn":3,"st`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	u, err := ReadDSHSessionUsage(path)
	if err != nil {
		t.Fatalf("尾行不完整不该报错: %v", err)
	}
	if len(u.Steps) != 3 {
		t.Fatalf("步数 %d，期望 3", len(u.Steps))
	}
}
