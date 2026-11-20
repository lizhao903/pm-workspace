// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 插件交给 Claude Code 的运行（SOP 的 Claude Code 节点）放开写时用全局写入档位（TSK-0499）：
// 自动审核、自定义白名单照用；不放开写是只读档；硬拦截每一档都传（内置按本实例生成 + 自定义），设置读不出来也照传内置的。
func TestRunPermsFor(t *testing.T) {
	r := NewRegistry(NewMemStateStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.DataDir = "/srv/pmw/data-dev"
	box := claudeBox{apiURL: "http://127.0.0.1:7899"}

	perm, allowed, deny := r.runPermsFor(context.Background(), box, true)
	if perm != runner.PermAcceptEdits || !slices.Contains(allowed, "Bash(git status:*)") || !slices.Contains(deny, "Bash(git push * main)") ||
		!slices.Contains(deny, "Edit(//srv/pmw/data-dev/**)") || !slices.Contains(deny, "Bash(curl *127.0.0.1:7899/api/admin*)") {
		t.Fatalf("没接设置：%s %v %v", perm, allowed, deny)
	}

	box.perms = func(context.Context) (RunPerms, error) {
		return RunPerms{WriteProfile: runner.PermAuto, Custom: []string{"Bash(git commit:*)"}, Deny: []string{"Bash(git -C /p/web-next push:*)"}}, nil
	}
	perm, allowed, deny = r.runPermsFor(context.Background(), box, true)
	if perm != runner.PermAuto || !slices.Contains(allowed, "Bash(git commit:*)") || deny[len(deny)-1] != "Bash(git -C /p/web-next push:*)" {
		t.Fatalf("auto：%s %v %v", perm, allowed, deny)
	}
	perm, allowed, deny = r.runPermsFor(context.Background(), box, false)
	if perm != runner.PermReadOnly || slices.Contains(allowed, "Bash(git commit:*)") || !slices.Contains(deny, "Bash(git -C /p/web-next push:*)") {
		t.Fatalf("只读：%s %v %v", perm, allowed, deny)
	}

	box.perms = func(context.Context) (RunPerms, error) { return RunPerms{WriteProfile: runner.PermCustom}, nil }
	if perm, _, _ = r.runPermsFor(context.Background(), box, true); perm != runner.PermCustom {
		t.Fatalf("custom 也照用：%s", perm)
	}
	box.perms = func(context.Context) (RunPerms, error) { return RunPerms{WriteProfile: "read_only"}, nil }
	if perm, _, _ = r.runPermsFor(context.Background(), box, true); perm != runner.PermAcceptEdits {
		t.Fatalf("写入档位不能是只读：%s", perm)
	}
	box.perms = func(context.Context) (RunPerms, error) { return RunPerms{}, errors.New("db locked") }
	if perm, _, deny = r.runPermsFor(context.Background(), box, true); perm != runner.PermAcceptEdits || !slices.Contains(deny, "Bash(rm -rf*)") {
		t.Fatalf("设置读不出来：%s %v", perm, deny)
	}
}
