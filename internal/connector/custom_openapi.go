// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

// 自定义 OpenAPI 接口（CONN-04，原型 custom_openapi）：用户给 OpenAPI 文档（地址或粘贴原文）、接口地址和认证。
// 每个带 operationId 的接口是一个工具，GET、HEAD 只读，其余是写；调用时按参数位置（path、query、header）拼请求，
// 请求体放在参数 body 里按 JSON 发。只支持 OpenAPI 3.x 的 JSON 和 YAML；参数只解本文档里 #/components 的 $ref。
// 文档不缓存：测试、拉清单、每次调用都重新读一遍，改了文档立刻生效。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// CustomOpenAPITool 是自定义 OpenAPI 接口的 key，同原型 custom_openapi。
const CustomOpenAPITool = "custom_openapi"

// oaMethods 是 OpenAPI 路径项里的方法，按这个顺序列工具。
var oaMethods = []string{"get", "head", "post", "put", "patch", "delete", "options", "trace"}

// CustomOpenAPI 是自定义 OpenAPI 接口的定义。
func CustomOpenAPI() Def {
	fields := append([]Field{
		{Key: "spec_url", Label: "OpenAPI 文档地址", Kind: "text", Placeholder: "https://api.example.com/openapi.json"},
		{Key: "spec_text", Label: "或粘贴文档", Kind: "text", Placeholder: "OpenAPI 3.x 的 JSON 或 YAML；填了就不用文档地址", Long: true},
		{Key: "base_url", Label: "接口地址", Kind: "text", Placeholder: "留空用文档里的 servers"},
	}, customAuthFields(true)...)
	return Def{
		Tool: CustomOpenAPITool, Label: "OpenAPI 接口", Category: "custom", Color: "#e8590c",
		Desc: "给一份 OpenAPI 文档，每个接口变成一个工具", Auth: []AuthMode{AuthNone, AuthToken, AuthOAuth2},
		Fields: fields, OAuth: customOAuth(),
		CheckConfig: func(v map[string]string) error {
			if v["spec_url"] == "" && v["spec_text"] == "" {
				return errors.New("OpenAPI 文档地址和粘贴文档至少填一个")
			}
			return checkOptionalURLs(v, map[string]string{"spec_url": "OpenAPI 文档地址", "base_url": "接口地址",
				fieldOAuthAuthURL: "授权地址", fieldOAuthToken: "令牌地址"})
		},
		Test: func(ctx context.Context, cfg Config) (string, error) {
			doc, err := loadOpenAPI(ctx, cfg)
			if err != nil {
				return "", err
			}
			if _, err := doc.baseURL(cfg); err != nil {
				return "", err
			}
			return strings.TrimSpace(doc.Info.Title + " " + doc.Info.Version), nil
		},
		ListTools: func(ctx context.Context, cfg Config) ([]ToolDef, error) {
			doc, err := loadOpenAPI(ctx, cfg)
			if err != nil {
				return nil, err
			}
			ops := doc.operations()
			if len(ops) > maxCustomTools {
				return nil, fmt.Errorf("接口超过 %d 个，暂不支持", maxCustomTools)
			}
			out := make([]ToolDef, 0, len(ops))
			for _, op := range ops {
				out = append(out, op.toolDef())
			}
			return out, nil
		},
		Call: func(ctx context.Context, cfg Config, tool string, args json.RawMessage) (string, error) {
			doc, err := loadOpenAPI(ctx, cfg)
			if err != nil {
				return "", err
			}
			ops := doc.operations()
			i := slices.IndexFunc(ops, func(o oaOperation) bool { return o.ID == tool })
			if i < 0 {
				return "", errNoTool
			}
			return doc.call(ctx, cfg, ops[i], args)
		},
	}
}

// --- 文档 ---

type oaServer struct {
	URL       string `json:"url"`
	Variables map[string]struct {
		Default string `json:"default"`
	} `json:"variables"`
}

