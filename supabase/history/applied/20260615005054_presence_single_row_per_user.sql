-- 清空存量数据（presence 是纯在线状态，重启后重建）
TRUNCATE TABLE presence;

-- 删除旧约束
ALTER TABLE presence DROP CONSTRAINT presence_pkey;
ALTER TABLE presence DROP CONSTRAINT presence_room_id_fkey;

-- 重命名列并设为可空
ALTER TABLE presence RENAME COLUMN room_id TO current_room_id;
ALTER TABLE presence ALTER COLUMN current_room_id DROP NOT NULL;

-- 新主键：每个用户只有一行
ALTER TABLE presence ADD PRIMARY KEY (user_id);

-- 重建外键（ON DELETE SET NULL，房间删除时清空当前房间）
ALTER TABLE presence ADD CONSTRAINT presence_current_room_id_fkey
  FOREIGN KEY (current_room_id) REFERENCES rooms(id) ON DELETE SET NULL;

-- 更新 RLS 策略
DROP POLICY IF EXISTS presence_insert ON presence;
DROP POLICY IF EXISTS presence_select ON presence;
DROP POLICY IF EXISTS presence_update ON presence;

-- 自己可以看到自己的 presence；也能看到当前在自己房间里的其他人
CREATE POLICY presence_select ON presence
  FOR SELECT USING (
    user_id = auth.uid()
    OR current_room_id IN (SELECT private.get_my_room_ids())
  );

-- 只能插入/更新自己的行
CREATE POLICY presence_insert ON presence
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY presence_update ON presence
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
