-- 0008_live_accounts: 交易所账户只读接入（TRD-07a）
--
-- 实盘账户也在 trade_accounts 里：paper 恒为 0（建的时候写死，没有改它的语句），统一下单入口对它回 403。
-- 凭证不在插件表里：connector_id 指向内核连接器实例（binance_account / okx_account），API Key、Secret、Passphrase 在保险箱；
-- api_hint 只存 API Key 的后四位（****abcd）。模拟盘的这几列取默认值。
--   status 是 connected / disconnected / error，error 是异常原因（不含凭证）；
--   want_trade 是用户要不要「读取 + 交易」（只是记下来，实盘下单没开放前不起作用）；
--   key_perms 是最近一次查到的 Key 权限（JSON 数组，read / trade）。
--
-- trade_live_state 每个实盘账户一行：最近一次只读同步拉到的余额、持仓、挂单（JSON，给界面看的交易所数据），
-- 估值（权益、可用、保证金，按 1e8 放大），同步时间；baseline_at 是第一次同步成功、建立本地记录的时间；
-- cursors 是各标的成交拉到哪了（JSON）；fail_count 是连续失败次数，tripped 是这一轮故障已经触发过熔断（恢复后清零）。
--
-- 本地记录（对账的「本地」一侧）：trade_live_holdings 是持仓（现货非计价币的持有，键 spot:<币种>；合约按 symbol，
-- 双向持仓加 #long / #short），qty_e8 带符号；trade_live_orders 是本地认的挂单（交易所委托号）。
-- 建立本地记录时按交易所数据初始化，之后只按拉到的成交（trade_live_fills，按成交号去重，新插入的才记账）变动，
-- 对账发现差异时由用户「按交易所修正」或「标为已核实」。
-- trade_live_fills 是交易所的成交历史（只读拉来的），fee_e8 是这笔对手续费币种持有的带符号变动（扣费为负）。
-- 时间都是毫秒精度的 RFC3339 UTC。

ALTER TABLE trade_accounts ADD COLUMN connector_id TEXT NOT NULL DEFAULT '';
ALTER TABLE trade_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE trade_accounts ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE trade_accounts ADD COLUMN want_trade INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_accounts ADD COLUMN key_perms TEXT NOT NULL DEFAULT '[]';

CREATE TABLE trade_live_state (
  account_id      TEXT PRIMARY KEY,
  equity_e8       INTEGER NOT NULL DEFAULT 0,
  available_e8    INTEGER NOT NULL DEFAULT 0,
  margin_e8       INTEGER NOT NULL DEFAULT 0,
  marks_stale     INTEGER NOT NULL DEFAULT 0,
  balances        TEXT NOT NULL DEFAULT '[]',
  positions       TEXT NOT NULL DEFAULT '[]',
  orders          TEXT NOT NULL DEFAULT '[]',
  synced_at       TEXT NOT NULL DEFAULT '',
  baseline_at     TEXT NOT NULL DEFAULT '',
  cursors         TEXT NOT NULL DEFAULT '{}',
  fail_count      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  last_attempt_at TEXT NOT NULL DEFAULT '',
  tripped         INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

CREATE TABLE trade_live_holdings (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  qty_e8     INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE trade_live_orders (
  account_id TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL,
  type       TEXT NOT NULL,
  qty_e8     INTEGER NOT NULL,
  price_e8   INTEGER NOT NULL DEFAULT 0,
  filled_e8  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, order_id)
);

CREATE TABLE trade_live_fills (
  account_id TEXT NOT NULL,
  fill_id    TEXT NOT NULL,
  order_id   TEXT NOT NULL DEFAULT '',
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL,
  qty_e8     INTEGER NOT NULL,
  price_e8   INTEGER NOT NULL,
  fee_e8     INTEGER NOT NULL DEFAULT 0,
  fee_asset  TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,
  synced_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, fill_id)
);

CREATE INDEX trade_live_fills_by_at ON trade_live_fills(account_id, at);
CREATE INDEX trade_accounts_by_connector ON trade_accounts(connector_id);