type oaParam struct {
	Ref         string          `json:"$ref"`
	Name        string          `json:"name"`
	In          string          `json:"in"`
	Required    bool            `json:"required"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
}

type oaBody struct {
	Ref         string `json:"$ref"`
	Required    bool   `json:"required"`
	Description string `json:"description"`
	Content     map[string]struct {
		Schema json.RawMessage `json:"schema"`
	} `json:"content"`
}

type oaOp struct {
	OperationID string    `json:"operationId"`
	Summary     string    `json:"summary"`
	Description string    `json:"description"`
	Parameters  []oaParam `json:"parameters"`
	RequestBody *oaBody   `json:"requestBody"`
}

type oaDoc struct {
	OpenAPI string `json:"openapi"`
	Info    struct {
		Title   string `json:"title"`
		Version string `json:"version"`
	} `json:"info"`
	Servers    []oaServer                            `json:"servers"`
	Paths      map[string]map[string]json.RawMessage `json:"paths"`
	Components struct {
		Parameters    map[string]oaParam `json:"parameters"`
		RequestBodies map[string]oaBody  `json:"requestBodies"`
	} `json:"components"`
	// specURL 是文档从哪读的，servers 是相对地址时按它补全；粘贴的为 nil
	specURL *url.URL
}

// oaOperation 是一个能调的接口：路径级和接口级的参数已合并，$ref 已解开。
type oaOperation struct {
	ID, Method, Path, Summary string
	Params                    []oaParam
	Body                      *oaBody
}

// loadOpenAPI 读文档：粘贴的优先，否则从文档地址取。
func loadOpenAPI(ctx context.Context, cfg Config) (*oaDoc, error) {
	raw := []byte(cfg.Get("spec_text"))
	var specURL *url.URL
	if len(raw) == 0 {
		u, err := parseCustomURL("OpenAPI 文档地址", cfg.Get("spec_url"))
		if err != nil {
			return nil, err
		}
		if raw, err = fetchSpec(ctx, cfg, u); err != nil {
			return nil, err
		}
		specURL = u
	}
	doc, err := parseOpenAPI(raw)
	if err != nil {
		return nil, err
	}
	doc.specURL = specURL
	return doc, nil
}

func fetchSpec(ctx context.Context, cfg Config, u *url.URL) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, application/yaml, text/yaml, */*")
	resp, err := customClient(cfg, u).Do(req)
	if err != nil {
		return nil, fmt.Errorf("读不到 OpenAPI 文档：%w", callErr(err))
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读不到 OpenAPI 文档：%w", callErr(err))
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("读 OpenAPI 文档返回 %d：%s", resp.StatusCode, errSnippet(body))
	}
	return body, nil
}

// parseOpenAPI 解析 JSON 或 YAML 的 OpenAPI 3.x 文档。
func parseOpenAPI(raw []byte) (*oaDoc, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, errors.New("OpenAPI 文档是空的")
	}
	var js []byte
	if raw[0] == '{' {
		js = raw
	} else {
		var v any
		if err := yaml.Unmarshal(raw, &v); err != nil {
			return nil, fmt.Errorf("OpenAPI 文档不是合法的 JSON 或 YAML：%v", err)
		}
		b, err := json.Marshal(jsonable(v))
		if err != nil {
			return nil, fmt.Errorf("OpenAPI 文档转不成 JSON：%v", err)
		}
		js = b
	}
	var doc oaDoc
	if err := json.Unmarshal(js, &doc); err != nil {
		return nil, fmt.Errorf("OpenAPI 文档格式不对：%v", err)
	}
	if !strings.HasPrefix(doc.OpenAPI, "3.") {
		return nil, errors.New("只支持 OpenAPI 3.x（文档里要有 openapi: 3.x）")
	}
	return &doc, nil
}

// jsonable 把 YAML 解出来的 map[any]any（如响应码 200 作键）转成 JSON 能编码的样子。
func jsonable(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			x[k] = jsonable(e)
		}
		return x
	case map[any]any:
		m := make(map[string]any, len(x))
		for k, e := range x {
			m[fmt.Sprint(k)] = jsonable(e)
		}
		return m
	case []any:
		for i, e := range x {
			x[i] = jsonable(e)
		}
		return x
	}
	return v
}

const compParams, compBodies = "#/components/parameters/", "#/components/requestBodies/"

func (d *oaDoc) param(p oaParam) (oaParam, bool) {
	if p.Ref == "" {
		return p, p.Name != "" && p.In != ""
	}
	name, ok := strings.CutPrefix(p.Ref, compParams)
	q, found := d.Components.Parameters[name]
	if !ok || !found || q.Ref != "" {
		return oaParam{}, false
	}
	return q, q.Name != "" && q.In != ""
}

func (d *oaDoc) body(b *oaBody) *oaBody {
	if b == nil || b.Ref == "" {
		return b
	}
	name, ok := strings.CutPrefix(b.Ref, compBodies)
	q, found := d.Components.RequestBodies[name]
	if !ok || !found || q.Ref != "" {
		return nil
	}
	return &q
}

// operations 是带 operationId 的接口，按路径、方法排序；operationId 重复的只留第一个。
func (d *oaDoc) operations() []oaOperation {
	paths := make([]string, 0, len(d.Paths))
	for p := range d.Paths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	var out []oaOperation
	seen := map[string]bool{}
	for _, p := range paths {
		item := d.Paths[p]
		var common []oaParam
		if raw, ok := item["parameters"]; ok {
			_ = json.Unmarshal(raw, &common)
		}
		for _, m := range oaMethods {
			raw, ok := item[m]
			if !ok {
				continue
			}
			var op oaOp
			if json.Unmarshal(raw, &op) != nil || op.OperationID == "" || seen[op.OperationID] {
				continue
			}
			seen[op.OperationID] = true
			o := oaOperation{ID: op.OperationID, Method: strings.ToUpper(m), Path: p, Body: d.body(op.RequestBody),
				Summary: op.Summary}
			if o.Summary == "" {
				o.Summary = op.Description
			}
			// 接口级的参数覆盖路径级同名同位置的
			for _, raw := range append(slices.Clone(common), op.Parameters...) {
				q, ok := d.param(raw)
				if !ok {
					continue
				}
				o.Params = slices.DeleteFunc(o.Params, func(x oaParam) bool { return x.Name == q.Name && x.In == q.In })
				o.Params = append(o.Params, q)
			}
			out = append(out, o)
		}
	}
	return out
}

var serverVarRe = regexp.MustCompile(`\{([^{}]+)\}`)

// baseURL 是接口地址：填了的优先，否则取文档 servers 的第一个（变量用默认值，相对地址按文档地址补全）。
func (d *oaDoc) baseURL(cfg Config) (*url.URL, error) {
	if v := cfg.Get("base_url"); v != "" {
		return parseCustomURL("接口地址", v)
	}
	if len(d.Servers) == 0 || d.Servers[0].URL == "" {
		return nil, errors.New("文档里没有 servers，请填接口地址")
	}
	s := d.Servers[0]
	raw := serverVarRe.ReplaceAllStringFunc(s.URL, func(m string) string {
		return s.Variables[m[1:len(m)-1]].Default
	})
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("文档里的 servers 地址不对：%v", err)
	}
	if !u.IsAbs() {
		if d.specURL == nil {
			return nil, errors.New("文档里的 servers 是相对地址，请填接口地址")
		}
		u = d.specURL.ResolveReference(u)
	}
	return parseCustomURL("文档里的 servers 地址", u.String())
}

// --- 工具 ---

func (o oaOperation) write() bool { return o.Method != http.MethodGet && o.Method != http.MethodHead }

// toolDef 是给连接器的工具：说明写方法和路径，参数 Schema 按参数拼。
func (o oaOperation) toolDef() ToolDef {
	desc := o.Method + " " + o.Path
	if s := strings.TrimSpace(o.Summary); s != "" {
		desc = s + "（" + desc + "）"
	}
	props := map[string]any{}
	required := []string{}
	for _, p := range o.Params {
		if p.In == "cookie" {
			continue
		}
		props[p.Name] = paramSchema(p.Schema, strings.TrimSpace(p.Description+"（"+p.In+" 参数）"))
		if p.Required || p.In == "path" {
			required = append(required, p.Name)
		}
	}
	if o.Body != nil {
		var schema json.RawMessage
		for ct, c := range o.Body.Content {
			if strings.Contains(ct, "json") {
				schema = c.Schema
				break
			}
		}
		props["body"] = paramSchema(schema, strings.TrimSpace(o.Body.Description+"（请求体，按 JSON 发）"))
		if o.Body.Required {
			required = append(required, "body")
		}
	}
	sort.Strings(required)
	schema := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	return ToolDef{Name: o.ID, Desc: clipRunes(desc, 500), Write: o.write(), Schema: schemaJSON(schema)}
}

// paramSchema 用文档给的 Schema；带 $ref 的不展开，只说是什么。
func paramSchema(raw json.RawMessage, desc string) map[string]any {
	out := map[string]any{}
	if len(raw) > 0 && !bytes.Contains(raw, []byte(`"$ref"`)) {
		_ = json.Unmarshal(raw, &out)
	}
	if desc != "" {
		out["description"] = desc
	}
	return out
}

// argString 把一个参数值写成请求里的文本：字符串原样，别的按 JSON。
func argString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// call 按参数位置拼请求发出去，回「HTTP 状态码」加回应体；非 2xx 是错误。
func (d *oaDoc) call(ctx context.Context, cfg Config, o oaOperation, raw json.RawMessage) (string, error) {
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil || args == nil {
		return "", errors.New("参数要是一个 JSON 对象")
	}
	base, err := d.baseURL(cfg)
	if err != nil {
		return "", err
	}
	path := o.Path
	q := url.Values{}
	headers := http.Header{}
	for _, p := range o.Params {
		v, ok := args[p.Name]
		if !ok || v == nil {
			if p.Required || p.In == "path" {
				return "", fmt.Errorf("缺少参数 %s（%s）", p.Name, p.In)
			}
			continue
		}
		switch p.In {
		case "path":
			path = strings.ReplaceAll(path, "{"+p.Name+"}", url.PathEscape(argString(v)))
		case "query":
			if list, isList := v.([]any); isList {
				for _, e := range list {
					q.Add(p.Name, argString(e))
				}
			} else {
				q.Set(p.Name, argString(v))
			}
		case "header":
			headers.Set(p.Name, argString(v))
		}
	}
	// path 里的参数已经转义过：同时给 Path 和 RawPath，免得 % 再被转义一次
	u := *base
	u.RawPath = strings.TrimRight(base.EscapedPath(), "/") + path
	if u.Path, err = url.PathUnescape(u.RawPath); err != nil {
		return "", fmt.Errorf("接口路径不对：%v", err)
	}
	if len(q) > 0 {
		u.RawQuery = q.Encode()
	}
	var body io.Reader
	if b, ok := args["body"]; ok && o.Body != nil {
		js, err := json.Marshal(b)
		if err != nil {
			return "", fmt.Errorf("请求体编不成 JSON：%v", err)
		}
		body = bytes.NewReader(js)
	} else if o.Body != nil && o.Body.Required {
		return "", errors.New("缺少参数 body（请求体）")
	}
	req, err := http.NewRequestWithContext(ctx, o.Method, u.String(), body)
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req.Header[k] = v
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json, */*")
	resp, err := customClient(cfg, base).Do(req)
	if err != nil {
		return "", fmt.Errorf("请求失败：%w", callErr(err))
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("读回应失败：%w", callErr(err))
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("接口返回 %d：%s", resp.StatusCode, errSnippet(out))
	}
	if len(bytes.TrimSpace(out)) == 0 {
		return fmt.Sprintf("HTTP %d（没有内容）", resp.StatusCode), nil
	}
	return clipText(fmt.Sprintf("HTTP %d\n%s", resp.StatusCode, out)), nil
}
