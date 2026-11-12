-- 0010_skips: 自动触发没发起的记录（TSK-0491，插件 0.18.0）
--
-- IM 消息、定时到点时流程没有发起执行（过滤条件不符、被前面的 IM 流程拦截、发信人被自动忽略、必填输入补不齐、发起出错），
-- 原来只写服务日志，界面上看不到「为什么没跑」。每次记一行，流程详情的「最近未发起」读它。id 前缀 spk。
--   source      im / schedule
--   source_ref  消息 id（im）或定时任务 id（schedule）
--   reason      filtered（过滤不符）/ stopped（被前面的流程拦截）/ muted（发信人被自动忽略）/ missing（必填输入补不齐）/ start_failed（发起出错）
--   detail      给人看的一句原因
--   info        JSON：会话、与我的关系、缺的字段、拦截它的流程等，按 reason 不同
-- 保留：每条流程「过滤不符」最多 100 行、其余原因最多 200 行，超过 7 天的删掉，写入时顺手清（不靠迁移、不靠定时任务）。
-- 流程删了它的记录一起删。消息超过 24 小时（连接器首次同步带进的历史）不发起也不记。

CREATE TABLE sop_skips (
  id         TEXT PRIMARY KEY,
  flow_id    TEXT NOT NULL,
  source     TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  info       TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL
);

CREATE INDEX sop_skips_flow ON sop_skips (flow_id, at);
