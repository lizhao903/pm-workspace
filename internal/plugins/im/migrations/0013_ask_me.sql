-- 0013_ask_me: SOP「私信我确认」节点挂起中的等待（TSK-0411）
--
-- 节点执行时私信「我」（按连接器认出的我在渠道里的编号）一个问题，落一行、步骤挂起。我在私信里的回复不当新消息落库
-- （不进待处理、不触发 IM 流程）：到达时（ingest）记到这一行的 reply_*；后台任务 ask_waits 解析回复：
-- 认出「执行 / 分配 某人 / 不做」就唤醒步骤（Core.SOP().Resume）；认不出时再问一次（reasked 记 1，since、deadline 重新算），
-- 第二次还认不出就以 choice=none 唤醒；到 deadline 没回复先提醒一次（reminded 记 1，deadline 顺延 timeout_ms），
-- 再到点以 choice=none 唤醒，都不执行。唤醒后删掉这一行。再问、提醒发不出去时让步骤失败（Core.SOP().Fail）。
-- me_id 是我在渠道里的编号（Slack Member ID）；conversation_external_id 是私信会话编号（发出后渠道回的，不知道时为空，
-- 按私聊里我发的认）；ask_external_id 是最近一次发出的那条的渠道编号（回复在它的串里时优先认给这一行）。
-- 一次执行的一个步骤只有一行，重试、退回重做后按 attempt 覆盖。时间用定长毫秒 UTC，同 0001。

CREATE TABLE im_ask_waits (
  run_id                   TEXT NOT NULL,
  step                     TEXT NOT NULL,
  attempt                  INTEGER NOT NULL,
  channel                  TEXT NOT NULL,
  connector_id             TEXT NOT NULL DEFAULT '',
  adapter                  TEXT NOT NULL DEFAULT '',
  me_id                    TEXT NOT NULL,
  conversation_external_id TEXT NOT NULL DEFAULT '',
  ask_external_id          TEXT NOT NULL DEFAULT '',
  question                 TEXT NOT NULL DEFAULT '',
  input                    TEXT NOT NULL DEFAULT '{}',
  timeout_ms               INTEGER NOT NULL,
  reasked                  INTEGER NOT NULL DEFAULT 0,
  reminded                 INTEGER NOT NULL DEFAULT 0,
  since                    TEXT NOT NULL,
  deadline                 TEXT NOT NULL,
  reply_text               TEXT NOT NULL DEFAULT '',
  reply_at                 TEXT NOT NULL DEFAULT '',
  reply_ref                TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, step)
);

CREATE INDEX im_ask_waits_by_channel ON im_ask_waits(channel, connector_id);
