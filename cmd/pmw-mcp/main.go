// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Command pmw-mcp 把产品工作台暴露成一个 MCP server，让 Claude Code 之类的
// Agent 能直接查需求、建任务、搜文档、看最近变更。
//
// 它是个瘦客户端：所有操作都打工作台的 HTTP API（默认 http://127.0.0.1:7777），
// 不直接开 SQLite。原因有两条——校验规则（类型状态集、分类与类型同源、字典枚举）
// 都长在 store 层，绕过 API 就全部失效；工作台本身常驻运行，两个进程同时写
// 同一个 SQLite 文件也不安全。
//
// 传输用 stdio：stdout 是 JSON-RPC 协议通道，任何调试输出都必须走 stderr，
// 往 stdout 打一行字就会把协议流搞坏。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// version 可通过 -ldflags "-X main.version=..." 覆盖。
var version = "0.1.0"

const defaultAPIBase = "http://127.0.0.1:7777"

// instructions 是握手时发给客户端的总体说明，补充单个工具描述讲不到的全局约定。
const instructions = `这是「产品工作台」——一个跑在本机的个人产品管理工具，统一管需求、任务、项目、文档、资源和笔记。

几条通用约定：

1. 状态、类型、优先级、关联关系传的都是 key 不是中文标签，而且状态集是按类型隔离的（需求的 doing 和任务的 doing 是两套）。拿不准就先调 pmw_list_types，不要猜。
2. 对象 id 形如 obj_0abc…，REQ-0001 这类是给人看的 ref。多数工具两种都认，但 id 更可靠。
3. pmw_search / pmw_get_object / pmw_list_types / pmw_list_categories / pmw_list_stakeholders / pmw_recent_changes / pmw_counts / pmw_list_artifacts / pmw_next_task / pmw_list_runs / pmw_get_run / pmw_list_project_profiles 是只读的；pmw_create_object / pmw_update_object / pmw_link_objects / pmw_record_artifact / pmw_claim_task / pmw_append_progress / pmw_submit_review / pmw_create_subtasks / pmw_finish_run 会真的写进用户的数据库，动手前先确认清楚要改的是哪一条。
4. pmw_update_object 的 body 和 tags 是整体替换不是追加，要增补先读回来再拼完整内容。
5. 这些工具依赖工作台进程处于运行状态。如果返回「工作台未运行」，把提示里的启动命令转达给用户，不要反复重试。
6. 做开发任务走固定流程：pmw_get_object 读任务和验收标准 → pmw_claim_task 领取 → 在工作目录里改代码、跑测试，期间多次 pmw_append_progress → pmw_record_artifact 登记 commit / branch / pr → pmw_submit_review 提交验收。不要自己把任务改成已完成，完成与否由用户验收决定。`

func main() {
	api := flag.String("api", defaultAPIBase, "产品工作台 HTTP API 地址，也可用环境变量 PMW_API 指定")
	actor := flag.String("actor", "", "写入时记在变更记录里的操作者名；留空时在 Claude Code 里是 claude-code，否则是 mcp-agent")
	owner := flag.String("agent-owner", defaultAgentOwner, "pmw_claim_task 领任务时写进负责人的干系人名字")
	showVersion := flag.Bool("version", false, "打印版本后退出")
	flag.Parse()

	if *showVersion {
		fmt.Fprintf(os.Stderr, "pmw-mcp %s\n", version)
		return
	}

	base := strings.TrimSpace(*api)
	// 命令行没显式给就看环境变量，两者都没有才回落默认值。
	if base == defaultAPIBase {
		if v := strings.TrimSpace(os.Getenv("PMW_API")); v != "" {
			base = v
		}
	}
	if base == "" {
		base = defaultAPIBase
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	srv := mcp.NewServer(&mcp.Implementation{
		Name:        "pm-workspace",
		Title:       "产品工作台",
		Description: "本机产品工作台：需求、任务、项目、文档的检索与维护",
		Version:     version,
	}, &mcp.ServerOptions{Instructions: instructions})

	c := newClient(base)
	c.actor = resolveActor(*actor)
	c.session = resolveSession()
	if v := strings.TrimSpace(*owner); v != "" {
		c.agentOwner = v
	}
	registerTools(srv, c)

	// 启动横幅走 stderr。stdout 归 JSON-RPC 独占。
	fmt.Fprintf(os.Stderr, "pmw-mcp %s 已就绪，工作台 API = %s，actor = %s，session = %s\n",
		version, base, c.actor, c.session)

	if err := srv.Run(ctx, &mcp.StdioTransport{}); err != nil {
		if ctx.Err() != nil {
			return // 收到信号后正常退出。
		}
		fmt.Fprintf(os.Stderr, "pmw-mcp 异常退出: %v\n", err)
		os.Exit(1)
	}
}
