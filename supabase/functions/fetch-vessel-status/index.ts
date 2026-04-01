// Supabase Edge Function: fetch-vessel-status
// KOMSA 운항정보 API + 제원 API를 동시에 가져와 vessel_status 테이블에 저장

const SERVICE_KEY = "4063f2c2047eaf451ca47bba11369c953e228d145a62d2be87ad7af1d0f3960f";
const BASE_URL    = "https://apis.data.go.kr/B554035/oprt-schd-info/get-oprt-schd-info";
const SPEC_URL    = "https://apis.data.go.kr/B554035/psnshp-spec-v2/get-psnshp-spec-v2";

interface KomsaItem {
  psnshp_cd?:      string;
  psnshp_nm?:      string;
  nvg_se_nm?:      string;
  seawy_se_nm?:    string;
  seawy_se_cd?:    string;
  sail_tm?:        string;
  lcns_seawy_nm?:  string;
  lcns_seawy_cd?:  string;
  nvg_seawy_nm?:   string;
  nvg_seawy_cd?:   string;
  oport_nm?:       string;
  oport_cd?:       string;
  dest_nm?:        string;
  dest_cd?:        string;
  nvg_stts_cd?:    string;
  nvg_stts_nm?:    string;
  nvg_drc_cd?:     string;
  nvg_drc_nm?:     string;
  nnavi_rsn_cd?:   string;
  nnavi_rsn_nm?:   string;
  cntrl_rsn_cd?:   string;
  cntrl_rsn_nm?:   string;
  cnls_etc_rsn?:   string;
  vsl_no?:         string;
  rlvt_ymd?:       string;
}

interface SpecItem {
  psnshp_cd?:       string;
  psnshp_nm?:       string;
  shpcpn_nm?:       string;
  gt?:              number;
  pasngr_pscp_cnt?: number;
  kdship_nm?:       string;
  vsl_len?:         number;
  vsl_width?:       number;
  vsl_dpth?:        number;
  shpcpn_telno?:    string;
  vsl_no?:          string;
}

