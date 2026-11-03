-- 0011_target_date: 计划首发日和定时发布（VID-06c）
--
-- 视频加计划首发日 target_date（YYYY-MM-DD，本地日期），排内容日历、算制作进度落后。
-- 定时发布不另建表：发布记录 status = scheduled、scheduled_at 到点、还没有稿件链接的，由后台任务 publish_due 投稿。
-- 索引给后台任务找到点的发布用。

ALTER TABLE video_videos ADD COLUMN target_date TEXT;

CREATE INDEX video_publishes_due ON video_publishes(status, scheduled_at);
