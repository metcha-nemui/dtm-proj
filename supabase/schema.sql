-- DTM工程管理: Supabase のテーブル定義
-- SQL Editor に貼り付けて実行する。何度実行しても同じ結果になる(既存のデータは残る。消えるのは、廃止した列だけ)。
--
-- ・1つの Supabase プロジェクトを1人で使う前提。ユーザーごとの行の区別はない。
-- ・アプリは Project URL と公開キー(anon key)だけで接続する(擬似ログイン)。
--   つまり、この2つを知っている人は全データを読み書きできる。公開キーは人に渡さず、リポジトリにも入れない。
-- ・列名は snake_case。アプリ側(camelCase)との対応は js/store/supabase.js で取る。
--   アプリの order は予約語を避けて sort_order にしている。

-- ---- プロジェクト側 ----

create table if not exists public.projects (
   id text primary key,
   title text not null,
   memo text not null default '',
   due_date date,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
);

create table if not exists public.lanes (
   id text primary key,
   project_id text not null references public.projects (id) on delete cascade,
   type text not null check (type in ('section', 'global')),
   name text not null,
   -- 由来するセクション種別。種別を消してもレーンは残すので、外部キーにはしない
   kind_id text,
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

-- ---- ライブラリ(ノウハウ)側 ----

create table if not exists public.section_kinds (
   id text primary key,
   name text not null,
   sort_order double precision not null,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
);

create table if not exists public.template_tasks (
   id text primary key,
   scope text not null check (scope in ('kind', 'global')),
   -- scope = 'kind' のときだけ入る。'global'(「全体」の定番)では null
   kind_id text references public.section_kinds (id) on delete cascade,
   title text not null,
   memo text not null default '',
   sort_order double precision not null,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   check ((scope = 'kind' and kind_id is not null) or (scope = 'global' and kind_id is null))
);

create index if not exists template_tasks_kind_idx on public.template_tasks (kind_id);

create table if not exists public.structure_templates (
   id text primary key,
   name text not null,
   -- セクション種別のIDを並び順どおりに。同じ種別が何度出てもよい
   sections text[] not null default '{}',
   sort_order double precision not null,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now()
);

-- ---- 廃止した列 ----
-- 以前の定義で作ったテーブルから落とす。タスクの出自(定番 / 固有)と、セクション種別の色。

alter table public.tasks drop column if exists origin;
alter table public.tasks drop column if exists source_template_task_id;
alter table public.section_kinds drop column if exists color;

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
      'projects', 'lanes', 'tasks', 'section_kinds', 'template_tasks', 'structure_templates', 'app_meta'
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
