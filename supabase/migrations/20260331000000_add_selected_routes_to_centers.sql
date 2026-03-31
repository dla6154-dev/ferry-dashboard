-- centers 테이블에 selected_routes 컬럼 추가
ALTER TABLE centers ADD COLUMN IF NOT EXISTS selected_routes jsonb DEFAULT '[]'::jsonb;
