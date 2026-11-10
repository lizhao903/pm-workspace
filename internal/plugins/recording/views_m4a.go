// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

// M4a 的视图类型（契约冻结，见 docs/api-contract.md「录音转写插件 recording」）。
// 字段名与契约文档一一对应，改字段名等于改接口，动了要同步文档和 contract_shape_test.go。

// RecordingMinutes 是结构化纪要，存 recording_recordings.minutes_json，也写 minutes.json。
type RecordingMinutes struct {
	SummaryMD   string              `json:"summary_md"`
	Conclusions []string            `json:"conclusions"`
	Actions     []RecordingAction   `json:"actions"`
	Projects    []RecordingProject  `json:"projects"`
	Goals       []RecordingGoal     `json:"goals"`
	Questions   []RecordingQuestion `json:"questions"`
	Diagrams    RecordingDiagrams   `json:"diagrams"`
	GeneratedAt string              `json:"generated_at"`
	Model       string              `json:"model"`
}

// RecordingAction 是纪要里的一条待办建议。
type RecordingAction struct {
	Title      string  `json:"title"`
	Detail     string  `json:"detail"`
	Owner      string  `json:"owner"`
	Due        string  `json:"due"`
	Project    string  `json:"project"`
	Confidence float64 `json:"confidence"`
	Kind       string  `json:"kind"`
}

// RecordingProject 是识别出的项目候选（project_id 是按名字匹配到的已有项目，没匹配到空串）。
type RecordingProject struct {
	Name         string  `json:"name"`
	Confidence   float64 `json:"confidence"`
	Reason       string  `json:"reason"`
	ProjectID    string  `json:"project_id"`
	ProjectTitle string  `json:"project_title"`
}

// RecordingGoal 是识别出的工作目标候选。
type RecordingGoal struct {
	Title      string  `json:"title"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
}

// RecordingQuestion 是 AI 没把握、留给用户确认的问题。
type RecordingQuestion struct {
	Question   string  `json:"question"`
	Why        string  `json:"why"`
	Confidence float64 `json:"confidence"`
}

// RecordingDiagrams 是纪要里的流程图和树形图（前端自己渲染，同时导出 mermaid 源码）。
type RecordingDiagrams struct {
	Flow RecordingFlow `json:"flow"`
	Tree RecordingTree `json:"tree"`
}

// RecordingFlow 是流程图。
type RecordingFlow struct {
	Title string              `json:"title"`
	Nodes []RecordingFlowNode `json:"nodes"`
	Edges []RecordingFlowEdge `json:"edges"`
}

// RecordingFlowNode 是流程图节点，kind 为 start / process / decision / end。
type RecordingFlowNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

// RecordingFlowEdge 是流程图的一条边。
type RecordingFlowEdge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
}

// RecordingTree 是树形图。
type RecordingTree struct {
	Title string            `json:"title"`
	Root  RecordingTreeNode `json:"root"`
}

// RecordingTreeNode 是树形图的一个节点。
type RecordingTreeNode struct {
	Label    string              `json:"label"`
	Children []RecordingTreeNode `json:"children"`
}

// RecordingFile 是录音目录里生成的文件（GET /files 的返回项）。
type RecordingFile struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Bytes     int64  `json:"bytes"`
	UpdatedAt string `json:"updated_at"`
}

// RecordingTodo 是一条候选（项目/任务/目标），高置信度的推给用户确认，确认后建任务或挂项目。
type RecordingTodo struct {
	Index        int     `json:"index"`
	Kind         string  `json:"kind"`
	Title        string  `json:"title"`
	Detail       string  `json:"detail"`
	Confidence   float64 `json:"confidence"`
	Status       string  `json:"status"`
	ProjectID    string  `json:"project_id"`
	ProjectTitle string  `json:"project_title"`
	ObjectID     string  `json:"object_id"`
	ObjectRef    string  `json:"object_ref"`
	Reason       string  `json:"reason"`
	OwnerName    string  `json:"owner_name"`
	DueAt        string  `json:"due_at"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}
