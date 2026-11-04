# 宽基异动监控：还需要补哪些信息

ETF-01a 已落库 `etf_funds`（静态元信息）与 `etf_daily`（每日份额 + 交易）。现有字段只能回答"今天多少份额、涨跌多少"，回答不了"这算不算异动、和谁比、和自身历史比"。下面按维度补齐。

## 一、现有基线

| 类别 | 已有字段 | 能回答 |
|---|---|---|
| 份额 | `shares` | 今日份额、相邻日变动（接口层已算 `change`、`change_pct`、`net_inflow`） |
| 交易 | `price` / `open` / `high` / `low` / `volume` / `amount` / `change_pct` / `amplitude` / `turnover_rate` | 当日行情与活跃度 |
| 派生 | `aum`、`premium_discount` | 规模、折溢价 |
| 静态 | `track_index`、`underlying`、`secid`、`manager` | 归属与分组 |

## 二、缺口：按维度

| 维度 | 需补的指标 | 用途 | 来源 |
|---|---|---|---|
| 资金流 | 份额变动率、连续净流入/流出天数、区间累计净流入 | 判断资金进出强度与持续性 | 由 `etf_daily` 窗口计算 |
| 基准 | 跟踪指数日收盘、涨跌幅、成交额 | 算跟踪误差、超额收益，区分"ETF 自身异动"与"指数整体波动" | 新增 `etf_index_daily` |
| 估值 | IOPV、IOPV 偏差、折溢价历史分位 | 折溢价是否异常（套利信号） | 行情接口补 IOPV；分位由窗口算 |
| 流动性 | 量比（成交额 / N 日均额）、成交额分位、换手率分位 | 放量是否异常 | 由 `etf_daily` 窗口计算 |
| 规模 | AUM 变动率、规模分位 | 规模骤增骤减 | 由 `aum` 窗口计算 |
| 结构 | 同类宽基资金流排名、份额集中度 | 判断是个别 ETF 还是全市场行为 | 按 `track_index` / `category` 聚合 |
| 事件 | 分红、拆分、份额折算、限购/暂停申购公告 | 解释非交易性份额变化 | 基金公告（后续接） |

## 三、新增表

```sql
-- 基准指数日行情：跟踪误差与超额收益的分母
CREATE TABLE etf_index_daily (
  trade_date  TEXT NOT NULL,
  index_code  TEXT NOT NULL,   -- 000300、000905…
  close       REAL NOT NULL DEFAULT 0,
  change_pct  REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (trade_date, index_code)
);

-- 每日派生指标（预聚合，避免每次查询扫全表窗口）
CREATE TABLE etf_metrics_daily (
  trade_date        TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  share_change_pct  REAL NOT NULL DEFAULT 0,
  net_inflow        REAL NOT NULL DEFAULT 0,
  inflow_streak     INTEGER NOT NULL DEFAULT 0,  -- 正=连续流入天数，负=连续流出
  amount_ratio      REAL NOT NULL DEFAULT 0,     -- 量比：当日额 / N 日均额
  share_pctile      REAL NOT NULL DEFAULT 0,     -- 份额历史分位 0-100
  aum_pctile        REAL NOT NULL DEFAULT 0,
  premium_pctile    REAL NOT NULL DEFAULT 0,
  tracking_error    REAL NOT NULL DEFAULT 0,     -- 近 N 日跟踪误差
  excess_return     REAL NOT NULL DEFAULT 0,     -- 近 N 日相对指数超额
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (trade_date, symbol)
);

-- 规则：一条规则 = 一个指标 + 比较 + 阈值 + 窗口
CREATE TABLE etf_anomaly_rules (
  id          TEXT PRIMARY KEY,      -- ar_…
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'all',  -- all / symbol / index
  scope_value TEXT NOT NULL DEFAULT '',
  metric      TEXT NOT NULL,         -- share_change_pct、net_inflow、amount_ratio、premium_discount、tracking_error…
  operator    TEXT NOT NULL,         -- gt / lt / abs_gt / streak_gt
  threshold   REAL NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 1,
  severity    TEXT NOT NULL DEFAULT 'warn', -- info / warn / critical
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 命中记录：同日同标的同规则只留一条
CREATE TABLE etf_anomaly_events (
  id          TEXT PRIMARY KEY,      -- ae_…
  trade_date  TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  threshold   REAL NOT NULL,
  severity    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open / acked / ignored
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  UNIQUE (trade_date, symbol, rule_id)
);
```

## 四、首批规则

| 规则 | 指标 | 判定 | 严重度 |
|---|---|---|---|
| 份额单日骤变 | `share_change_pct` | 绝对值 > 2% | warn |
| 连续净流入 | `inflow_streak` | ≥ 3 天 | info |
| 连续净流出 | `inflow_streak` | ≤ -3 天 | warn |
| 放量 | `amount_ratio` | > 2.0 | info |
| 折溢价异常 | `premium_discount` | 绝对值 > 0.5% | warn |
| 规模骤变 | `aum` 日变动率 | 绝对值 > 3% | warn |
| 跟踪误差扩大 | `tracking_error(20)` | > 1.0% | critical |

## 五、计算与告警流程

```mermaid
flowchart LR
  A[每日采集 etf_daily] --> B[补 IOPV 与指数行情]
  B --> C[算 etf_metrics_daily]
  C --> D[按 etf_anomaly_rules 跑判定]
  D --> E{命中?}
  E -- 是 --> F[写 etf_anomaly_events]
  F --> G[发通知 / 事件总线]
  E -- 否 --> H[结束]
```

## 六、要补的接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/etf/metrics?symbol=&from=&to=` | 派生指标序列 |
| GET | `/api/etf/anomalies?date=&symbol=&severity=&status=` | 命中记录 |
| POST | `/api/etf/anomalies/{id}/ack` | 确认或忽略 |
| GET | `/api/etf/rules` | 规则列表 |
| POST | `/api/etf/rules` | 新建规则 |
| PATCH | `/api/etf/rules/{id}` | 改阈值或启停 |

## 七、口径与实现注意

- 份额是 T+1 披露，当日采集到的可能是前一交易日的份额；落库以源返回日期为准，不用采集时间。
- 折溢价用 IOPV 比用收盘净值更准；没有 IOPV 时用 `(price - nav) / nav`，并在指标上标注口径。
- 历史分位至少要有 60 个交易日才有意义，不足时返回空、不判定。
- 量比的 N 默认 20 日，去掉当日再算均值，避免自比较。
- 跟踪误差用近 20 日 ETF 收益率与指数收益率之差的年化标准差；样本不足 20 日不判定。
- 分红、拆分、份额折算会让份额跳变但不代表资金流；接公告前先按"单日变动 > 10% 且无行情配合"标记为待核。
- 事件同一天同标的同规则只留一条，重跑覆盖不改状态（ack 过的保持 ack）。
