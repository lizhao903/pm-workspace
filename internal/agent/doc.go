package agent

// 关于「为什么没有用 eino」
//
// 用户最初的诉求是「基于 eino agent」，所以先做了实测评估，而不是凭印象决定。
//
// 结论：不引入，三种供应商用 net/http 手写。
//
// 评估过程（2026-09-15，在一个空模块里实跑 go get）：
//
//   - github.com/cloudwego/eino v0.9.19 本身能正常拉到，编排能力（Graph / Chain /
//     ToolsNode）也确实覆盖「模型 → 工具 → 回灌」这个循环。
//   - 但 eino 核心只有抽象，真正的模型适配在 eino-ext 里，三家要分别引入
//     components/model/{openai,ollama,gemini}。把这三个加上之后：
//       * 模块总数从本项目当前的 36 个涨到 177 个；
//       * 拖进来 google.golang.org/grpc、genproto、protobuf、google.golang.org/genai
//         （Gemini 适配走官方 SDK，而官方 SDK 走 gRPC 栈）；
//       * OpenAI 适配依赖的是一个第三方 fork（github.com/meguminnnnnnnnn/go-openai）；
//       * Ollama 适配来自 eino-contrib/ollama，又是一层独立维护的间接依赖；
//       * 顺带上调了 golang.org/x/{net,sys,crypto,exp} 与 protobuf 的版本。
//
// 代价与收益对不上。这个工作台是一个单机、单人、纯本地的工具，整个仓库此前
// 只有两个直接依赖（MCP SDK 和纯 Go 的 SQLite 驱动），刻意保持了免 CGO、可交叉编译、
// 依赖面小到可以整个读一遍的状态。而我们真正需要 eino 做的事情，摊开来看是：
//
//   1. 三个 HTTP 端点的流式解析——各 100 行上下，且它们的差异（OpenAI 的 SSE 分片
//      工具调用、Ollama 的 NDJSON + 对象型 arguments、Gemini 的 functionCall）
//      恰恰是框架抽象之后仍然要逐个处理的部分；
//   2. 一个带上限的 for 循环（见 runner.go）。
//
// 为这两件事换来 141 个新模块和一整套 gRPC 栈，是净亏损。更现实的问题是，
// 出问题时的排查路径会从「读一遍 ollama.go」变成「翻三层适配库确认它到底发了什么」——
// 对接本地 Ollama 这种边界行为不那么规范的服务，这一点代价很实在。
//
// 手写的另一个好处是密钥出口可控：Gemini 把 key 放在 query 上，
// 上游报错时经常把整个 URL 回显出来。自己写请求，就能保证任何往上抛的 error
// 都是归类后的说法，不会夹带原始 URL（见 chat.go 的 upstreamError / transportError）。
// 换成第三方 SDK，这条路径要逐个库去确认，而且每次升级都得重新确认一遍。
//
// 什么情况下值得回头再看 eino：如果以后要做多 Agent 协作、带分支和回溯的复杂编排、
// 或者需要把执行图可视化出来，那时自己维护一套编排的成本会超过引入框架的成本。
// 就目前「记待办、写文档」这个范围，一个 for 循环是更诚实的实现。
