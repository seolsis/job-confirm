import type { SupabaseClient } from "@supabase/supabase-js";

import type { MatchResult } from "@/lib/ai/match-schemas";

import { StorageError } from "./errors";
import type { TokenUsage } from "./posting-extractions";

/**
 * match_analyses 저장 계층 — AI_ANALYSIS_DESIGN.md 7.2
 *
 * 불변(append-only) — 재분석 시 새 행을 만든다. (user_id, posting) 기준 시계열이
 * 곧 "점수 변화 추적" 데이터다. 분석 내용의 update 함수는 의도적으로 만들지 않는다.
 * 유일한 예외는 사용자 피드백(feedback/feedback_reason) 갱신이다 (M4-2).
 * write는 service-role 클라이언트만 가능하다 (RLS: 본인 select만 허용).
 */

const ANALYSES_TABLE = "jobConfirm_match_analyses";

/** DB enum "jobConfirm_analysis_grade" — 점수 산식(5.2)의 등급 구간 */
export type AnalysisGrade =
  | "recommend" // 80~100 적극 추천
  | "challenge" // 60~79 도전 가능
  | "prepare" // 40~59 준비 필요
  | "large_gap" // 0~39 갭이 큼
  | "insufficient_profile"; // unknown 50% 초과 → 점수 없음 (프로필 부족)

/** DB enum "jobConfirm_feedback_type" */
export type AnalysisFeedback = "up" | "down";

/** 산식 항목별 점수 — "왜 72점" 펼쳐보기용 (5.2의 ①②③). 구체 산출은 M1-11 */
export interface ScoreBreakdown {
  requirements: number; // ① 필수요건 (70점 만점)
  preferences: number; // ② 우대사항 (20점 만점)
  fit: number; // ③ 경력/학력 정합 (10점 만점)
}

/** jobConfirm_match_analyses 행 (불변 — 재분석 시 새 행) */
export interface MatchAnalysisRow {
  id: string;
  user_id: string;
  /** 어떤 구조화 버전 기준인지 (posting_extraction_id) */
  extraction_id: string;
  /** 어떤 프로필 기준인지 */
  profile_snapshot_id: string;
  /** 4.2 스키마 전체 (match_result) */
  result: MatchResult;
  /** 서버 산출 종합 점수 0~100. "프로필 부족" 시 null (M1-11) */
  score: number | null;
  grade: AnalysisGrade;
  score_breakdown: ScoreBreakdown | null;
  /** 필수요건 not_met 수 (경고 뱃지) — match-summary.deriveCriticalGapCount와 동일 정의 */
  critical_gap_count: number;
  /** 분석 버전 3종 (analysis_version) — 회귀 비교용 (설계 원칙 5) */
  model_id: string;
  prompt_version: string;
  schema_version: string;
  token_usage: TokenUsage | null;
  feedback: AnalysisFeedback | null;
  feedback_reason: string | null;
  created_at: string;
}

/**
 * insert 페이로드 — analyzeMatch() 산출물(MatchAnalysisOutput) + scoreMatch()
 * 산출물(MatchScore) + 참조 ID로 구성한다.
 */
export interface NewMatchAnalysis {
  user_id: string;
  extraction_id: string;
  profile_snapshot_id: string;
  result: MatchResult;
  score: number | null;
  grade: AnalysisGrade;
  score_breakdown: ScoreBreakdown | null;
  critical_gap_count: number;
  model_id: string;
  prompt_version: string;
  schema_version: string;
  token_usage: TokenUsage | null;
}

/** 매칭 결과 단건 조회 — 카드 상세(S8)의 "분석 결과 다시 보기"와 저장 API의 소유권 확인용 */
export async function getMatchAnalysisById(
  supabase: SupabaseClient,
  analysisId: string
): Promise<MatchAnalysisRow | null> {
  const { data, error } = await supabase
    .from(ANALYSES_TABLE)
    .select("*")
    .eq("id", analysisId)
    .maybeSingle();

  if (error) {
    throw new StorageError(`매칭 분석 조회 실패 (id: ${analysisId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as MatchAnalysisRow | null) ?? null;
}

/**
 * 구조화 버전 기준 최신 매칭 결과 조회 — 결과 화면(S6)이 잡의 posting →
 * latest_extraction_id를 따라와 읽는다. browser 클라이언트로 호출하면
 * RLS(본인만 select)가 사용자 스코프를 보장하므로 user_id 필터는 두지 않는다.
 */
export async function getLatestMatchAnalysis(
  supabase: SupabaseClient,
  extractionId: string
): Promise<MatchAnalysisRow | null> {
  const { data, error } = await supabase
    .from(ANALYSES_TABLE)
    .select("*")
    .eq("extraction_id", extractionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new StorageError(
      `매칭 분석 조회 실패 (extraction_id: ${extractionId}): ${error.message}`,
      { cause: error }
    );
  }
  return (data as MatchAnalysisRow | null) ?? null;
}

/** 매칭 분석 결과 저장 (append-only — 항상 새 행) */
export async function saveMatchAnalysis(
  supabase: SupabaseClient,
  analysis: NewMatchAnalysis
): Promise<MatchAnalysisRow> {
  const { data, error } = await supabase.from(ANALYSES_TABLE).insert(analysis).select().single();

  if (error) {
    throw new StorageError(
      `매칭 분석 저장 실패 (extraction_id: ${analysis.extraction_id}): ${error.message}`,
      { cause: error }
    );
  }
  return data as MatchAnalysisRow;
}

/**
 * 사용자 피드백 기록 (M4-2, PRD 4.1 F14) — 👍/👎와 👎 사유. null이면 철회.
 * 결과 불변 원칙의 유일한 예외 컬럼. write는 service-role만 —
 * 소유권 확인을 거쳐 /api 라우트로만 진입한다 (품질 모니터링 루프의 원천, 7.2).
 */
export async function updateAnalysisFeedback(
  supabase: SupabaseClient,
  analysisId: string,
  feedback: AnalysisFeedback | null,
  reason: string | null
): Promise<MatchAnalysisRow> {
  const trimmed = reason?.trim() ?? "";
  const { data, error } = await supabase
    .from(ANALYSES_TABLE)
    .update({
      feedback,
      // 사유는 👎에만 의미가 있다 — 그 외에는 비워 혼동을 막는다
      feedback_reason: feedback === "down" && trimmed !== "" ? trimmed : null,
    })
    .eq("id", analysisId)
    .select()
    .single();

  if (error) {
    throw new StorageError(`피드백 저장 실패 (id: ${analysisId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as MatchAnalysisRow;
}
