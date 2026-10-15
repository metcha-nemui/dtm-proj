-- DTM工程管理: Supabase のテーブルをすべて消す
-- SQL Editor に貼り付けて実行する。そのあと schema.sql を実行すると、空の状態から作り直せる。
--
-- ・データはすべて消え、元に戻せない。残したいデータは、先にアプリの設定画面からエクスポートしておく。
-- ・以前の定義(項目ごとに列を持つテーブル)も、いまの定義(records と app_meta)も、まとめて消す。
--   以前の定義で作ってあるときは、これを実行してから schema.sql を実行する。

drop table if exists
   public.records, public.app_meta,
   public.markers, public.clips, public.tracks, public.tasks, public.lanes, public.projects,
   public.template_tasks, public.section_kinds, public.structure_templates, public.templates
   cascade;
