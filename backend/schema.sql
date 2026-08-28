-- Supabase 프로젝트의 SQL Editor에서 이 내용을 그대로 실행하세요.
-- (SUPABASE-SETUP.md 2단계 참고)

create table if not exists users (
  id text primary key,              -- 예: 'kakao:12345', 'naver:67890'
  provider text not null,           -- 'kakao' 또는 'naver'
  nickname text not null,
  profile_image text,
  created_at timestamptz not null default now()
);
