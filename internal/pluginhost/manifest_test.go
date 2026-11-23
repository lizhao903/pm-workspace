// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// validManifest 返回一份当前平台可用的合法清单 JSON（用于测试各类非法改动）。
func validManifest(t *testing.T) map[string]any {
	t.Helper()
	raw := `{
		"manifest_version": 2,
		"id": "hello_world",
		"name": "Hello World",
		"description": "示例插件",
		"version": "0.1.0",
		"api": ">=2.0.0 <3.0.0",
		"pmw": ">=0.3.0 <1.0.0",
		"license": "MIT",
		"homepage": "https://github.com/example/hello_world",
		"repository": "https://github.com/example/hello_world",
		"publisher": {"id": "github:example"},
		"icon": "assets/icon.svg",
		"provides": {
			"modules": ["hello_world"],
			"settings": ["hello_world"],
			"today_cards": ["hello_world_tip"],
			"commands": ["hello_world.say_hi"]
		},
		"permissions": ["objects:read", "notify"],
		"permissions_reason": {
			"objects:read": "在模块页展示最近对象标题，作为只读示例",
			"notify": "点按钮时发一条演示通知"
		},
		"runtime": {
			"backend": {
				"kind": "process",
				"protocol": "pmw-plugin-rpc/1",
				"entry": {"` + platformKey() + `": "bin/hello_world"},
				"health_timeout_ms": 10000
			},
			"web": {"entry": "web/entry.js", "styles": ["web/style.css"]}
		}
	}`
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("测试清单不是合法 JSON：%v", err)
	}
	return m
}

func marshalManifest(t *testing.T, m map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("序列化测试清单失败：%v", err)
	}
	return data
}

func TestParseValidManifest(t *testing.T) {
	data := marshalManifest(t, validManifest(t))
	m, err := Parse(data)
	if err != nil {
		t.Fatalf("合法清单被拒绝：%v", err)
	}
	if m.ID != "hello_world" || m.Version != "0.1.0" || m.ManifestVersion != 2 {
		t.Fatalf("解析结果不对：%+v", m)
	}
	if m.Runtime.Backend == nil || m.Runtime.Backend.Entry[platformKey()] != "bin/hello_world" {
		t.Fatalf("runtime.backend 解析不对：%+v", m.Runtime.Backend)
	}
	if m.Runtime.Backend.HealthTimeout() != 10*time.Second {
		t.Fatalf("health timeout 不对：%v", m.Runtime.Backend.HealthTimeout())
	}
	if m.PermissionsReason["objects:read"] == "" {
		t.Fatal("permissions_reason 丢失")
	}
	if err := CheckCompatibility(m, "0.3.0"); err != nil {
		t.Fatalf("兼容检查应通过：%v", err)
	}
}

// TestParseHelloWorldExample 用 plugin-sdk 里的真实示例清单做回归。
func TestParseHelloWorldExample(t *testing.T) {
	data, err := os.ReadFile("../../plugin-sdk/examples/hello-world/plugin.json")
	if err != nil {
		t.Skipf("示例清单不可读（跳过）：%v", err)
	}
	if _, err := Parse(data); err != nil {
		t.Fatalf("hello-world 示例清单被拒绝：%v", err)
	}
}

