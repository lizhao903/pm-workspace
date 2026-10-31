-- 0044_msg_status_expired: IM 消息状态加「已过期」（IM-07）
--
-- im 插件 0005 起，超过设置的天数没处理的消息记为已过期（库里是待处理加 expired_at，接口状态为 expired）。
-- 前端按 msg_status 字典显示状态名和颜色，这里补一项系统值；已经有这个 key 的（用户自己加过）不动。

INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at)
SELECT 'dit_msg_expired','msg_status',NULL,'expired','已过期','#868e96','超过设置的天数没处理，不再提醒',40,'{}',NULL,datetime('now'),datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM dict_items WHERE dict_id = 'msg_status' AND key = 'expired');

UPDATE dictionaries SET description = 'IM 消息的处理状态。四个都是系统值：待处理、已处理、已忽略落在 im_messages.status，已过期是待处理加 expired_at'
WHERE id = 'msg_status';
