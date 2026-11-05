-- 0005_paper_trading: 模拟盘账户、委托、成交（TRD-05a）
--
-- 账本精度：金额、数量、价格、手续费都是按 1e8 放大的整数（列名带 _e8），不用浮点记账。
-- 插件的 Store 每次只执行一条语句、没有事务，账本因此以成交流水 trade_fills 为准：
--   每笔成交一条 INSERT，同一行里带上「成交后」这个账户这个标的的持仓（pos_*）；
--   持仓 = 每个 (account_id, symbol) 最新一条成交（seq 最大）的 pos_* 字段，pos_qty_e8 为 0 表示已平。
--   委托的成交状态是第二条语句；进程崩在两条中间时，启动时按成交流水把委托补成已成交。
-- 持仓记成本不记均价：pos_cost_e8 是带符号的持仓名义价值（多为正、空为负，按成交价乘数量乘乘数累计），
-- 均价 = |成本| / (|数量| × 乘数) 只用于显示。已实现盈亏 realized_e8 = −本笔带符号名义 − 结转出去的成本，不含手续费。
-- 于是任意时刻：权益 = 初始资金 + Σ已实现 + 未实现（现价 × 持仓 × 乘数 − 成本）− Σ手续费，整数上精确成立。
--
-- trade_accounts 对照原型 TradeAccount。本批次只有模拟盘：paper 建表时恒为 1，没有改它的语句和接口；
-- initial_e8 是初始资金；fee_rate_e8 是手续费率（万分之 5 存 50000，即 0.0005 × 1e8）；slippage_ticks 是市价成交加减几跳。
-- markets、permissions 是 JSON 数组。权益、可用、保证金不落表，读的时候按成交流水和行情现算。
-- 账户删了委托、成交保留（不加外键），界面上写「已删除的账户」。
--
-- trade_orders 对照原型 Order：type 是 market / limit / stop / stop_limit；status 是 open / filled / canceled / rejected
-- （原型的 pending 在后端不出现：下单当场检查完，过了就是挂单中；partial 预留，模拟撮合一次全部成交）。
-- price_e8、stop_e8 没有为 0；leverage 是整数倍，现货恒为 1；triggered 是止损限价已触发、转成限价等成交；
-- source 是 manual（手动）/ run（部署）/ close（持仓页平仓）/ liquidation（强平）；
-- client_id 是部署下单的幂等键（部署 id + 标的 + K 线时间），手动单为空串；confirmed 是带了二次确认标记。
-- reject_reason 是被拒原因（风控拦截、可用不足等）；filled_e8、avg_fill_e8、fee_e8 是成交后的数。
--
-- trade_fills 是成交流水：seq 是 rowid（成交不删，序号只增，持仓取每个标的 seq 最大的一条）；order_id 唯一（模拟撮合一次全部成交）；
-- kind 是 trade（撮合）/ liquidation（强平）；pos_id 是成交后持仓的编号（平到 0 后再开是新编号，反手也是新编号）。
--
-- trade_day_marks 是每个账户每个 UTC 日第一次看到的权益，日亏损按它算；账户新建当天记初始资金。
-- 时间都是毫秒精度的 RFC3339 UTC。

CREATE TABLE trade_accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  broker         TEXT NOT NULL DEFAULT '模拟',
  kind           TEXT NOT NULL DEFAULT 'exchange',
  markets        TEXT NOT NULL DEFAULT '["crypto"]',
  paper          INTEGER NOT NULL DEFAULT 1,
  currency       TEXT NOT NULL DEFAULT 'USD',
  initial_e8     INTEGER NOT NULL,
  fee_rate_e8    INTEGER NOT NULL DEFAULT 50000,
  slippage_ticks INTEGER NOT NULL DEFAULT 1,
  permissions    TEXT NOT NULL DEFAULT '["read","trade"]',
  api_hint       TEXT NOT NULL DEFAULT '本地模拟撮合',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE trade_orders (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,
  type          TEXT NOT NULL,
  qty_e8        INTEGER NOT NULL,
  price_e8      INTEGER NOT NULL DEFAULT 0,
  stop_e8       INTEGER NOT NULL DEFAULT 0,
  leverage      INTEGER NOT NULL DEFAULT 1,
  reduce_only   INTEGER NOT NULL DEFAULT 0,
  triggered     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  reject_reason TEXT NOT NULL DEFAULT '',
  filled_e8     INTEGER NOT NULL DEFAULT 0,
  avg_fill_e8   INTEGER NOT NULL DEFAULT 0,
  fee_e8        INTEGER NOT NULL DEFAULT 0,
  run_id        TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'manual',
  client_id     TEXT NOT NULL DEFAULT '',
  confirmed     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX trade_orders_by_status ON trade_orders(status, created_at);
CREATE INDEX trade_orders_by_account ON trade_orders(account_id, created_at);
CREATE INDEX trade_orders_by_run ON trade_orders(run_id, created_at);
CREATE UNIQUE INDEX trade_orders_client ON trade_orders(client_id) WHERE client_id != '';

CREATE TABLE trade_fills (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  order_id      TEXT NOT NULL UNIQUE,
  account_id    TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,
  qty_e8        INTEGER NOT NULL,
  price_e8      INTEGER NOT NULL,
  mult_e8       INTEGER NOT NULL,
  notional_e8   INTEGER NOT NULL,
  fee_e8        INTEGER NOT NULL,
  realized_e8   INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'trade',
  run_id        TEXT NOT NULL DEFAULT '',
  pos_id        TEXT NOT NULL,
  pos_qty_e8    INTEGER NOT NULL,
  pos_cost_e8   INTEGER NOT NULL,
  pos_leverage  INTEGER NOT NULL DEFAULT 1,
  pos_run_id    TEXT NOT NULL DEFAULT '',
  pos_opened_at TEXT NOT NULL DEFAULT '',
  at            TEXT NOT NULL
);

CREATE INDEX trade_fills_by_position ON trade_fills(account_id, symbol, seq);
CREATE INDEX trade_fills_by_run ON trade_fills(run_id, seq);
CREATE INDEX trade_fills_by_at ON trade_fills(at);

CREATE TABLE trade_day_marks (
  day        TEXT NOT NULL,
  account_id TEXT NOT NULL,
  equity_e8  INTEGER NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (day, account_id)
);
