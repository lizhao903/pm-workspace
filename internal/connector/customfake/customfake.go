// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package customfake 是测试用的假 MCP 服务和假 OpenAPI 服务（CONN-04），配合自定义连接器 custom_mcp、custom_openapi。
// 只给测试用，不进正式路由；都跑在本机 httptest 上，不联网。
package customfake

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCP 是一个跑着的假 MCP 服务：/mcp 是 Streamable HTTP，/sse 是 SSE。Token 非空时要带 Authorization: Bearer <Token>。
// 工具：search（只读标注）、get_note（没有标注，算写）、delete_note（写）。
type MCP struct {
	*httptest.Server
	Token string
	// Calls 是 tools/call 的次数
	Calls atomic.Int64
}

// NewMCP 起一个假 MCP 服务。
func NewMCP(token string) *MCP {
	m := &MCP{Token: token}
	srv := mcp.NewServer(&mcp.Implementation{Name: "fake-mcp", Version: "0.1.0"}, nil)
	type query struct {
		Q string `json:"q" jsonschema:"关键词"`
	}
	mcp.AddTool(srv, &mcp.Tool{Name: "search", Description: "按关键词搜笔记", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}},
		func(_ context.Context, _ *mcp.CallToolRequest, in query) (*mcp.CallToolResult, any, error) {
			m.Calls.Add(1)
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "找到 1 条：" + in.Q + " 周报"}}}, nil, nil
		})
	type id struct {
		ID string `json:"id"`
	}
	mcp.AddTool(srv, &mcp.Tool{Name: "get_note", Description: "读一条笔记"},
		func(_ context.Context, _ *mcp.CallToolRequest, in id) (*mcp.CallToolResult, any, error) {
			m.Calls.Add(1)
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "笔记 " + in.ID}}}, nil, nil
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "delete_note", Description: "删一条笔记", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}},
		func(_ context.Context, _ *mcp.CallToolRequest, in id) (*mcp.CallToolResult, any, error) {
			m.Calls.Add(1)
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "不许删 " + in.ID}}}, nil, nil
		})
	get := func(*http.Request) *mcp.Server { return srv }
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(get, nil))
	mux.Handle("/sse", mcp.NewSSEHandler(get, nil))
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.invalid/mcp", http.StatusTemporaryRedirect)
	})
	m.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.Token != "" && r.Header.Get("Authorization") != "Bearer "+m.Token {
			http.Error(w, "401 Unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	return m
}

// OpenAPI 是一个跑着的假 OpenAPI 服务：/openapi.json、/openapi.yaml 是文档，/v1/... 是接口。
// APIKey 非空时接口要带查询参数 api_key=<APIKey>（文档不要）。
type OpenAPI struct {
	*httptest.Server
	APIKey string
	// Last 是最近一次接口请求的「方法 路径?查询」和请求体
	Last atomic.Value
}

// specYAML 是假文档：4 个有 operationId 的接口（2 个 GET）、1 个没有 operationId 的（不生成工具）。
const specYAML = `openapi: 3.0.3
info:
  title: 假笔记接口
  version: "1.2"
servers:
  - url: /v1
paths:
  /notes:
    get:
      operationId: listNotes
      summary: 列出笔记
      parameters:
        - $ref: '#/components/parameters/Limit'
      responses:
        200:
          description: ok
    post:
      operationId: createNote
      summary: 新建笔记
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                title: {type: string}
      responses:
        201:
          description: created
  /notes/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema: {type: string}
    get:
      operationId: getNote
      summary: 读一条笔记
      responses:
        200:
          description: ok
    delete:
      operationId: deleteNote
      responses:
        204:
          description: deleted
  /health:
    get:
      summary: 没有 operationId，不生成工具
      responses:
        200:
          description: ok
components:
  parameters:
    Limit:
      name: limit
      in: query
      schema: {type: integer}
`

// NewOpenAPI 起一个假 OpenAPI 服务。
func NewOpenAPI(apiKey string) *OpenAPI {
	o := &OpenAPI{APIKey: apiKey}
	o.Last.Store("")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /openapi.yaml", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = fmt.Fprint(w, specYAML)
	})
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		if o.APIKey != "" && r.URL.Query().Get("api_key") != o.APIKey {
			http.Error(w, `{"error":"bad api key"}`, http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		q := r.URL.Query()
		q.Del("api_key")
		line := r.Method + " " + r.URL.Path
		if len(q) > 0 {
			line += "?" + q.Encode()
		}
		if body != nil {
			b, _ := json.Marshal(body)
			line += " " + string(b)
		}
		o.Last.Store(line)
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/notes":
			_, _ = fmt.Fprint(w, `[{"id":"n1","title":"周报"}]`)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/notes/"):
			_, _ = fmt.Fprintf(w, `{"id":%q,"title":"周报"}`, strings.TrimPrefix(r.URL.Path, "/v1/notes/"))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/notes":
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"n2"}`)
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})
	o.Server = httptest.NewServer(mux)
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, SpecJSON(o.URL+"/v1"))
	})
	return o
}

// SpecYAML 是假文档的 YAML 原文（servers 是相对地址 /v1），粘贴文档的测试用。
func SpecYAML() string { return specYAML }

// SpecJSON 是同一份文档的 JSON，servers 写成 server 的绝对地址。
func SpecJSON(server string) string {
	return `{"openapi":"3.1.0","info":{"title":"假笔记接口","version":"1.2"},"servers":[{"url":"` + server + `"}],
"paths":{"/notes":{"get":{"operationId":"listNotes","summary":"列出笔记","parameters":[{"name":"limit","in":"query","schema":{"type":"integer"}}]},
"post":{"operationId":"createNote","summary":"新建笔记","requestBody":{"required":true,"content":{"application/json":{"schema":{"type":"object"}}}}}},
"/notes/{id}":{"parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],
"get":{"operationId":"getNote","summary":"读一条笔记"},"delete":{"operationId":"deleteNote"}},
"/health":{"get":{"summary":"没有 operationId"}}}}`
}
