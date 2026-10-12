-- DTM工程管理: Supabase のテーブル定義
-- SQL Editor に貼り付けて実行する。何度実行しても同じ結果になる(既存のテーブルとデータには触らない)。
--
-- ・1つの Supabase プロジェクトを1人で使う前提。ユーザーごとの行の区別はない。
-- ・アプリは Project URL と公開キー(anon key)だけで接続する(擬似ログイン)。
--   つまり、この2つを知っている人は全データを読み書きできる。公開キーは人に渡さず、リポジトリにも入れない。
-- ・列名は snake_case。アプリ側(camelCase)との対応は js/store/supabase.js で取る。
--   アプリの order は予約語を避けて sort_order にしている。

--
-- 【以前の定義で作ったテーブルがある場合】
-- テンプレートの持ち方を変えた(プロジェクトと同じテーブルに入れ、セクション種別と定番タスクをやめた)ので、
-- そのままでは動かない。データの変換は用意していない。
-- 次の文を先に実行して全テーブルを消してから、このファイルを実行する。
--
--    drop table if exists public.tasks, public.lanes, public.projects, public.template_tasks,
--       public.section_kinds, public.structure_templates, public.templates, public.app_meta cascade;

-- ---- プロジェクトとテンプレート ----
-- テンプレートは「ステータスを使わないプロジェクト」。レーンとタスクの持ち方は同じなので、同じテーブルに入れる。

create table if not exists public.projects (
   id text primary key,
   title text not null,
   memo text not null default '',
   due_date date,
   is_template boolean not null default false,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
);

create table if not exists public.lanes (
   id text primary key,
   project_id text not null references public.projects (id) on delete cascade,
   type text not null check (type in ('section', 'global')),
   name text not null,
   sort_order double precision not null,
   collapsed boolean not null default false,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
);

create index if not exists lanes_project_idx on public.lanes (project_id);

-- 「全体」レーンは、1つのプロジェクトに1本だけ
create unique index if not exists lanes_one_global_per_project
   on public.lanes (project_id) where type = 'global';

create table if not exists public.tasks (
   id text primary key,
   project_id text not null references public.projects (id) on delete cascade,
   lane_id text not null references public.lanes (id) on delete cascade,
   title text not null,
   memo text not null default '',
   status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
   sort_order double precision not null,
   done_at timestamptz,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
);

create index if not exists tasks_project_idx on public.tasks (project_id);
create index if not exists tasks_lane_idx on public.tasks (lane_id);

-- ---- アプリ内部の状態(初期データを投入済みか、など) ----

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
   foreach t in array array[
      'projects', 'lanes', 'tasks', 'app_meta'
   ]
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
