import type { SupabaseClient } from "@supabase/supabase-js";

import { countMonthlyAnalyses } from "./db/usage-logs";

/**
 * 무료 쿼터 판정 (M4-1) — AI_ANALYSIS_DESIGN.md 6.2 "무료 월 N회,
 * 캐시 히트 재조회는 미차감".
 *
 * 서버(POST /api/analyses의 사전 차단)와 클라이언트(S4의 남은 횟수 표시)가
 * 같은 산식을 쓴다 — 조회는 RLS(usage_logs 본인 select)로 안전하다.
 * 월 구분은 UTC 기준 (usage-logs.monthStartIso).
 */

/** 무료 플랜 월별 분석 횟수 — 유료 플랜은 Phase 4 (PRD 6장) */
export const FREE_MONTHLY_ANALYSIS_QUOTA = 10;

export interface QuotaStatus {
  limit: number;
  used: number;
  /** 남은 횟수 (음수 없음) */
  remaining: number;
}

export async function getQuotaStatus(
  supabase: SupabaseClient,
  userId: string,
  now: () => Date = () => new Date()
): Promise<QuotaStatus> {
  const used = await countMonthlyAnalyses(supabase, userId, now);
  return {
    limit: FREE_MONTHLY_ANALYSIS_QUOTA,
    used,
    remaining: Math.max(0, FREE_MONTHLY_ANALYSIS_QUOTA - used),
  };
}
