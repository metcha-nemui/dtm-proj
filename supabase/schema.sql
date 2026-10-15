-- DTM工程管理: Supabase のテーブル定義
-- SQL Editor に貼り付けて実行する。何度実行しても同じ結果になる(既存のテーブルとデータには触らない)。
--
-- ・1つの Supabase プロジェクトを1人で使う前提。ユーザーごとの行の区別はない。
-- ・アプリは Project URL と公開キー(anon key)だけで接続する(擬似ログイン)。
--   つまり、この2つを知っている人は全データを読み書きできる。公開キーは人に渡さず、リポジトリにも入れない。
-- ・レコード(プロジェクト、レーン、タスク、トラック、クリップ、マーカー)は、すべて records テーブルに入れる。
--   項目は data 列(jsonb)にアプリの形のまま入っていて、列に出しているのはコレクション名・id・プロジェクトの id だけ。
--   だから、アプリ側で項目を足したり変えたりしても、このファイルを実行し直す必要はない。
--   データの形の変換は、アプリが起動時に行う(app_meta の schemaVersion を見る。変換前のデータは
--   app_meta の 'backup:v{旧バージョン}:{日時}' に残す)。
-- ・参照の整合(レーンを消したらタスクも消す、など)と値の検証は、アプリ側で行う。外部キーや制約は持たない。

--
-- 【以前の定義(項目ごとに列を持つテーブル)で作ってある場合】
-- 次の文を先に実行して古いテーブルを消してから、このファイルを実行する(データは消える。
-- 残したいデータは、先に古いアプリでエクスポートしておき、あとでインポートする)。
--
--    drop table if exists public.markers, public.clips, public.tracks,
--       public.tasks, public.lanes, public.projects, public.template_tasks,
--       public.section_kinds, public.structure_templates, public.templates, public.app_meta cascade;

create table if not exists public.records (
   collection text not null,
   id text not null,
   -- プロジェクト単位で読む・消すために出している。プロジェクト自身の行では、自身の id
   project_id text not null,
   data jsonb not null,
   primary key (collection, id)
);

create index if not exists records_project_idx on public.records (collection, project_id);

-- ---- アプリ内部の状態(スキーマのバージョン、初期データを投入済みか、変換前のバックアップ) ----

create table if not exists public.app_meta (
   key text primary key,
   value jsonb
);

-- ---- アクセス制御 ----
-- 公開キーを持っていれば、すべての行を読み書きできる。

do $$
declare
   t text;
begin
   foreach t in array array['records', 'app_meta']
   loop
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "own rows" on public.%I', t);
      execute format('drop policy if exists "anyone with the key" on public.%I', t);
      execute format(
         'create policy "anyone with the key" on public.%I for all to anon, authenticated '
         'using (true) with check (true)', t);
      execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
   end loop;
end
$$;

-- API(PostgREST)にテーブルの変更を読み直させる
notify pgrst, 'reload schema';
