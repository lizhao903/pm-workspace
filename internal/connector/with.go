// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"context"
	"errors"
	"fmt"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- 插件调对方接口时拿配置（VID-04a，plugin.Core.Connectors().With） ---

// ErrNotOwned：实例的定义不是这个来源登记的。按「没有这个实例」处理，插件探不出别人的实例。
var ErrNotOwned = fmt.Errorf("%w: 连接器实例不是这个插件登记的", domain.ErrNotFound)

// WithConfig 把实例解密后的配置交给 fn，fn 返回后即丢，不要留存或打日志。
// source 非空时只认这个来源（插件 id）登记的定义，别的插件和内核的实例回 ErrNotOwned。
// 暂停、断开、定义不在了回冲突；OAuth 实例没授权回冲突，令牌已过期或 RefreshAhead 以内到期时先刷新；
// 刷新失败时令牌还没过期就先用着，已过期回冲突（实例照常置为 error），失败后 RefreshBackoff 内不再每次都刷。fn 的错误里出现凭证原文时换成 ***，没有时原样返回。
func (s *Store) WithConfig(ctx context.Context, id, source string, fn func(Config) error) error {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	d, ok := s.defs.Get(cur.Tool)
	if source != "" && (!ok || d.Source != source) {
		return fmt.Errorf("%w: %s", ErrNotOwned, id)
	}
	switch cur.Status {
	case StatusPaused:
		return conflict("连接器「%s」已暂停", cur.Name)
	case StatusDisconnected:
		return conflict("连接器「%s」已断开", cur.Name)
	}
	if o := cur.OAuth; cur.AuthMode == AuthOAuth2 && o != nil && o.ExpiresAt != nil && !o.ExpiresAt.After(s.now().Add(RefreshAhead)) {
		now := s.now()
		expired := !o.ExpiresAt.After(now)
		// 上次刷新失败还在退避期：不每次调用都去刷，令牌没过期就先用着
		if o.RefreshFailedAt != nil && now.Sub(*o.RefreshFailedAt) < RefreshBackoff {
			if expired {
				return conflict("连接器「%s」的令牌已过期，刷新失败：%s", cur.Name, cur.Error)
			}
		} else {
			res, err := s.RefreshOAuth(ctx, id)
			if err != nil {
				return err
			}
			if !res.OK && expired {
				return conflict("%s", res.Message)
			}
			cur = res.Connector
		}
	}
	_, cfg, err := s.callConfig(ctx, cur)
	if err != nil {
		return err
	}
	if cfg.Mode == AuthOAuth2 && cfg.AccessToken() == "" {
		return conflict("连接器「%s」还没完成 OAuth 授权", cur.Name)
	}
	err = fn(cfg)
	if err == nil {
		return nil
	}
	// 没有凭证原文时原样返回，调用方还能 errors.Is
	if msg := scrub(err.Error(), cfg.secrets); msg != err.Error() {
		return errors.New(msg)
	}
	return err
}
