-- 0012_deals: 商单（VID-08d）
--
-- 对照原型 web-next/src/videodata.ts 的 Deal。商单挂在项目下（project_id 是内核项目对象，不建外键，读的时候查不到算已删除的项目），
-- 询价人 contact_id 是内核联系人，来源消息 source_message_id 是 im 插件的消息，结案报告 report_content_id 是内核文档对象，都只存 id 不查表。
-- platforms 是投放平台 JSON 数组；history 是状态变化 JSON 数组，新的在前，由后端在改状态时追加。
-- 金额只是记录，quote 存整数，币种 CNY / USD；deadline（交付截止）、pay_due（账期，最晚收款日）是本地日期 YYYY-MM-DD。
-- 挂的视频放关联表 video_deal_videos，按挂上的先后排；视频、商单删掉时关联一起删。

CREATE TABLE video_deals (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  contact_id        TEXT,
  brand             TEXT NOT NULL,
  title             TEXT NOT NULL,
  platforms         TEXT NOT NULL DEFAULT '[]',
  deliverables      TEXT NOT NULL DEFAULT '',
  quote             INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'CNY',
  status            TEXT NOT NULL DEFAULT 'inquiry',
  deadline          TEXT,
  pay_due           TEXT,
  source_message_id TEXT,
  report_content_id TEXT,
  lost_reason       TEXT NOT NULL DEFAULT '',
  history           TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX video_deals_by_project ON video_deals(project_id, created_at);

CREATE INDEX video_deals_by_status ON video_deals(status, pay_due);

CREATE INDEX video_deals_by_message ON video_deals(source_message_id);

CREATE TABLE video_deal_videos (
  deal_id  TEXT NOT NULL REFERENCES video_deals(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL,
  PRIMARY KEY (deal_id, video_id)
);

CREATE INDEX video_deal_videos_by_video ON video_deal_videos(video_id);
