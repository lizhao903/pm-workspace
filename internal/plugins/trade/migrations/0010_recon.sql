-- 0010_recon: 实盘账户对账和自动熔断阈值（TRD-08b）
--
-- trade_recons 是每次对账（原型 Reconciliation）：status 是 ok / diff / failed；error 是失败原因（不含凭证）；
-- checked 是这次对了多少项（每个持仓、每笔挂单各一项）；open 是这次对完还没处理的差异数；max_pct 是持仓差异的最大相对差（%）。
-- trade_recon_items 是差异（原型 ReconItem）：kind 是 position / order；key 是持仓键或委托号；
-- local_e8、remote_e8 是本地和交易所的数量（挂单差异：有为数量，没有为 0），local、remote 是给人看的文字；
-- seen 是连续几次对账都看到它（到 2 次才发通知、判熔断，避开拉数据的时间差）；notified、tripped 是已经发过通知、触发过熔断；
-- resolved_at、resolution 是处理时间和方式（adopt 按交易所修正 / verify 标为已核实 / auto 下次对账已一致），note 是核实备注。
-- first_recon_id、last_recon_id 是第一次、最近一次看到它的对账。
--
-- trade_risk 加三个自动熔断阈值：recon_diff_pct 持仓差异超过百分之几熔断；sync_fail_limit 交易所接口连续失败几次熔断；
-- feed_down_minutes 行情数据源断开超过几分钟（且有在跑的部署或挂单）熔断。熔断复用一键全停（kind auto），恢复后不自动解除。

ALTER TABLE trade_risk ADD COLUMN recon_diff_pct REAL NOT NULL DEFAULT 5;
ALTER TABLE trade_risk ADD COLUMN sync_fail_limit REAL NOT NULL DEFAULT 3;
ALTER TABLE trade_risk ADD COLUMN feed_down_minutes REAL NOT NULL DEFAULT 5;

CREATE TABLE trade_recons (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT NOT NULL DEFAULT '',
  checked    INTEGER NOT NULL DEFAULT 0,
  open       INTEGER NOT NULL DEFAULT 0,
  max_pct    REAL NOT NULL DEFAULT 0
);

CREATE INDEX trade_recons_by_account ON trade_recons(account_id, at);

CREATE TABLE trade_recon_items (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  key            TEXT NOT NULL,
  symbol         TEXT NOT NULL DEFAULT '',
  label          TEXT NOT NULL,
  local_e8       INTEGER NOT NULL DEFAULT 0,
  remote_e8      INTEGER NOT NULL DEFAULT 0,
  local          TEXT NOT NULL,
  remote         TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  pct            REAL NOT NULL DEFAULT 0,
  seen           INTEGER NOT NULL DEFAULT 1,
  notified       INTEGER NOT NULL DEFAULT 0,
  tripped        INTEGER NOT NULL DEFAULT 0,
  first_recon_id TEXT NOT NULL,
  last_recon_id  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  resolved_at    TEXT NOT NULL DEFAULT '',
  resolution     TEXT NOT NULL DEFAULT '',
  resolve_note   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX trade_recon_items_by_account ON trade_recon_items(account_id, resolved_at, kind, key);
