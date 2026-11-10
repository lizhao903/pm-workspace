// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内容平台适配接口（VID-04b）：每个平台一个适配器，自带连接器定义（凭证存在连接器的保险箱条目里，调用时经
// Core.Connectors().With 现取），出网走 Core.HTTP("media-platforms")。发布记录上的接口见 remote.go。
// 适配器声明自己实际能做什么（Caps），没声明的能力接口直接 400，不去试。

// 平台能力，同原型 ContentPlatformCap 的前四个。
const (
	CapUpload   = "upload"   // 上传成片、设封面、投稿
	CapSchedule = "schedule" // 投稿时定时公开
	CapMetrics  = "metrics"  // 拉单条稿件的数据
	CapComments = "comments" // 拉评论
)

// LocalFile 是本机上要传的文件，路径已经按视频工程目录解析成绝对路径。
type LocalFile struct {
	Path string
	Name string
	Size int64
}

// PublishInput 是一次投稿的内容：标题简介来自发布记录，标签分区合集由投稿请求给。
type PublishInput struct {
	Title       string
	Desc        string
	Tags        []string
	Category    string // 分区，平台要选的才有（B 站是分区 id）
	Collection  string // 合集 / 播放列表
	ScheduledAt string // RFC3339，空串是立即公开
	Video       LocalFile
	Cover       *LocalFile
}

// RemoteRef 是平台上的一条稿件：ID 是平台的稿件号（B 站 BV 号），URL 是给人看的链接，存在发布记录的 url 上。
type RemoteRef struct {
	ID  string
	URL string
}

// 稿件在平台上的状态。
const (
	RemoteReviewing = "reviewing" // 转码、审核中
	RemotePublished = "published" // 已公开
	RemoteFailed    = "failed"    // 退回、锁定、转码失败，Reason 是平台给的原因
)

// RemoteStatus 是查稿件状态的结果。
type RemoteStatus struct {
	State       string `json:"state"`
	Label       string `json:"label"`
	Reason      string `json:"reason,omitempty"`
	PublishedAt string `json:"published_at,omitempty"`
}

// RemoteStats 是单条稿件的数据，落到发布记录的 metrics 和按天快照（VID-05a）。
// Favorites、Coins 只有适配器实现了 StatsKeys 并列出来才落库，否则当平台没给；带指针的几项平台不给就留 nil。
type RemoteStats struct {
	Views     int `json:"views"`
	Likes     int `json:"likes"`
	Comments  int `json:"comments"`
	Shares    int `json:"shares"`
	Favorites int `json:"favorites"`
	Coins     int `json:"coins"`
	Danmaku   int `json:"danmaku"`

	Impressions     *int     `json:"impressions,omitempty"`
	CTR             *float64 `json:"ctr,omitempty"`
	AvgWatchSec     *float64 `json:"avg_watch_sec,omitempty"`
	Completion      *float64 `json:"completion,omitempty"`
	FollowersGained *int     `json:"followers_gained,omitempty"`
}

// StatsKeys 是适配器的可选接口：Stats 里 Favorites、Coins 哪几项是平台真给的（metrics 的 json key）。
type StatsKeys interface {
	StatsKeys() []string
}

// Comment 是平台上的一条评论。
type Comment struct {
	ID      string `json:"id"`
	Author  string `json:"author"`
	Text    string `json:"text"`
	Likes   int    `json:"likes"`
	At      string `json:"at"`
	ReplyTo string `json:"reply_to,omitempty"`
}

// CommentPage 是一页评论，Next 为空串表示没有下一页。
type CommentPage struct {
	Items []Comment
	Next  string
}

// Session 是一次调用要用的出网客户端和连接器配置，只在 Connectors().With 的回调里有效。
type Session struct {
	HTTP   *http.Client
	Config plugin.ConnectorConfig
}

// PlatformAdapter 是一个内容平台的适配器。Caps 里没有的能力，对应的方法不会被调用。
type PlatformAdapter interface {
	// Platform 是平台 key，同 Platforms。
	Platform() string
	Caps() []string
	// ConnectorDef 是平台的连接器定义，插件注册时登记；Tool 要在清单 provides.connectors 里。
	ConnectorDef() plugin.ConnectorDef
	// Bind 在插件注册时交给适配器内核句柄，连通测试要用它出网。
	Bind(c plugin.Core)
	// Validate 在上传之前按平台规则查投稿内容，不合规的回给用户看的说明。
	Validate(in PublishInput) error
	// UploadVideo 上传成片（分片），回平台给的上传凭据，投稿时带上。
	UploadVideo(ctx context.Context, s Session, f LocalFile) (string, error)
	// UploadCover 上传封面，回平台上的封面地址。
	UploadCover(ctx context.Context, s Session, f LocalFile) (string, error)
	// Submit 投稿：标题、简介、标签、分区、合集、定时。
	Submit(ctx context.Context, s Session, in PublishInput, upload, cover string) (RemoteRef, error)
	// RefOf 从发布记录的链接认出稿件号，认不出回 false。
	RefOf(url string) (RemoteRef, bool)
	Status(ctx context.Context, s Session, ref RemoteRef) (RemoteStatus, error)
	Stats(ctx context.Context, s Session, ref RemoteRef) (RemoteStats, error)
	Comments(ctx context.Context, s Session, ref RemoteRef, cursor string) (CommentPage, error)
}

func hasCap(a PlatformAdapter, c string) bool { return a != nil && slices.Contains(a.Caps(), c) }

// ErrUnsupported：平台没有这个能力。
var ErrUnsupported = errors.New("平台不支持")

// PlatformError 是平台回的错误或连不上。Channel 为 true 时是渠道异常（令牌失效、没有权限、连不上、平台出错），
// 连接器随之置为异常；为 false 的是这次投稿的内容不被接受，连接器不动。
type PlatformError struct {
	Platform string
	Code     int
	Msg      string
	Auth     bool // 令牌失效或没有权限
	Channel  bool
}

func (e *PlatformError) Error() string {
	label := PlatformLabels[e.Platform]
	if label == "" {
		label = e.Platform
	}
	if e.Code == 0 {
		return label + "：" + e.Msg
	}
	msg := fmt.Sprintf("%s返回 %d：%s", label, e.Code, e.Msg)
	if e.Auth {
		msg += "（令牌失效或没有权限，到「设置 / 连接器」里更新" + label + "的凭证）"
	}
	return msg
}

// channelErr 是不是要把连接器置为异常的错误。
func channelErr(err error) bool {
	var pe *PlatformError
	return errors.As(err, &pe) && pe.Channel
}
