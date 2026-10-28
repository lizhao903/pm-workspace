-- 0024_webhook_deliveries: Webhook 投递记录（TASK-02b）
--
-- 一行是一次投递：签名对上之后不管建没建任务都记一条，建没建、为什么没建都查得到。
-- 签名不对、Webhook 不存在、请求体超限的直接拒收，不进这张表（和原型的说明一致）。
--
--   result 为 created / skipped（停用、过滤不通过、重复推送）/ failed（不是 JSON 对象、标题取不到、建任务出错）；
--   reason 是给人看的原因，created 时为空；
--   task_id 是建出来的任务，重复推送时是之前建的那条；任务删了这里保留原值；
--   external_id 是请求头 X-PMW-Delivery 带来的投递 id，没有为空串；
--   dedupe_key 是去重键：dedupe 路径的值（p:路径=值），取不到用投递 id（id:值），再没有用请求体哈希（sha256:十六进制）；
--   payload 是原始请求体，mapped 是映射出来的字段（JSON），失败时也留着，方便看是哪一项没取到。
-- 去重只认 result = created 且任务没删（含软删）的记录：任务删了，同样的推送再来就重新建。
-- at 用定长毫秒 UTC，字符串比较即时间比较。删 Webhook 时投递记录一起删（外键级联），建出来的任务保留。

CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  hook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  result       TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  task_id      TEXT,
  external_id  TEXT NOT NULL DEFAULT '',
  dedupe_key   TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL DEFAULT '',
  mapped       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(hook_id, at);
CREATE INDEX idx_webhook_deliveries_dedupe ON webhook_deliveries(hook_id, dedupe_key) WHERE result = 'created';
