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

// 选题（VID-09a）在最前面：新建视频从它开始，立项生成的视频直接到内容编写。
var Stages = []Stage{
	{"topic", "选题", false},
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

// PlatformLabels 是平台的显示名，报错时用，同原型 PLATFORMS 的 label。
var PlatformLabels = map[string]string{"bilibili": "B 站", "youtube": "YouTube", "douyin": "抖音", "channels": "视频号", "xiaohongshu": "小红书"}

// PlatformCovers 是平台收的封面比例，第一个是推荐的，同原型 PLATFORMS 的 cover；发布记录选封面时按它校验。
var PlatformCovers = map[string][]string{
	"bilibili":    {"16x9", "4x3"},
	"youtube":     {"16x9"},
	"douyin":      {"3x4", "9x16"},
	"channels":    {"9x16", "3x4"},
	"xiaohongshu": {"3x4", "1x1"},
}

// CoverRatios 是封面比例，同原型 CoverRatio；CoverRatioLabels 是显示名。
var CoverRatios = []string{"16x9", "4x3", "9x16", "3x4", "1x1"}

var CoverRatioLabels = map[string]string{"16x9": "16:9", "4x3": "4:3", "9x16": "9:16", "3x4": "3:4", "1x1": "1:1"}

// DefaultCoverRatios 同原型 DEFAULT_COVER_RATIOS：每个舞台方向默认出哪几种封面比例，第一个和舞台同比例。
// 登记封面没给 ratio 时取第一个，0002 时登记的老封面也按它补。
var DefaultCoverRatios = map[string][]string{
	"landscape": {"16x9", "4x3"},
	"portrait":  {"9x16", "3x4", "1x1"},
	"square":    {"1x1", "4x3"},
}

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

// Video 同原型 Video：project_id、series_id、episode、topic_id 没有就不返回。
type Video struct {
	ID           string        `json:"id"`
	Title        string        `json:"title"`
	ProjectID    *string       `json:"project_id,omitempty"`
	SeriesID     *string       `json:"series_id,omitempty"`
	Episode      *int          `json:"episode,omitempty"`
	TopicID      *string       `json:"topic_id,omitempty"`
	Orientations []string      `json:"orientations"`
	Stage        string        `json:"stage"`
	Checkpoints  []Checkpoint  `json:"checkpoints"`
	Root         string        `json:"root"`
	Chapters     int           `json:"chapters"`
	Runners      []StageRunner `json:"runners"`
	LastRun      *LastRun      `json:"last_run,omitempty"`
	// 计划首发日 YYYY-MM-DD（VID-06c），排日历、算进度落后，没有就不返回
	TargetDate *string `json:"target_date,omitempty"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

// StageRunner 同原型 StageRunner：这一阶段交给谁跑（VID-03b），prompt 没有就不返回。
type StageRunner struct {
	Stage  string `json:"stage"`
	Type   string `json:"type"`
	RefID  string `json:"ref_id"`
	Prompt string `json:"prompt,omitempty"`
}

// LastRun 同原型 LastRun：最近一次执行。id 是内核插件运行的 id（run_），没起来就失败的为空串；
// ref 是原型没有的，Agent 会话 id 或 SOP 执行 id，没有就不返回。
type LastRun struct {
	Type        string   `json:"type"`
	ID          string   `json:"id"`
	Stage       string   `json:"stage"`
	Status      string   `json:"status"`
	StartedAt   string   `json:"started_at"`
	EndedAt     string   `json:"ended_at,omitempty"`
	Error       string   `json:"error,omitempty"`
	ArtifactIDs []string `json:"artifact_ids,omitempty"`
	Ref         string   `json:"ref,omitempty"`
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

// Metrics 同原型 Metrics：平台回填的播放数据。扩展的几项（VID-05a）平台不提供的留空、不返回。
type Metrics struct {
	Views           int      `json:"views"`
	Likes           int      `json:"likes"`
	Comments        int      `json:"comments"`
	Shares          int      `json:"shares"`
	Impressions     *int     `json:"impressions,omitempty"`
	CTR             *float64 `json:"ctr,omitempty"`
	AvgWatchSec     *float64 `json:"avg_watch_sec,omitempty"`
	Completion      *float64 `json:"completion,omitempty"`
	Favorites       *int     `json:"favorites,omitempty"`
	Coins           *int     `json:"coins,omitempty"`
	FollowersGained *int     `json:"followers_gained,omitempty"`
	UpdatedAt       string   `json:"updated_at"`
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
	// VID-05a：发布用的平台账号、标签、分区、合集和发布前校验结果
	AccountID  string         `json:"account_id,omitempty"`
	Tags       []string       `json:"tags,omitempty"`
	Category   string         `json:"category,omitempty"`
	Collection string         `json:"collection,omitempty"`
	Checks     []PublishCheck `json:"checks,omitempty"`
	CreatedAt  string         `json:"created_at"`
	UpdatedAt  string         `json:"updated_at"`
}

// ArtifactKind 同原型 ARTIFACT_KIND：PerVariant 是不是每个比例一份。
type ArtifactKind struct {
	Key        string
	Label      string
	Stage      string
	PerVariant bool
}

// 口播稿、大纲、简介、章节时间轴按比例各一套（技能布局 B，VID-02a）；原文、音频共用。
var ArtifactKinds = []ArtifactKind{
	{"article", "原文", "script", false},
	{"script", "口播稿", "script", true},
	{"outline", "大纲", "script", true},
	{"presentation", "演示工程", "web", true},
	{"audio", "音频", "audio", false},
	{"video", "视频", "record", true},
	{"subtitle", "字幕", "record", true},
	{"cover", "封面", "distribution", true},
	{"description", "简介", "distribution", true},
	{"chapters", "章节时间轴", "distribution", true},
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

// Artifact 同原型 Artifact，多 updated_at；variant、ratio、option、lang、duration 没有就不返回，picked、archived 只有封面返回。
// ratio 只有封面有，lang 只有字幕有。
type Artifact struct {
	ID        string         `json:"id"`
	VideoID   string         `json:"video_id"`
	Kind      string         `json:"kind"`
	Name      string         `json:"name"`
	Path      string         `json:"path"`
	Variant   string         `json:"variant,omitempty"`
	Ratio     string         `json:"ratio,omitempty"`
	Option    *int           `json:"option,omitempty"`
	Lang      string         `json:"lang,omitempty"`
	Version   int            `json:"version"`
	Status    string         `json:"status"`
	Duration  *int           `json:"duration,omitempty"`
	Source    ArtifactSource `json:"source"`
	Reviews   []Review       `json:"reviews"`
	Picked    *bool          `json:"picked,omitempty"`
	Archived  *bool          `json:"archived,omitempty"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}
