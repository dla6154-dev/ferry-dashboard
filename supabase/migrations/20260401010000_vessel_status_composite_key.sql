-- vessel_status 유니크 키를 psnshp_cd 단독 → (psnshp_cd, Route) 복합키로 변경
-- 선박코드가 같아도 항로가 다르면 별도 행으로 저장

-- 기존 유니크 제약 제거 (이름이 다를 수 있으므로 안전하게 처리)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'vessel_status'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE vessel_status DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- 기존 psnshp_cd primary key도 확인 후 제거
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'vessel_status'::regclass
      AND contype = 'p'
  LOOP
    EXECUTE format('ALTER TABLE vessel_status DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- id 컬럼이 없으면 추가
ALTER TABLE vessel_status ADD COLUMN IF NOT EXISTS id BIGSERIAL;

-- 새 PRIMARY KEY: (psnshp_cd, Route) 복합키
ALTER TABLE vessel_status
  ADD CONSTRAINT vessel_status_pkey PRIMARY KEY (psnshp_cd, "Route");
