-- 0046_provider_last_test: 服务商最近一次「测试连接」的结论落库
--
-- 之前结论只在浏览器内存里，离开设置页几分钟或刷新后卡片回到「未测试」。
-- last_test 是 JSON：{ok, latency_ms, message, models?, at}，没测过为 NULL。
-- 改了地址、协议、密钥、扩展配置或启停时清空（结论不再作数），只改名称、默认模型不清。
-- 不记上游原文：message 是归类后的说法，同 POST /api/agent-providers/{id}/test。

ALTER TABLE agent_providers ADD COLUMN last_test TEXT;
