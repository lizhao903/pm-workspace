-- 0011_live_review: 实盘评审记录和实盘开关（TRD-08c）
--
-- trade_live_checks 是评审清单每一项现在的确认（原型 LiveReview.confirmed）：一项一行，撤回时删掉这一行。
-- key 是 audit（审计日志）/ recon（对账）/ incident（异常演练）/ drill（全停演练）/ paper（模拟盘两周记录）；
-- confirmed_at 确认时间；reviewer 评审人（界面操作者的名字）；evidence 是确认那一刻这一项的情况和证据链接（JSON：
-- {text, evidence: [{label, href, view?}]}，href 是能直接查的接口路径），note 是评审时写的备注。
-- 只接受用户本人在界面上的确认（X-Actor-Source: ui、不带会话标识），Agent 和接口代为提交一律拒绝并记审计。
--
-- trade_live_reviews 是评审记录（只追加）：action 是 confirm（确认一项）/ revoke（撤回一项）/ pass（五项都确认，评审通过）/
-- reopen（通过之后撤回了某项，评审回到未通过）/ denied（拒绝了代为提交的评审）；item 是涉及的项，pass、reopen 为空串；
-- reviewer 评审人，source 是取证头里的来源（ui / agent / api），detail 是 JSON（证据快照、拒绝原因）。
--
-- trade_live_switch 是实盘开关，全局一行（id = 'global'）：enabled 开没开；changed_at、changed_by 最近一次改的时间和操作者，
-- reason 是关掉的原因（手动、评审撤回、trade:live 收回）。开关只记意愿：实盘下单（TRD-08d）上线之前，开关开着下单入口对实盘账户照样 403。
-- 时间都是毫秒精度的 RFC3339 UTC。

CREATE TABLE trade_live_checks (
  key          TEXT PRIMARY KEY,
  confirmed_at TEXT NOT NULL,
  reviewer     TEXT NOT NULL,
  evidence     TEXT NOT NULL DEFAULT '{}',
  note         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE trade_live_reviews (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  action   TEXT NOT NULL,
  item     TEXT NOT NULL DEFAULT '',
  reviewer TEXT NOT NULL,
  source   TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX trade_live_reviews_by_at ON trade_live_reviews(at);

CREATE TABLE trade_live_switch (
  id         TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT ''
);
