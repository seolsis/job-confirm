import type { AnalysisGrade, ScoreBreakdown } from "@/lib/db/match-analyses";

import type { JudgmentVerdict, MatchResult } from "./match-schemas";
import { aggregateVerdict, categorizeJudgments, deriveCriticalGapCount } from "./match-summary";
import type { PostingExtraction } from "./schemas";

/**
 * 3단계 — 적합도 점수 산출 (LLM 아님, 서버 규칙) — docs/AI_ANALYSIS_DESIGN.md 5.2
 *
 * LLM은 요건별 범주형 판정만 하고(설계 원칙 2), 점수는 여기서 가중 합산한다.
 * 같은 판정이면 점수가 항상 같고, 산식을 사용자에게 펼쳐 보일 수 있다 (5.1).
 * 전부 순수 함수 — LLM·DB 호출 없음.
 *
 * 산식 (5.2):
 *   ① 필수요건 70점 = 70 × Σ(판정 가중치) / 판정 대상 요건 수
 *   ② 우대사항 20점 = 20 × Σ(동일 가중치) / 판정 대상 우대 수
 *   ③ 경력/학력 정합 10점 = 경력 6 + 학력 4
 *   종합 = ①+②+③ (0~100, 반올림)
 *   단, 필수요건 unknown 비율이 50% 초과면 점수 대신 insufficient_profile
 */

/**
 * 산식 가중치 — 운영 데이터로 튜닝하는 값이므로 호출부에서 덮어쓸 수 있게
 * 옵션으로 열어둔다 (설계 문서 말미의 하드코딩 금지 원칙).
 */
export interface ScoreConfig {
  /** ① 필수요건 배점 */
  requirementsMax: number;
  /** ② 우대사항 배점 */
  preferencesMax: number;
  /** ③ 중 경력 정합 배점 */
  experienceMax: number;
  /** ③ 중 학력 정합 배점 */
  educationMax: number;
  /** partial 판정의 가중치 (met=1, not_met=0 고정) */
  partialWeight: number;
  /** 필수요건 unknown 비율이 이 값을 "초과"하면 insufficient_profile */
  insufficientUnknownRatio: number;
  /** 등급 하한선 (이상) */
  gradeThresholds: { recommend: number; challenge: number; prepare: number };
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  requirementsMax: 70,
  preferencesMax: 20,
  experienceMax: 6,
  educationMax: 4,
  partialWeight: 0.5,
  insufficientUnknownRatio: 0.5,
  gradeThresholds: { recommend: 80, challenge: 60, prepare: 40 },
};

/** 점수 산출 결과 — match_analyses의 score/grade/score_breakdown/critical_gap_count와 1:1 */
export interface MatchScore {
  /** 0~100 반올림. insufficient_profile이면 null (엉터리 점수를 주느니 점수를 안 준다) */
  score: number | null;
  grade: AnalysisGrade;
  scoreBreakdown: ScoreBreakdown | null;
  /** 필수요건 not_met 수 — 점수가 높아도 경고 뱃지로 병기한다 (5.2) */
  criticalGapCount: number;
}

/** 판정 가중치. unknown은 null — 분모에서 제외한다 (모수에서 뺌) */
function verdictWeight(verdict: JudgmentVerdict, partialWeight: number): number | null {
  switch (verdict) {
    case "met":
      return 1;
    case "partial":
      return partialWeight;
    case "not_met":
      return 0;
    case "unknown":
      return null;
  }
}

/**
 * ①/② 공용: 배점 × Σ(가중치) / 판정 대상 수.
 * - 항목이 아예 없으면 만점 — 충족하지 못한 항목이 없으므로 감점 사유가 없다
 * - 전부 unknown이면 절반 — ③의 unknown 규칙과 동일한 보수적 취급
 *   (필수요건은 unknown 50% 초과 시 insufficient_profile 게이트에 먼저 걸린다)
 */
export function sectionScore(
  verdicts: JudgmentVerdict[],
  max: number,
  partialWeight: number
): number {
  if (verdicts.length === 0) return max;

  const weights = verdicts
    .map((v) => verdictWeight(v, partialWeight))
    .filter((w): w is number => w !== null);
  if (weights.length === 0) return max * 0.5;

  return (max * weights.reduce((sum, w) => sum + w, 0)) / weights.length;
}

/**
 * ③ 공용: 경력/학력 정합 항목 하나.
 * 충족(met)=만점, 미충족(not_met)=0, unknown=절반, partial=partialWeight배 (5.2).
 * 해당 카테고리 요건이 없으면(null) 만점 — 제약 자체가 없다.
 */
export function fitScore(
  verdict: JudgmentVerdict | null,
  max: number,
  partialWeight: number
): number {
  if (verdict === null || verdict === "met") return max;
  if (verdict === "partial") return max * partialWeight;
  if (verdict === "unknown") return max * 0.5;
  return 0; // not_met
}

/** 등급 구간 (5.2): 80~ 적극 추천 │ 60~79 도전 가능 │ 40~59 준비 필요 │ 0~39 갭이 큼 */
export function gradeForScore(
  score: number,
  thresholds: ScoreConfig["gradeThresholds"] = DEFAULT_SCORE_CONFIG.gradeThresholds
): Exclude<AnalysisGrade, "insufficient_profile"> {
  if (score >= thresholds.recommend) return "recommend";
  if (score >= thresholds.challenge) return "challenge";
  if (score >= thresholds.prepare) return "prepare";
  return "large_gap";
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 매칭 판정 → 종합 적합도. extraction은 ③의 경력/학력 카테고리 조인에 쓴다.
 * (순수 함수 — 같은 판정이면 항상 같은 점수)
 */
export function scoreMatch(
  extraction: PostingExtraction,
  result: MatchResult,
  config: ScoreConfig = DEFAULT_SCORE_CONFIG
): MatchScore {
  const criticalGapCount = deriveCriticalGapCount(result);

  // 게이트: 필수요건 unknown 비율 50% 초과 → 점수 없음 (8장: 프로필 보완 유도)
  const requirementVerdicts = result.requirement_judgments.map((j) => j.verdict);
  const unknownCount = requirementVerdicts.filter((v) => v === "unknown").length;
  if (
    requirementVerdicts.length > 0 &&
    unknownCount / requirementVerdicts.length > config.insufficientUnknownRatio
  ) {
    return { score: null, grade: "insufficient_profile", scoreBreakdown: null, criticalGapCount };
  }

  // ① 필수요건 / ② 우대사항
  const requirementsScore = sectionScore(
    requirementVerdicts,
    config.requirementsMax,
    config.partialWeight
  );
  const preferencesScore = sectionScore(
    result.preference_judgments.map((j) => j.verdict),
    config.preferencesMax,
    config.partialWeight
  );

  // ③ 경력/학력 정합 — extraction 카테고리와 조인한 종합 판정 기준
  const categorized = categorizeJudgments(extraction, result.requirement_judgments, "requirements");
  const byCategory = (category: "experience" | "education") =>
    aggregateVerdict(categorized.filter((j) => j.category === category).map((j) => j.verdict));
  const fit =
    fitScore(byCategory("experience"), config.experienceMax, config.partialWeight) +
    fitScore(byCategory("education"), config.educationMax, config.partialWeight);

  const score = Math.round(requirementsScore + preferencesScore + fit);
  return {
    score,
    grade: gradeForScore(score, config.gradeThresholds),
    scoreBreakdown: {
      requirements: round1(requirementsScore),
      preferences: round1(preferencesScore),
      fit: round1(fit),
    },
    criticalGapCount,
  };
}
