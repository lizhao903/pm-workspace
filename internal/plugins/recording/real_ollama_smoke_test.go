// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

// 真 Ollama 冒烟测试（默认跳过）：验证会议纪要提示词在本机模型上能产出可解析的 JSON。
// 手动跑：RECORDING_REAL_OLLAMA=1 [RECORDING_REAL_MODEL=qwen3.5:4b] go test ./internal/plugins/recording -run TestRealOllamaMinutesSmoke -v

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"testing"
)

const realSampleTranscript = `张伟：今天主要过一下官网改版的事。现在老官网是 2021 年的，移动端体验很差，Q4 我们想把新版推上线。
李娜：设计这边已经出了两版首页方案，A 版是信息密度高、B 版偏品牌调性。我建议先用 B 版跑灰度。
王强：开发排期上有风险，前端只有两个人。如果 Q4 上线，10 月底必须冻结需求，11 月中要提测。
张伟：那就按 11 月 15 日提测、12 月 1 日灰度、12 月 15 日全量这个节奏。预算大概 40 万，包含设计外包和云资源。
李娜：设计外包报价还没定，这周我去谈，预计 15 万左右。
王强：云资源这次不用新增，现有的够用。数据库要加一个只读从库，成本大概每月 800。
张伟：好，那就把只读从库也列进任务。另外 SEO 迁移别忘了，老站有 3 万多个页面要做 301。
李娜：SEO 迁移可以找外部团队，需要单独预算，我先出个方案。
张伟：行，下周例会再对。今天先这样。`

func TestRealOllamaMinutesSmoke(t *testing.T) {
	if os.Getenv("RECORDING_REAL_OLLAMA") != "1" {
		t.Skip("设 RECORDING_REAL_OLLAMA=1 才跑真 Ollama 冒烟")
	}
	rec := recordingRow{ID: "rec_smoke", Title: "官网改版评审", Transcript: realSampleTranscript}
	prompt := buildMinutesPrompt(rec, realSampleTranscript, nil)
	model := os.Getenv("RECORDING_REAL_MODEL")
	if model == "" {
		model = "qwen3.5:4b"
	}
	reqBody, _ := json.Marshal(map[string]any{
		"model":   model,
		"prompt":  minutesSystemPrompt + "\n\n" + prompt,
		"stream":  false,
		"options": map[string]any{"temperature": 0.2},
	})
	resp, err := http.Post("http://127.0.0.1:11434/api/generate", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatalf("调 Ollama 失败：%v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Ollama 回 %d：%s", resp.StatusCode, clip(string(raw), 300))
	}
	var out struct {
		Response string `json:"response"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("解 Ollama 响应：%v", err)
	}
	mins, err := parseMinutesJSON(out.Response)
	if err != nil {
		t.Fatalf("模型输出解析失败：%v\n原始输出：\n%s", err, clip(out.Response, 2000))
	}
	t.Logf("解析成功：summary=%d 字, conclusions=%d, actions=%d, projects=%v, goals=%d, questions=%d, flowNodes=%d, treeChildren=%d",
		len([]rune(mins.SummaryMD)), len(mins.Conclusions), len(mins.Actions), mins.Projects,
		len(mins.Goals), len(mins.Questions), len(mins.Diagrams.Flow.Nodes), len(mins.Diagrams.Tree.Root.Children))
	if len(mins.Actions) == 0 || len(mins.Diagrams.Flow.Nodes) == 0 {
		t.Fatalf("纪要内容太贫乏：actions=%d flowNodes=%d", len(mins.Actions), len(mins.Diagrams.Flow.Nodes))
	}
}
