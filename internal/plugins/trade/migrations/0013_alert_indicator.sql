-- 0013_alert_indicator: 盯盘提醒的指标条件（TRD-10）
--
-- trade_alerts 加两列，只给 cond 为 ind_above / ind_below / ind_cross_up / ind_cross_down 的提醒用，别的条件为空串：
--   indicator 是指标，写法同策略规则的操作数，存 JSON，如 {"kind":"ind","ind":"rsi","params":[14]}；
--   interval 是算指标用的 K 线周期（1m、5m、15m、1h、4h、1d、1w）。
-- 已有的提醒不受影响（两列默认空串）。

ALTER TABLE trade_alerts ADD COLUMN indicator TEXT NOT NULL DEFAULT '';
ALTER TABLE trade_alerts ADD COLUMN interval TEXT NOT NULL DEFAULT '';
