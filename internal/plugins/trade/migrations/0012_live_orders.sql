-- 0012_live_orders: 实盘委托（TRD-08d）
--
-- 实盘委托和模拟盘委托同在 trade_orders，用 live 区分（1 是发到交易所的实盘委托，0 是本地撮合的模拟盘委托）。
-- 模拟盘撮合、强平、挂单占用只看 live = 0 的行；实盘委托的状态只由交易所回写（下单回包、按 clientOrderId 查单），本地从不撮合它。
--   ex_client_id 是发给交易所的委托编号（Binance newClientOrderId、OKX clOrdId），下单前生成、先落库再发请求，
--     请求超时或状态未知时按它查单确认，不自动重发；全库唯一。
--   ex_order_id 是交易所回的委托号（Binance orderId、OKX ordId），交易所确认前为空串；对账按它认出本地委托。
--   submitted_at 是请求发出的时间；checked_at 是最近一次向交易所查单的时间。
-- 实盘委托的 status 比模拟盘多三个：pending（已落库、请求还没回）、partial（部分成交，filled_e8 是已成交数量）、
-- unknown（请求超时或交易所回「状态未知」，等查单确认）；其余同模拟盘 open / filled / canceled / rejected。
-- avg_fill_e8 是交易所给的成交均价，fee_e8 是交易所给的手续费（拿不到为 0）。
-- 时间都是毫秒精度的 RFC3339 UTC。

ALTER TABLE trade_orders ADD COLUMN live INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_orders ADD COLUMN ex_client_id TEXT NOT NULL DEFAULT '';
ALTER TABLE trade_orders ADD COLUMN ex_order_id TEXT NOT NULL DEFAULT '';
ALTER TABLE trade_orders ADD COLUMN submitted_at TEXT NOT NULL DEFAULT '';
ALTER TABLE trade_orders ADD COLUMN checked_at TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX trade_orders_ex_client ON trade_orders(ex_client_id) WHERE ex_client_id != '';
CREATE INDEX trade_orders_live ON trade_orders(live, status);
