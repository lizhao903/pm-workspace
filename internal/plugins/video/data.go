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
