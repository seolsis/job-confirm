import type { SupabaseClient } from "@supabase/supabase-js";

import type { AnalysisJobRow } from "@/lib/db/analysis-jobs";

/**
 * analysis_jobs Realtime 구독 (M1-13) — ARCHITECTURE.md 3.3
 *
 * 분석 진행 상태(step)는 응답 스트림이 아니라 DB 행 변경으로 전달된다:
 * 서버(lib/db/analysis-jobs.ts)가 step을 갱신하면 클라이언트는 이 구독으로
 * 받아 UI를 갱신한다. 페이지를 이탈·새로고침해도 잡 id로 다시 붙을 수 있다.
 *
 * 전제 (스키마 변경 없음 — 기존 마이그레이션에 포함):
 *  - supabase_realtime publication에 jobConfirm_analysis_jobs가 노출돼 있다
 *  - RLS select 정책(본인 잡만)이 Realtime 이벤트에도 적용된다
 *
 * 사용 (Client Component에서, browser 클라이언트로):
 *   const unsubscribe = subscribeToAnalysisJob(supabase, jobId, setJob);
 *   const current = await getAnalysisJob(supabase, jobId); // 구독 직후 초기 상태 1회 조회
 *   ...
 *   unsubscribe(); // cleanup (useEffect 반환 등)
 *
 * 구독을 먼저 열고 초기 상태를 조회해야 구독 연결 전에 일어난 변경을 놓치지 않는다.
 */

const JOBS_TABLE = "jobConfirm_analysis_jobs";

/**
 * 잡 하나의 INSERT/UPDATE를 구독한다. 변경된 행 전체가 onChange로 전달되므로
 * 호출부는 그대로 클라이언트 상태(setState 등)에 넣으면 된다.
 * 반환값은 구독 해제 함수.
 *
 * onSubscribed: 채널 조인이 실제로 완료된(SUBSCRIBED) 시점에 호출된다.
 * subscribe()는 비동기로 조인하므로 "구독 먼저 → 초기 조회"만으로는
 * 초기 조회~조인 완료 사이의 전이를 놓칠 수 있다 — 호출부는 이 콜백에서
 * 상태를 1회 재조회해 갭을 메운다 (M2-3 E2E에서 실측된 레이스).
 */
export function subscribeToAnalysisJob(
  supabase: SupabaseClient,
  jobId: string,
  onChange: (job: AnalysisJobRow) => void,
  onSubscribed?: () => void
): () => void {
  const changeConfig = {
    schema: "public",
    table: JOBS_TABLE,
    filter: `id=eq.${jobId}`,
  };
  const handle = (payload: { new: Record<string, unknown> }): void => {
    onChange(payload.new as unknown as AnalysisJobRow);
  };

  const channel = supabase
    .channel(`jobConfirm-analysis-job-${jobId}`)
    // 잡 생성 직후 구독하는 경우를 위해 INSERT도 받는다 (대부분은 UPDATE)
    .on("postgres_changes", { ...changeConfig, event: "INSERT" }, handle)
    .on("postgres_changes", { ...changeConfig, event: "UPDATE" }, handle)
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        onSubscribed?.();
        return;
      }
      // 구독 실패는 조용히 묻히면 진행 UI가 멈춘 것처럼 보인다 — 원인 추적용 로그
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(`[realtime] 구독 실패 (job: ${jobId}, status: ${status})`, err);
      }
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
