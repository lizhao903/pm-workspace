-- 0009_audit: 交易审计的查询索引（TRD-08a）
--
-- 审计正本在内核审计日志（Core.Audit()，操作者 trade#<会话>）。内核审计表插件读不到，也不能按账户、部署筛，
-- 所以每条交易审计同时在这里记一份：委托（下单、被拒、风控拦截、改价、撤单、成交）、部署启停、风控变更和熔断、
-- 账户接入和同步异常、对账差异和处理。只追加，不改不删。
-- origin 是来源：manual（手动，接口来的，含手动单的撮合成交）/ <部署 id>（部署下的单和部署自己的启停）/
-- risk（风控自动动作）/ live（交易所只读同步）/ recon（对账）/ system（别的后台动作）。
-- actor 是内核审计里的操作者会话（user / paper / risk / <部署 id> / live）。
-- account_id、run_id、order_id 是涉及的账户、部署、委托，没有为空串；detail 是和内核审计同样的 JSON（不含凭证）。

CREATE TABLE trade_audit (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  origin      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  account_id  TEXT NOT NULL DEFAULT '',
  run_id      TEXT NOT NULL DEFAULT '',
  order_id    TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX trade_audit_by_at ON trade_audit(at);
CREATE INDEX trade_audit_by_account ON trade_audit(account_id, at);
CREATE INDEX trade_audit_by_run ON trade_audit(run_id, at);
CREATE INDEX trade_audit_by_order ON trade_audit(order_id, at);