function processVesselData(items: KomsaItem[]) {
  if (!items || items.length === 0) return [];

  // (선박코드 + 항로코드) 기준 그룹핑 — 동명이선 구분, 다항로 선박 개별 행 처리
  const groups: Record<string, KomsaItem[]> = {};
  for (const item of items) {
    const cd       = (item.psnshp_cd ?? "UNKNOWN").trim();
    const routeCd  = (item.lcns_seawy_cd ?? "UNKNOWN").trim();
    const key      = `${cd}__${routeCd}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const result = [];

  for (const [, group] of Object.entries(groups)) {
    const nm = group[0].psnshp_nm ?? "알 수 없음";
    // 출항시간 기준 정렬
    const sorted = [...group].sort((a, b) => {
      const ta = parseInt(a.sail_tm ?? "0") || 0;
      const tb = parseInt(b.sail_tm ?? "0") || 0;
      return ta - tb;
    });

    // 운항상태 집계
    const statusList = sorted.map(v => v.nvg_se_nm ?? "");
    const total      = statusList.length;
    const controlCnt = statusList.filter(s => s.includes("통제")).length;
    const stopCnt    = statusList.filter(s => s.includes("비운")).length;
    const normalCnt  = statusList.filter(s => ["정상","증회","증선"].some(x => s.includes(x))).length;

    let finalStatus: string;
    if (normalCnt === 0)         finalStatus = controlCnt > 0 ? "통제" : "비운항";
    else if (normalCnt === total) finalStatus = "정상";
    else if (controlCnt > 0)    finalStatus = "일부통제";
    else if (stopCnt > 0)       finalStatus = "일부비운항";
    else                         finalStatus = "정상";

    // 비고 생성 (문제 항차/사유)
    const problemVoyages: string[] = [];
    const reasons: string[] = [];

    // 항차번호별 그룹핑
    const voyageGroups = new Map<number, { all: KomsaItem[]; bad: KomsaItem[] }>();
    let runningTotal = 0;
    for (const v of sorted) {
      const seawy = v.seawy_se_nm ?? "";
      runningTotal += seawy === "순환항로" ? 1.0 : 0.5;
      const voyageNum = Math.ceil(runningTotal);
      if (!voyageGroups.has(voyageNum)) voyageGroups.set(voyageNum, { all: [], bad: [] });
      const g = voyageGroups.get(voyageNum)!;
      g.all.push(v);
      const nvg = v.nvg_se_nm ?? "";
      if (!["정상","증회","증선"].some(x => nvg.includes(x))) {
        g.bad.push(v);
        if (v.nnavi_rsn_nm) reasons.push(v.nnavi_rsn_nm);
        if (v.cntrl_rsn_nm) reasons.push(v.cntrl_rsn_nm);
        if (v.cnls_etc_rsn) reasons.push(v.cnls_etc_rsn);
      }
    }

    // 항차별: 전체 편이 문제면 시간 생략, 일부만 문제면 시간 표시
    for (const [voyageNum, g] of voyageGroups) {
      if (g.bad.length === 0) continue;
      if (g.bad.length === g.all.length) {
        problemVoyages.push(`${voyageNum}항차`);
      } else {
        for (const v of g.bad) {
          const tm = String(v.sail_tm ?? "0000").padStart(4, "0");
          problemVoyages.push(`${voyageNum}항차(${tm})`);
        }
      }
    }

    const uniqueReasons = [...new Set(reasons.filter(Boolean))].join("/");
    const reasonBracket = uniqueReasons ? `[${uniqueReasons}]` : "";
    const voyageStr = finalStatus.includes("일부") && problemVoyages.length
      ? "-" + [...new Set(problemVoyages)].join("/")
      : "";

    let finalRemarks = "";
    if (finalStatus !== "정상") {
      finalRemarks = `${finalStatus}${reasonBracket}${voyageStr}`;
      if (["통제","비운항"].includes(finalStatus) && finalRemarks.includes("-")) {
        finalRemarks = finalRemarks.split("-")[0];
      }
    }

    // 출항시간 목록 (HH:MM 형식으로 변환)
    const sailTimes = sorted
      .map(v => {
        const t = String(v.sail_tm ?? "").padStart(4, "0");
        return t.length >= 4 ? `${t.slice(0,2)}:${t.slice(2,4)}` : "";
      })
      .filter(Boolean)
      .join(",");

    result.push({
      psnshp_cd:    sorted[0].psnshp_cd ?? "",
      psnshp_nm:    nm,
      Route:        sorted[0].lcns_seawy_nm ?? "",
      Status:       finalStatus,
      Remarks:      finalRemarks,
      // 항로 구분 (일반/보조)
      seawy_se_nm:  sorted[0].seawy_se_nm ?? "",
      seawy_se_cd:  sorted[0].seawy_se_cd ?? "",
      // 운항 정보
      oport_nm:     sorted[0].oport_nm ?? "",
      dest_nm:      sorted[0].dest_nm  ?? "",
      nvg_seawy_nm: sorted[0].nvg_seawy_nm ?? "",
      // 출항시간 목록
      sail_tms:     sailTimes,
    });
  }

  return result;
}

// 제원 API 전체 조회 (페이지네이션)
async function fetchAllSpecs(): Promise<Map<string, SpecItem>> {
  const specMap = new Map<string, SpecItem>();
  let pageNo = 1;
  const numOfRows = 1000;

  while (true) {
    const url = `${SPEC_URL}?serviceKey=${SERVICE_KEY}&pageNo=${pageNo}&numOfRows=${numOfRows}&dataType=JSON`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;

      const raw = await res.json();
      let items: SpecItem[] = [];
      try {
        const it = raw?.response?.body?.items?.item;
        items = Array.isArray(it) ? it : (it ? [it] : []);
      } catch (_) { items = []; }

      if (items.length === 0) break;

      for (const item of items) {
        const cd = (item.psnshp_cd ?? "").toString().trim();
        const nm = (item.psnshp_nm ?? "").toString().trim();
        if (cd) specMap.set(cd, item);
        if (nm) specMap.set(`nm_${nm}`, item);
      }

      const totalCount = Number(raw?.response?.body?.totalCount ?? 0);
      if (pageNo * numOfRows >= totalCount) break;
      pageNo++;
    } catch (_) { break; }
  }

  return specMap;
}

Deno.serve(async () => {
  try {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
    const opsUrl = `${BASE_URL}?serviceKey=${SERVICE_KEY}&pageNo=1&numOfRows=10000&dataType=JSON&rlvtYmd=${today}&psnshpNm=`;

    // 운항정보 + 제원 동시 조회
    const [komsaRes, specMap] = await Promise.all([
      fetch(opsUrl),
      fetchAllSpecs(),
    ]);

    if (!komsaRes.ok) throw new Error(`KOMSA API HTTP ${komsaRes.status}`);

    const raw = await komsaRes.json();
    let items: KomsaItem[] = [];
    try {
      const it = raw?.response?.body?.items?.item;
      items = Array.isArray(it) ? it : (it ? [it] : []);
    } catch (_) { items = []; }

    const processed = processVesselData(items);

    // 제원 데이터 병합 (psnshp_cd 우선, 없으면 선명으로 매칭)
    const enriched = processed.map(v => {
      const spec = specMap.get(v.psnshp_cd) || specMap.get(`nm_${v.psnshp_nm}`);
      return {
        ...v,
        shpcpn_nm:       spec?.shpcpn_nm       ?? null,
        gt:              spec?.gt               ?? null,
        pasngr_pscp_cnt: spec?.pasngr_pscp_cnt  ?? null,
        kdship_nm:       spec?.kdship_nm        ?? null,
        vsl_len:         spec?.vsl_len          ?? null,
        vsl_width:       spec?.vsl_width        ?? null,
        vsl_dpth:        spec?.vsl_dpth         ?? null,
        shpcpn_telno:    spec?.shpcpn_telno     ?? null,
      };
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const headers = {
      "apikey":        supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Content-Type":  "application/json",
    };

    // 1. 오늘 운항정보 API에 있는 선박만 upsert
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/vessel_status`, {
      method: "POST",
      headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(enriched),
    });
    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      throw new Error(`Supabase upsert failed: ${err}`);
    }

    // 2. 오늘 API에 없는 (선박코드+항로) 행 삭제
    // 현재 DB의 모든 행을 가져와서 비교 후 삭제
    const currentRes = await fetch(
      `${supabaseUrl}/rest/v1/vessel_status?select=psnshp_cd,Route`,
      { headers }
    );
    let deletedCount = 0;
    if (currentRes.ok) {
      const currentRows: { psnshp_cd: string; Route: string }[] = await currentRes.json();
      const newSet = new Set(enriched.map(v => `${v.psnshp_cd}__${v.Route}`));
      const toDelete = currentRows.filter(r => !newSet.has(`${r.psnshp_cd}__${r.Route}`));
      for (const row of toDelete) {
        await fetch(
          `${supabaseUrl}/rest/v1/vessel_status?psnshp_cd=eq.${encodeURIComponent(row.psnshp_cd)}&Route=eq.${encodeURIComponent(row.Route)}`,
          { method: "DELETE", headers }
        );
        deletedCount++;
      }
    }

    return new Response(JSON.stringify({
      ok:        true,
      count:     enriched.length,
      specCount: Math.round(specMap.size / 2),
      deleted:   String(deletedCount),
      syncedAt:  new Date().toISOString(),
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
