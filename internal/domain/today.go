package domain

import "time"

// 今日聚合的内核卡片。插件卡片（TODAY-01b）用插件自己声明的 key，不和这几个撞。
const (
	TodayCardReview   = "review"    // 等确认：待验收的任务
	TodayCardOverdue  = "overdue"   // 逾期，口径同 Counts.Overdue
	TodayCardDueToday = "due_today" // 今天到期，口径同 Counts.Today
	TodayCardRunning  = "running"   // 运行中的执行
)

// TaskStatusReview 是待办类型的「待验收」状态（0013 加的，非终态）。
const TaskStatusReview = "review"

// TodayCardLimit 是每张卡片最多带的条数。Total 是全量条数，不受它限制。
const TodayCardLimit = 50

// Today 是 GET /api/today 的返回：今日页一次请求拿全的卡片列表，按 Order 排好。
type Today struct {
	Cards []*TodayCard `json:"cards"`
}

// TodayCard 是今日页上的一块。
//
// Items 的形状由 Key 决定：review / overdue / due_today 是 []*Object，
// running 是 []*TodayRun。插件卡片的 Items 是插件 Load 返回的数据。
type TodayCard struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	Order int    `json:"order"`
	// Total 是全量条数；Items 最多 TodayCardLimit 条。
	Total int `json:"total"`
	Items any `json:"items"`
}

// TodayRun 是一条未结束的执行，带上所属对象的摘要，今日页不用再回查对象。
// 不带 output：运行中的输出可能很大，看过程走执行详情。
type TodayRun struct {
	ID          string    `json:"id"`
	ObjectID    string    `json:"object_id"`
	ObjectRef   string    `json:"object_ref"`
	ObjectTitle string    `json:"object_title"`
	ObjectType  string    `json:"object_type"`
	Workdir     string    `json:"workdir"`
	Status      string    `json:"status"`
	StartedAt   time.Time `json:"started_at"`
}
