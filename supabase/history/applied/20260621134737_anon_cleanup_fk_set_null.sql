-- messages.sender_id 必须保留 FK（前端 PostgREST 内嵌 profiles!messages_sender_id_fkey 依赖它），
-- 故改为 ON DELETE SET NULL + 列可空，而非删除约束。
ALTER TABLE public.messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- rooms.created_by 无内嵌依赖，但同样改为 SET NULL + 可空，保留房间、整理引用完整性。
ALTER TABLE public.rooms ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
