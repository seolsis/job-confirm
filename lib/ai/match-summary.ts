import type { JudgmentVerdict, MatchResult, RequirementJudgment } from "./match-schemas";
import type { PostingExtraction, RequirementCategory } from "./schemas";

/**
 * 매칭 결과 요약·정합성 검증 (M1-10) — 전부 순수 함수, LLM·DB 없음.
 *
 * LLM(match.ts)은 요건 텍스트 단위로만 판정한다. 카테고리(기술/경력/학력)별
 * 관점은 1단계 extraction의 requirements[].category와 판정을 텍스트로 조인해
 * 서버에서 결정적으로 도출한다 — 같은 판정이면 요약도 항상 같다 (설계 원칙 2와 동일 정신).
 *
 * 이 요약은 M1-11 점수 산식의 입력이기도 하다
 * (①요건 판정 가중 합산, ③경력/학력 정합 — 점수 계산 자체는 여기서 하지 않는다).
 */

/** 카테고리가 붙은 판정 — extraction 요건과 텍스트 조인 결과 */
export interface CategorizedJudgment extends RequirementJudgment {
  /** 조인 실패(요건에 없는 텍스트를 판정) 시 null */
  category: RequirementCategory | null;
}

/** 근거 항목 — "근거 보기" UI·오답 검수 재료 (설계 원칙 3) */
export interface MatchEvidence {
  requirement_text: string;
  verdict: JudgmentVerdict;
  profile_evidence: string | null;
  reason: string;
}

/** 매칭 요약 — 사용자에게 보여줄 관점별 집계 */
export interface MatchSummary {
  /** 매칭되는 기술 (skill 카테고리 요건 중 met) */
  matchedSkills: string[];
  /** 부족한 기술 (skill 카테고리 요건 중 not_met + partial) */
  missingSkills: string[];
  /** 경력 조건 일치 여부 (experience 카테고리 종합, 해당 요건 없으면 null) */
  experienceFit: JudgmentVerdict | null;
  /** 학력 조건 일치 여부 (education 카테고리 종합, 해당 요건 없으면 null) */
  educationFit: JudgmentVerdict | null;
  /** 매칭된 우대사항 */
  matchedPreferences: string[];
  /** 미충족 우대사항 (not_met만 — unknown은 불이익을 주지 않는다) */
  unmatchedPreferences: string[];
  /** 불일치 조건 — 카테고리 무관 필수요건 not_met 전체 */
  unmetRequirements: string[];
  /** 판단 불가 요건 — "프로필에 이 정보를 추가하면 분석이 정확해져요" 유도 (4.2) */
  unknownRequirements: string[];
  /** 필수요건 not_met 수 — match_analyses.critical_gap_count 발췌 컬럼과 동일 정의 (7.2) */
  criticalGapCount: number;
  /** 요건별 분석 근거 (필수 + 우대 순) */
  evidences: MatchEvidence[];
}

/** 판정 결과에 extraction의 카테고리를 붙인다 (텍스트 완전 일치 조인 — 프롬프트가 원문 복사를 강제) */
export function categorizeJudgments(
  extraction: PostingExtraction,
  judgments: RequirementJudgment[],
  source: "requirements" | "preferences"
): CategorizedJudgment[] {
  const categoryByText = new Map<string, RequirementCategory>(
    extraction[source].map((item) => [item.text, item.category])
  );
  return judgments.map((judgment) => ({
    ...judgment,
    category: categoryByText.get(judgment.requirement_text) ?? null,
  }));
}

/**
 * 카테고리 하나의 종합 판정 — 보수적으로 최악 값을 취한다:
 * not_met > partial > unknown > met. (요건이 없으면 null)
 */
export function aggregateVerdict(verdicts: JudgmentVerdict[]): JudgmentVerdict | null {
  if (verdicts.length === 0) return null;
  if (verdicts.includes("not_met")) return "not_met";
  if (verdicts.includes("partial")) return "partial";
  if (verdicts.includes("unknown")) return "unknown";
  return "met";
}