func TestParseInvalidManifest(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(m map[string]any)
		want   string // 期望错误信息里出现的关键字
	}{
		{"manifest_version 缺失", func(m map[string]any) { delete(m, "manifest_version") }, "manifest_version"},
		{"manifest_version 不是 2", func(m map[string]any) { m["manifest_version"] = 1 }, "manifest_version"},
		{"id 是保留字", func(m map[string]any) { m["id"] = "objects" }, "保留字"},
		{"id 与内置插件冲突", func(m map[string]any) { m["id"] = "projects" }, "内置插件"},
		{"id 不合法", func(m map[string]any) { m["id"] = "Bad-ID" }, "id"},
		{"version 不合法", func(m map[string]any) { m["version"] = "1.0" }, "version"},
		{"api 范围不合法", func(m map[string]any) { m["api"] = ">=2.0.0 || <3.0.0" }, "api"},
		{"pmw 范围不合法", func(m map[string]any) { m["pmw"] = "latest" }, "pmw"},
		{"license 为空", func(m map[string]any) { m["license"] = "" }, "license"},
		{"repository 不是 github", func(m map[string]any) { m["repository"] = "https://gitlab.com/a/b" }, "repository"},
		{"禁止字段 core", func(m map[string]any) { m["core"] = ">=1 <2" }, "core"},
		{"禁止字段 adopts", func(m map[string]any) { m["adopts"] = map[string]any{} }, "adopts"},
		{"禁止字段 table_prefix", func(m map[string]any) { m["table_prefix"] = "x_" }, "table_prefix"},
		{"未知字段", func(m map[string]any) { m["wat"] = 1 }, "未知字段"},
		{"未知权限", func(m map[string]any) {
			m["permissions"] = []any{"root:everything"}
			m["permissions_reason"] = map[string]any{"root:everything": "全部权限"}
		}, "未知权限"},
		{"缺 permissions_reason", func(m map[string]any) {
			m["permissions"] = []any{"objects:read", "notify"}
			m["permissions_reason"] = map[string]any{"objects:read": "只读对象"}
		}, "缺少 permissions_reason"},
		{"理由不是中文", func(m map[string]any) {
			m["permissions_reason"] = map[string]any{"objects:read": "read objects", "notify": "send notification"}
		}, "中文"},
		{"理由超过 80 字", func(m map[string]any) {
			m["permissions_reason"] = map[string]any{
				"objects:read": strings.Repeat("理由", 41),
				"notify":       "发通知",
			}
		}, "1–80"},
		{"多余理由", func(m map[string]any) {
			m["permissions_reason"] = map[string]any{
				"objects:read": "只读对象",
				"notify":       "发通知",
				"secrets:foo":  "多余的",
			}
		}, "不是已声明的权限"},
		{"runtime 缺失", func(m map[string]any) { delete(m, "runtime") }, "runtime"},
		{"runtime 为空对象", func(m map[string]any) { m["runtime"] = map[string]any{} }, "至少"},
		{"backend kind 不为 process", func(m map[string]any) {
			m["runtime"].(map[string]any)["backend"].(map[string]any)["kind"] = "wasm"
		}, "kind"},
		{"backend protocol 不对", func(m map[string]any) {
			m["runtime"].(map[string]any)["backend"].(map[string]any)["protocol"] = "pmw-plugin-rpc/2"
		}, "protocol"},
		{"平台键不合法", func(m map[string]any) {
			m["runtime"].(map[string]any)["backend"].(map[string]any)["entry"] = map[string]any{"darwin-x64": "bin/x"}
		}, "平台键"},
		{"entry 路径绝对", func(m map[string]any) {
			m["runtime"].(map[string]any)["backend"].(map[string]any)["entry"] = map[string]any{platformKey(): "/usr/bin/x"}
		}, "相对路径"},
		{"有 modules 没 web", func(m map[string]any) {
			delete(m["runtime"].(map[string]any), "web")
		}, "runtime.web"},
		{"有 connectors 没 network 权限", func(m map[string]any) {
			m["provides"].(map[string]any)["connectors"] = []any{"hello_conn"}
			m["permissions"] = []any{"objects:read", "notify"}
		}, "network"},
		{"subscribes 没有 events:subscribe", func(m map[string]any) {
			m["subscribes"] = []any{"object.created"}
		}, "events:subscribe"},
		{"events:subscribe 没有订阅", func(m map[string]any) {
			m["permissions"] = []any{"objects:read", "notify", "events:subscribe"}
			m["permissions_reason"] = map[string]any{
				"objects:read": "只读对象", "notify": "发通知", "events:subscribe": "订阅事件",
			}
		}, "subscribes"},
		{"health_timeout_ms 超范围", func(m map[string]any) {
			m["runtime"].(map[string]any)["backend"].(map[string]any)["health_timeout_ms"] = 50
		}, "health_timeout_ms"},
		{"publisher.key 不合法", func(m map[string]any) {
			m["publisher"] = map[string]any{"id": "github:example", "key": "abc"}
		}, "publisher.key"},
		{"icon 路径逃逸", func(m map[string]any) { m["icon"] = "../icon.svg" }, "icon"},
		{"依赖自己", func(m map[string]any) { m["depends"] = map[string]any{"hello_world": ">=0.1.0"} }, "自己"},
		{"依赖范围不合法", func(m map[string]any) { m["depends"] = map[string]any{"other_plugin": "nope"} }, "版本范围"},
		{"emits 命名空间不是自己", func(m map[string]any) { m["emits"] = []any{"other.event"} }, "emits"},
		{"订阅未知内核事件", func(m map[string]any) {
			m["permissions"] = []any{"objects:read", "notify", "events:subscribe"}
			m["permissions_reason"] = map[string]any{
				"objects:read": "只读对象", "notify": "发通知", "events:subscribe": "订阅事件",
			}
			m["subscribes"] = []any{"object.unknown_event"}
		}, "未知的内核事件"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := validManifest(t)
			tc.mutate(m)
			data := marshalManifest(t, m)
			_, err := Parse(data)
			if err == nil {
				t.Fatalf("非法清单被接受")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("错误不是 ErrValidation：%v", err)
			}
			if len(Issues(err)) == 0 {
				t.Fatalf("错误里没有 Issues：%v", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("错误信息缺少 %q：%v", tc.want, err)
			}
		})
	}
}

