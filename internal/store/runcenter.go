// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package store

import "github.com/lizhao903/pm-workspace/internal/domain"

// --- 统一运行中心（P0-O1） ---
//
// 运行中心把两类执行摆在同一张表里：Agent 触发执行（agent_runs，kind=agent）和
// 把工作对象交给执行器的执行（task_runs，kind=task）。SOP 执行不在这里——它有自己的
// 页面和运行记录，混进来只会让「一页看完正在跑什么」变成三套状态机。
//
// 这个类型只给 task_runs 一侧用：执行记录本身在 domain.TaskRun，归属对象的 ref/title
// 由查询 join 出来。Agent 侧直接用 AgentRun，没有额外的展示字段要补。

// RunCenterTaskRun 是运行中心里的一条 task 执行，连同归属对象的编号和标题。
// ObjectRef / ObjectTitle 在对象缺失时为空串（objects 表是 LEFT JOIN，历史记录不该因此消失）。
type RunCenterTaskRun struct {
	Run         *domain.TaskRun
	ObjectRef   string
	ObjectTitle string
}
