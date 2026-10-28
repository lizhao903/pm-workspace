-- 0030_connector_oauth: 连接器的 OAuth 授权状态（CONN-01b）
--
-- 只加列，0029 的列不动。令牌本身（access_token、refresh_token）合进连接器原有的保险箱条目
-- （secret_id 指向的那条，kind=connector），这里只记不敏感的时间和授权范围，后台刷新按到期时间查表，不用逐条解密。
-- 授权进行中的 state 和 PKCE 校验码只在进程内存里（一次性、10 分钟有效），不落库。
--
-- oauth_authorized_at：最近一次完成授权的时间，NULL 表示没授权或已断开。
-- oauth_expires_at：access_token 的到期时间，NULL 表示对方没给有效期（不定时刷新）。
-- oauth_refreshed_at：最近一次刷新成功的时间。
-- oauth_refresh_failed_at：最近一次刷新失败的时间，成功或重新授权后清空；后台刷新按它退避。
-- oauth_scope：对方实际授予的范围（空格分隔，对方没回时取请求的范围）。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

ALTER TABLE connectors ADD COLUMN oauth_authorized_at TEXT;
ALTER TABLE connectors ADD COLUMN oauth_expires_at TEXT;
ALTER TABLE connectors ADD COLUMN oauth_refreshed_at TEXT;
ALTER TABLE connectors ADD COLUMN oauth_refresh_failed_at TEXT;
ALTER TABLE connectors ADD COLUMN oauth_scope TEXT NOT NULL DEFAULT '';