func TestParseNotJSON(t *testing.T) {
	for _, raw := range []string{``, `{`, `[]`, `{"id":`} {
		if _, err := Parse([]byte(raw)); err == nil || !errors.Is(err, ErrValidation) {
			t.Fatalf("非法 JSON %q 应返回 ErrValidation，得到 %v", raw, err)
		}
	}
	if _, err := Parse([]byte(`{"manifest_version":2} extra`)); err == nil {
		t.Fatal("结尾多余内容应被拒绝")
	}
}

func TestCheckCompatibility(t *testing.T) {
	m := &Manifest{API: ">=2.0.0 <3.0.0", PMW: ">=0.3.0 <1.0.0"}
	if err := CheckCompatibility(m, "0.3.0"); err != nil {
		t.Fatalf("应兼容：%v", err)
	}
	if err := CheckCompatibility(m, "1.0.0"); !errors.Is(err, ErrValidation) {
		t.Fatalf("PMW 版本超出范围应不兼容：%v", err)
	}
	m.API = ">=1.0.0 <2.0.0"
	if err := CheckCompatibility(m, "0.3.0"); !errors.Is(err, ErrValidation) {
		t.Fatalf("API 版本不匹配应不兼容：%v", err)
	}
	// 宿主没有版本号时跳过 pmw 检查。
	m.API = ">=2.0.0 <3.0.0"
	if err := CheckCompatibility(m, ""); err != nil {
		t.Fatalf("空宿主版本应跳过 pmw 检查：%v", err)
	}
	// 开发构建的宿主版本是 dev（生产 bro.vip 就是），不是正式版本号，同样跳过 pmw 检查。
	for _, v := range []string{"dev", " dev ", "unknown"} {
		if err := CheckCompatibility(m, v); err != nil {
			t.Fatalf("宿主版本 %q 应跳过 pmw 检查：%v", v, err)
		}
	}
	// 跳过的只是 pmw，api 不兼容照样拦。
	m.API = ">=1.0.0 <2.0.0"
	if err := CheckCompatibility(m, "dev"); !errors.Is(err, ErrValidation) {
		t.Fatalf("dev 宿主遇到 API 不兼容仍应拦下：%v", err)
	}
}