/** match_analyses.critical_gap_count의 정의: 필수요건 not_met 수 (7.2) */
export function deriveCriticalGapCount(result: MatchResult): number {
  return result.requirement_judgments.filter((j) => j.verdict === "not_met").length;
}

/** 매칭 결과 → 관점별 요약. 같은 입력이면 항상 같은 출력 (순수 함수) */
export function summarizeMatch(extraction: PostingExtraction, result: MatchResult): MatchSummary {
  const requirements = categorizeJudgments(
    extraction,
    result.requirement_judgments,
    "requirements"
  );
  const preferences = categorizeJudgments(extraction, result.preference_judgments, "preferences");

  const skills = requirements.filter((j) => j.category === "skill");
  const byCategory = (category: RequirementCategory) =>
    requirements.filter((j) => j.category === category).map((j) => j.verdict);

  return {
    matchedSkills: skills.filter((j) => j.verdict === "met").map((j) => j.requirement_text),
    missingSkills: skills
      .filter((j) => j.verdict === "not_met" || j.verdict === "partial")
      .map((j) => j.requirement_text),
    experienceFit: aggregateVerdict(byCategory("experience")),
    educationFit: aggregateVerdict(byCategory("education")),
    matchedPreferences: preferences
      .filter((j) => j.verdict === "met")
      .map((j) => j.requirement_text),
    unmatchedPreferences: preferences
      .filter((j) => j.verdict === "not_met")
      .map((j) => j.requirement_text),
    unmetRequirements: requirements
      .filter((j) => j.verdict === "not_met")
      .map((j) => j.requirement_text),
    unknownRequirements: requirements
      .filter((j) => j.verdict === "unknown")
      .map((j) => j.requirement_text),
    criticalGapCount: deriveCriticalGapCount(result),
    evidences: [...requirements, ...preferences].map((j) => ({
      requirement_text: j.requirement_text,
      verdict: j.verdict,
      profile_evidence: j.profile_evidence,
      reason: j.reason,
    })),
  };
}

/** 판정 커버리지 문제 — LLM이 요건을 빠뜨리거나 없는 요건을 판정한 경우 */
export interface JudgmentCoverage {
  /** 판정이 누락된 요건 텍스트 (있으면 재시도·검수 후보) */
  missingRequirements: string[];
  missingPreferences: string[];
  /** extraction에 없는 텍스트를 판정한 항목 (프롬프트 위반 — 원문 복사 규칙) */
  unknownRequirementTexts: string[];
  unknownPreferenceTexts: string[];
}

/**
 * 판정이 요건을 빠짐없이 1:1로 덮는지 검증한다 (순수 함수).
 * structured outputs는 형태만 강제하고 내용 누락은 못 막으므로 서버에서 확인한다.
 */
export function checkJudgmentCoverage(
  extraction: PostingExtraction,
  result: MatchResult
): JudgmentCoverage {
  const diff = (expected: string[], actual: string[]) => {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    return {
      missing: expected.filter((text) => !actualSet.has(text)),
      unknown: actual.filter((text) => !expectedSet.has(text)),
    };
  };

  const req = diff(
    extraction.requirements.map((r) => r.text),
    result.requirement_judgments.map((j) => j.requirement_text)
  );
  const pref = diff(
    extraction.preferences.map((p) => p.text),
    result.preference_judgments.map((j) => j.requirement_text)
  );

  return {
    missingRequirements: req.missing,
    missingPreferences: pref.missing,
    unknownRequirementTexts: req.unknown,
    unknownPreferenceTexts: pref.unknown,
  };
}

/** 커버리지에 문제가 하나라도 있는가 */
export function hasCoverageIssues(coverage: JudgmentCoverage): boolean {
  return (
    coverage.missingRequirements.length > 0 ||
    coverage.missingPreferences.length > 0 ||
    coverage.unknownRequirementTexts.length > 0 ||
    coverage.unknownPreferenceTexts.length > 0
  );
}
