// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 插件凭证（docs/plugin-spec-v2.md 7.x host.secrets.get / set / delete）：
// 存进内核凭证保险箱（加密落库，主密钥同 vault.key / 钥匙串），名字固定为 plugin:<插件 id>:<scope>、
// 类型 plugin_secret，所以插件之间互相看不到，用户在「设置 → 凭证」里也能看到、删掉。
// 只有清单声明并且用户授予了 secrets:<scope> 的插件能碰这个 scope；宿主没接保险箱时回 unavailable。
// 2026-11-23 补：此前 broker 没实现这三个方法，插件调用一律「宿主未实现方法」。

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/vault"
)

// SecretStore 是宿主需要的保险箱能力（*vault.Vault 满足）。
type SecretStore interface {
	List(ctx context.Context) ([]vault.Secret, error)
	Create(ctx context.Context, name, kind, value string) (*vault.Secret, error)
	Rotate(ctx context.Context, id, value string) (*vault.Secret, error)
	Delete(ctx context.Context, id string) error
	Resolve(ctx context.Context, id string) (string, error)
}

const (
	pluginSecretKind     = "plugin_secret"
	pluginSecretMaxBytes = 16 << 10
)

var secretScopeRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

func pluginSecretName(pluginID, scope string) string {
	return "plugin:" + pluginID + ":" + scope
}

// secretScope 解析参数里的 scope 并检查 secrets:<scope> 权限。
func (p *pluginProcess) secretScope(method string, params json.RawMessage, out any) (string, *rpcError) {
	if p.host == nil || p.host.opts.Secrets == nil {
		return "", rpcErrorf("unavailable", "宿主没有接凭证保险箱，%s 不可用", method)
	}
	if err := json.Unmarshal(params, out); err != nil {
		return "", rpcErrorf("invalid_params", "%s 参数不合法：%v", method, err)
	}
	var probe struct {
		Scope string `json:"scope"`
	}
	_ = json.Unmarshal(params, &probe)
	scope := strings.TrimSpace(probe.Scope)
	if !secretScopeRe.MatchString(scope) {
		return "", rpcErrorf("invalid_params", "%s 需要 scope（小写字母、数字、_ . -，最多 64 个字符）", method)
	}
	if rerr := p.requirePermission("secrets:" + scope); rerr != nil {
		return "", rerr
	}
	return scope, nil
}

// findSecret 按名字找这个插件这个 scope 的那一条；没有回 nil。
func (p *pluginProcess) findSecret(ctx context.Context, scope string) (*vault.Secret, error) {
	list, err := p.host.opts.Secrets.List(ctx)
	if err != nil {
		return nil, err
	}
	name := pluginSecretName(p.id, scope)
	for i := range list {
		if list[i].Kind == pluginSecretKind && list[i].Name == name {
			return &list[i], nil
		}
	}
	return nil, nil
}

func (p *pluginProcess) secretsGet(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct{}
	scope, rerr := p.secretScope("host.secrets.get", params, &in)
	if rerr != nil {
		return nil, rerr
	}
	s, err := p.findSecret(ctx, scope)
	if err != nil {
		return nil, rpcErrorf("internal", "读取凭证失败：%v", err)
	}
	if s == nil {
		return map[string]any{"value": ""}, nil
	}
	value, err := p.host.opts.Secrets.Resolve(ctx, s.ID)
	if err != nil {
		return nil, rpcErrorf("internal", "解密凭证失败（主密钥换过？）：%v", err)
	}
	return map[string]any{"value": value}, nil
}

func (p *pluginProcess) secretsSet(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Value *string `json:"value"`
	}
	scope, rerr := p.secretScope("host.secrets.set", params, &in)
	if rerr != nil {
		return nil, rerr
	}
	value := ""
	if in.Value != nil {
		value = *in.Value
	}
	// 空值等于删除，插件「退出登录」不用另调 delete
	if strings.TrimSpace(value) == "" {
		return p.deleteSecret(ctx, scope)
	}
	if len(value) > pluginSecretMaxBytes {
		return nil, rpcErrorf("validation", "凭证超过 %d 字节", pluginSecretMaxBytes)
	}
	s, err := p.findSecret(ctx, scope)
	if err != nil {
		return nil, rpcErrorf("internal", "读取凭证失败：%v", err)
	}
	if s == nil {
		_, err = p.host.opts.Secrets.Create(ctx, pluginSecretName(p.id, scope), pluginSecretKind, value)
	} else {
		_, err = p.host.opts.Secrets.Rotate(ctx, s.ID, value)
	}
	if err != nil {
		return nil, rpcErrorf("internal", "保存凭证失败：%v", err)
	}
	return map[string]any{"ok": true}, nil
}

func (p *pluginProcess) secretsDelete(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct{}
	scope, rerr := p.secretScope("host.secrets.delete", params, &in)
	if rerr != nil {
		return nil, rerr
	}
	return p.deleteSecret(ctx, scope)
}

func (p *pluginProcess) deleteSecret(ctx context.Context, scope string) (any, error) {
	s, err := p.findSecret(ctx, scope)
	if err != nil {
		return nil, rpcErrorf("internal", "读取凭证失败：%v", err)
	}
	if s != nil {
		if err := p.host.opts.Secrets.Delete(ctx, s.ID); err != nil {
			return nil, rpcErrorf("internal", "删除凭证失败：%v", err)
		}
	}
	return map[string]any{"ok": true}, nil
}
