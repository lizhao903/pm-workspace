package video

import "slices"

// 数据约定，对照原型 web-next/src/videodata.ts；两边同序，加值两边一起加。

// Orients 是画面比例，同原型 ORIENT 的顺序；存的时候按这个顺序排。
var Orients = []string{"landscape", "portrait", "square"}

// Stage 是制作阶段，同原型 STAGES。
type Stage struct {
	Key        string
	Label      string
	Checkpoint bool
}

var Stages = []Stage{
	{"script", "内容编写", false},
	{"plan", "规划检查", true},
	{"web", "网页开发", false},
	{"ch1", "第一章验收", true},
	{"chapters", "其余章节", false},
	{"audio", "音频合成", true},
	{"record", "录屏渲染", false},
	{"distribution", "分发包", true},
}

// CheckpointStages 是带检查点的 4 个阶段，新建视频时各写一行 pending。
var CheckpointStages = func() []string {
	var out []string
	for _, s := range Stages {
		if s.Checkpoint {
			out = append(out, s.Key)
		}
	}
	return out
}()

func stageIndex(k string) int {
	return slices.IndexFunc(Stages, func(s Stage) bool { return s.Key == k })
}

// Platforms 是发布平台，同原型 PLATFORMS 的 key。
var Platforms = []string{"bilibili", "youtube", "douyin", "channels", "xiaohongshu"}

// PublishStatuses 同原型 PUBLISH_STATUS。
var PublishStatuses = []string{"planned", "scheduled", "published", "failed"}

// CheckpointStates 同原型 CheckpointState。
var CheckpointStates = []string{"pending", "passed", "rejected", "skipped"}

// Checkpoint 同原型 Checkpoint：at、note 没有就不返回。
type Checkpoint struct {
	Stage string `json:"stage"`
	State string `json:"state"`
	At    string `json:"at,omitempty"`
	Note  string `json:"note,omitempty"`
}

// Video 同原型 Video：project_id、series_id、episode 没有就不返回。
type Video struct {
	ID           string       `json:"id"`
	Title        string       `json:"title"`
	ProjectID    *string      `json:"project_id,omitempty"`
	SeriesID     *string      `json:"series_id,omitempty"`
	Episode      *int         `json:"episode,omitempty"`
	Orientations []string     `json:"orientations"`
	Stage        string       `json:"stage"`
	Checkpoints  []Checkpoint `json:"checkpoints"`
	Root         string       `json:"root"`
	Chapters     int          `json:"chapters"`
	CreatedAt    string       `json:"created_at"`
	UpdatedAt    string       `json:"updated_at"`
}

// Series 同原型 Series，多时间。stale 是改过共用部分还没同步的集，按集数排。
type Series struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Desc      string   `json:"desc"`
	Intro     string   `json:"intro"`
	Outro     string   `json:"outro"`
	Template  string   `json:"template"`
	Stale     []string `json:"stale"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

// Metrics 同原型 Metrics：平台回填的播放数据。
type Metrics struct {
	Views     int    `json:"views"`
	Likes     int    `json:"likes"`
	Comments  int    `json:"comments"`
	Shares    int    `json:"shares"`
	UpdatedAt string `json:"updated_at"`
}

// Publish 同原型 Publish，多时间；可选字段没有就不返回。
type Publish struct {
	ID          string   `json:"id"`
	VideoID     string   `json:"video_id"`
	Platform    string   `json:"platform"`
	Variant     string   `json:"variant"`
	CoverID     string   `json:"cover_id,omitempty"`
	Title       string   `json:"title"`
	Desc        string   `json:"desc"`
	Status      string   `json:"status"`
	ScheduledAt *string  `json:"scheduled_at,omitempty"`
	PublishedAt *string  `json:"published_at,omitempty"`
	URL         string   `json:"url,omitempty"`
	Error       string   `json:"error,omitempty"`
	Metrics     *Metrics `json:"metrics,omitempty"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

// ArtifactKind 同原型 ARTIFACT_KIND：PerVariant 是不是每个比例一份。
type ArtifactKind struct {
	Key        string
	Label      string
	Stage      string
	PerVariant bool
}

var ArtifactKinds = []ArtifactKind{
	{"article", "原文", "script", false},
	{"script", "口播稿", "script", false},
	{"outline", "大纲", "script", false},
	{"presentation", "演示工程", "web", true},
	{"audio", "音频", "audio", false},
	{"video", "视频", "record", true},
	{"cover", "封面", "distribution", true},
	{"description", "简介", "distribution", false},
	{"chapters", "章节时间轴", "distribution", false},
}

func artifactKind(k string) (ArtifactKind, bool) {
	i := slices.IndexFunc(ArtifactKinds, func(a ArtifactKind) bool { return a.Key == k })
	if i < 0 {
		return ArtifactKind{}, false
	}
	return ArtifactKinds[i], true
}

// ArtifactStatuses 同原型 ARTIFACT_STATUS。
var ArtifactStatuses = []string{"draft", "review", "final", "published"}

// SourceTypes 同原型 Artifact.source.type；SourceLabels 是没给名字时的默认显示。
var SourceTypes = []string{"manual", "sop", "agent", "skill"}

var SourceLabels = map[string]string{"manual": "手动登记", "sop": "SOP", "agent": "Agent", "skill": "技能"}

// Review 同原型 Review，多一个 version：验收的是第几版。
type Review struct {
	At      string `json:"at"`
	OK      bool   `json:"ok"`
	Comment string `json:"comment"`
	Version int    `json:"version"`
}

// ArtifactSource 同原型 source，多内核产物溯源（AG-03b）的几个 id，没有就不返回。
type ArtifactSource struct {
	Type       string `json:"type"`
	Label      string `json:"label"`
	ID         string `json:"id,omitempty"`
	SessionID  string `json:"session_id,omitempty"`
	RunID      string `json:"run_id,omitempty"`
	ArtifactID string `json:"artifact_id,omitempty"`
}

// Artifact 同原型 Artifact，多 updated_at；variant、option、duration 没有就不返回，picked 只有封面返回。
type Artifact struct {
	ID        string         `json:"id"`
	VideoID   string         `json:"video_id"`
	Kind      string         `json:"kind"`
	Name      string         `json:"name"`
	Path      string         `json:"path"`
	Variant   string         `json:"variant,omitempty"`
	Option    *int           `json:"option,omitempty"`
	Version   int            `json:"version"`
	Status    string         `json:"status"`
	Duration  *int           `json:"duration,omitempty"`
	Source    ArtifactSource `json:"source"`
	Reviews   []Review       `json:"reviews"`
	Picked    *bool          `json:"picked,omitempty"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}
