-- vessel_change_log: 선박 증선/감선 이력 테이블
CREATE TABLE IF NOT EXISTS vessel_change_log (
  id          BIGSERIAL PRIMARY KEY,
  changed_at  TIMESTAMPTZ DEFAULT NOW(),
  psnshp_cd   TEXT,
  psnshp_nm   TEXT,
  route       TEXT,
  change_type TEXT CHECK (change_type IN ('증선', '감선'))
);

-- RLS 활성화
ALTER TABLE vessel_change_log ENABLE ROW LEVEL SECURITY;

-- anon 키로 읽기 허용
CREATE POLICY "Allow read vessel_change_log"
  ON vessel_change_log FOR SELECT USING (true);

-- 트리거 함수
CREATE OR REPLACE FUNCTION log_vessel_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO vessel_change_log (psnshp_cd, psnshp_nm, route, change_type)
    VALUES (NEW.psnshp_cd, NEW.psnshp_nm, NEW."Route", '증선');
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO vessel_change_log (psnshp_cd, psnshp_nm, route, change_type)
    VALUES (OLD.psnshp_cd, OLD.psnshp_nm, OLD."Route", '감선');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- vessel_status 테이블에 트리거 등록
DROP TRIGGER IF EXISTS vessel_change_logger ON vessel_status;
CREATE TRIGGER vessel_change_logger
  AFTER INSERT OR DELETE ON vessel_status
  FOR EACH ROW EXECUTE FUNCTION log_vessel_change();
