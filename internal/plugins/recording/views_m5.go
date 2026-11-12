// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

// M5 的视图类型（契约冻结，见 docs/api-contract.md「录音转写插件 recording」）。
// 字段名与契约文档一一对应，改字段名等于改接口，动了要同步文档和 contract_shape_test.go。

// RecordingSpeaker 是一条录音里识别出的一个说话人（label 如 spk_1，可改名/绑定联系人）。
type RecordingSpeaker struct {
	Label       string  `json:"label"`
	Name        string  `json:"name"`
	ContactID   string  `json:"contact_id"`
	ContactName string  `json:"contact_name"`
	Similarity  float64 `json:"similarity"`
	Segments    int     `json:"segments"`
	DurationMs  int64   `json:"duration_ms"`
	Detected    bool    `json:"detected"`
}

// Voiceprint 是已登记到某个联系人的声纹（本机存储，来自一次绑定的录音说话人质心）。
type Voiceprint struct {
	ContactID         string `json:"contact_id"`
	ContactName       string `json:"contact_name"`
	Model             string `json:"model"`
	SourceRecordingID string `json:"source_recording_id"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
}
