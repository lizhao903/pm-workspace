// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"testing"
)

func TestGrantRevokeHighRiskPermission(t *testing.T) {
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["permissions"] = []any{"objects:read", "notify", "fs:write:any"}
	obj["permissions_reason"] = map[string]any{
		"objects:read": "读取对象标题",
		"notify":       "发通知",
		"fs:write:any": "按用户选择导出文件",
	}
	dir := t.TempDir()
	writeTestPackage(t, dir, obj)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"}); err != nil {
		t.Fatalf("安装失败：%v", err)
	}
	info, err := h.Get("hello_world")
	if err != nil {
		t.Fatal(err)
	}
	if containsString(info.Granted, "fs:write:any") {
		t.Fatal("高风险权限不该随安装授予")
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("进程没起来")
	}
	if rerr := p.requirePermission("fs:write:any"); rerr == nil {
		t.Fatal("未授予时 broker 应拒绝 fs:write:any")
	}
	granted, err := h.Grant(ctx, "hello_world", "fs:write:any")
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if !containsString(granted.Granted, "fs:write:any") {
		t.Fatalf("授予后 Info.Granted 不含：%v", granted.Granted)
	}
	if rerr := p.requirePermission("fs:write:any"); rerr != nil {
		t.Fatalf("授予后 broker 应放行：%v", rerr)
	}
	if _, err := h.Revoke(ctx, "hello_world", "fs:write:any"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if rerr := p.requirePermission("fs:write:any"); rerr == nil {
		t.Fatal("收回后 broker 应拒绝")
	}
	// 已收回再收回幂等；trade:live 一律拒绝。
	if _, err := h.Revoke(ctx, "hello_world", "fs:write:any"); err != nil {
		t.Fatalf("重复收回应幂等：%v", err)
	}
	if _, err := h.Grant(ctx, "hello_world", "trade:live"); err == nil {
		t.Fatal("trade:live 不应能授予")
	}
	// 普通权限不在单独申请范围。
	if _, err := h.Grant(ctx, "hello_world", "notify"); err == nil {
		t.Fatal("普通权限不该走 Grant")
	}
}
