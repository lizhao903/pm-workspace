-- 0013_bilibili_web: B 站组件（TSK-0455）：网页端登录态的公开资料、账户数据按天快照、按天趋势、私信会话和消息、风控退避
--
-- 凭证（Cookie、csrf、refresh_token）不在这里：经连接器框架存进 bilibili_web 实例的保险箱条目，这几张表只有公开资料和数据。
-- connector_id 是内核连接器实例 id，不建外键；实例删了，读的时候按没有处理。
--
-- video_bili_profiles：每个 bilibili_web 实例一行。mid、uname、face 是 B 站公开的账号资料；login 是 logged_out / logged_in / expired；
-- dev_id 是发私信接口要带的消息设备号（随机 UUID，每个实例一个，不是设备指纹）；inbox_ready 是有没有拉过一次会话列表做基线
-- （基线之前的私信不发通知）；guard_* 是被限频、风控后的退避：到 guard_until 之前不发任何网页接口请求，guard_strikes 是连着被拦的次数。
CREATE TABLE video_bili_profiles (
  connector_id    TEXT PRIMARY KEY,
  mid             TEXT NOT NULL DEFAULT '',
  uname           TEXT NOT NULL DEFAULT '',
  face            TEXT NOT NULL DEFAULT '',
  login           TEXT NOT NULL DEFAULT 'logged_out',
  dev_id          TEXT NOT NULL DEFAULT '',
  inbox_ready     INTEGER NOT NULL DEFAULT 0,
  inbox_synced_at TEXT,
  guard_until     TEXT,
  guard_reason    TEXT NOT NULL DEFAULT '',
  guard_code      INTEGER NOT NULL DEFAULT 0,
  guard_strikes   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- video_bili_snapshots：账户数据按天快照，一个实例一天一行（北京时间的日期 YYYY-MM-DD），当天再拉覆盖。
-- 拿不到的项存 NULL。source 是数据来自哪：web（网页接口）或 open+web（粉丝、关注、过审稿件数取开放平台）。
CREATE TABLE video_bili_snapshots (
  connector_id     TEXT NOT NULL,
  date             TEXT NOT NULL,
  source           TEXT NOT NULL,
  followers        INTEGER,
  following        INTEGER,
  archives         INTEGER,
  total_click      INTEGER,
  total_like       INTEGER,
  total_coin       INTEGER,
  total_fav        INTEGER,
  total_reply      INTEGER,
  total_dm         INTEGER,
  total_share      INTEGER,
  total_elec       INTEGER,
  incr_fans        INTEGER,
  incr_click       INTEGER,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (connector_id, date)
);

-- video_bili_trends：创作中心的按天增量（每项一天一行），拉一次覆盖同日的值。
-- metric 是 click / dm / reply / share / coin / fav / elec / like。
CREATE TABLE video_bili_trends (
  connector_id TEXT NOT NULL,
  metric       TEXT NOT NULL,
  date         TEXT NOT NULL,
  value        INTEGER NOT NULL,
  PRIMARY KEY (connector_id, metric, date)
);

-- video_bili_sessions：私信会话，一个对方一行。unread 是 B 站给的未读数；last_seqno 是本地收到的最大消息序号。
CREATE TABLE video_bili_sessions (
  connector_id TEXT NOT NULL,
  talker_id    TEXT NOT NULL,
  talker_name  TEXT NOT NULL DEFAULT '',
  talker_face  TEXT NOT NULL DEFAULT '',
  unread       INTEGER NOT NULL DEFAULT 0,
  last_text    TEXT NOT NULL DEFAULT '',
  last_at      TEXT,
  last_seqno   INTEGER NOT NULL DEFAULT 0,
  remote_seqno INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (connector_id, talker_id)
);

CREATE INDEX video_bili_sessions_by_time ON video_bili_sessions(connector_id, last_at);

-- video_bili_messages：私信消息，收到的和发出的都落库。id 是 bpm_ 前缀。
-- direction 是 in / out；status 是 received / sending / sent / failed；msg_key 是 B 站的消息号（发出前为空串）；
-- client_msg_id 是发送时前端给的幂等键，同一个实例下同一个键只发一次。
CREATE TABLE video_bili_messages (
  id            TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  talker_id     TEXT NOT NULL,
  direction     TEXT NOT NULL,
  sender_uid    TEXT NOT NULL DEFAULT '',
  seqno         INTEGER,
  msg_key       TEXT NOT NULL DEFAULT '',
  msg_type      INTEGER NOT NULL DEFAULT 1,
  text          TEXT NOT NULL DEFAULT '',
  at            TEXT NOT NULL,
  status        TEXT NOT NULL,
  error         TEXT NOT NULL DEFAULT '',
  client_msg_id TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE INDEX video_bili_messages_by_talker ON video_bili_messages(connector_id, talker_id, at);

CREATE UNIQUE INDEX video_bili_messages_by_key ON video_bili_messages(connector_id, msg_key) WHERE msg_key != '';

CREATE UNIQUE INDEX video_bili_messages_by_client ON video_bili_messages(connector_id, client_msg_id) WHERE client_msg_id != '';
