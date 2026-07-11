import type { SupabaseClient } from "@supabase/supabase-js";

import { StorageError } from "./errors";
import type { TokenUsage } from "./posting-extractions";

/**
 * usage_logs 저장 계층 (M4-1) — AI_ANALYSIS_DESIGN.md 7.2, 6.2 쿼터 정책.
 *
 * LLM 호출 1건당 1행. was_cache_hit=true는 캐시 재사용(쿼터 미차감) 표시로,
 * 캐시 히트율 통계에도 쓰인다. 월별 집계(kind='match' + 미스만)가 무료 쿼터
 * 판정의 원천이다 — 분석 1건은 match 호출과 1:1이므로 match 미스 수 = 차감 수.
 *
 * write는 service-role만 (RLS: 본인 select만) — 쿼터 조작 방지.
 * 조회(count)는 browser 클라이언트로도 가능하다 (RLS가 본인 행으로 스코프).
 */

const USAGE_LOGS_TABLE = "jobConfirm_usage_logs";

/** DB enum "jobConfirm_usage_kind" */
export type UsageKind = "extraction" | "match" | "batch_rematch";

export interface NewUsageLog {
  userId: string;
  kind: UsageKind;
  /** true면 쿼터 미차감 (캐시 재사용 — LLM 호출 없음) */
  wasCacheHit: boolean;
  tokenUsage: TokenUsage | null;
}

/** LLM 호출 기록 (service-role 전용) */
export async function logUsage(supabase: SupabaseClient, log: NewUsageLog): Promise<void> {
  const { error } = await supabase.from(USAGE_LOGS_TABLE).insert({
    user_id: log.userId,
    kind: log.kind,
    was_cache_hit: log.wasCacheHit,
    token_usage: log.tokenUsage,
  });

  if (error) {
    throw new StorageError(`사용 기록 저장 실패 (kind: ${log.kind}): ${error.message}`, {
      cause: error,
    });
  }
}

/** 이번 달의 시작(UTC) ISO 문자열 — 쿼터 집계 구간의 하한 (순수 함수) */
export function monthStartIso(now: () => Date = () => new Date()): string {
  const current = now();
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)).toISOString();
}

/**
 * 이번 달 차감된 분석 수 — kind='match'이고 캐시 미스인 행만 센다.
 * (분석 1건 = match LLM 1회. 실패한 분석은 기록되지 않으므로 미차감 — 8장)
 */
export async function countMonthlyAnalyses(
  supabase: SupabaseClient,
  userId: string,
  now: () => Date = () => new Date()
): Promise<number> {
  const { count, error } = await supabase
    .from(USAGE_LOGS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "match")
    .eq("was_cache_hit", false)
    .gte("created_at", monthStartIso(now));

  if (error) {
    throw new StorageError(`사용량 집계 실패 (user: ${userId}): ${error.message}`, {
      cause: error,
    });
  }
  return count ?? 0;
}
