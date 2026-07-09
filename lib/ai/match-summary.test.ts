import { describe, expect, it } from "vitest";

import type { JudgmentVerdict, MatchResult, RequirementJudgment } from "./match-schemas";
import {
  aggregateVerdict,
  categorizeJudgments,
  checkJudgmentCoverage,
  deriveCriticalGapCount,
  hasCoverageIssues,
  summarizeMatch,
} from "./match-summary";
import type { PostingExtraction } from "./schemas";

/**
 * 매칭 요약·정합성 검증 단위 테스트 (M1-10) — 전부 순수 함수, LLM·DB 없음.
 * 판정(verdict) 조합별 시나리오로 요약이 결정적으로 도출되는지 검증한다.
 */

/** 카테고리 4종(기술 2 + 경력 1 + 학력 1) 요건과 우대 2종을 가진 공고 */
const extraction: PostingExtraction = {
  company_name: "테스트컴퍼니",
  job_title: "백엔드 개발자",
  job_category: "서버 개발",
  responsibilities: ["API 서버 개발"],
  requirements: [
    { text: "Python 기반 백엔드 개발 경험", category: "skill", evidence: "Python 백엔드" },
    { text: "RDBMS 설계 및 운영 경험", category: "skill", evidence: "RDBMS 설계" },
    { text: "관련 업계 경력 3년 이상", category: "experience", evidence: "경력 3년 이상" },
    { text: "학사 학위 이상", category: "education", evidence: "학사 이상" },
  ],
  preferences: [
    { text: "AWS 운영 경험", category: "skill", evidence: "AWS 운영" },
    { text: "정보처리기사 자격증", category: "certificate", evidence: "정보처리기사" },
  ],
  required_skills: ["Python", "RDBMS"],
  tech_stack: ["Django", "PostgreSQL"],
  experience_level: { type: "mid", min_years: 3, max_years: null, raw_text: "경력 3년 이상" },
  education: { level: "bachelor", raw_text: "학사 이상" },
  location: "서울",
  salary: { min: null, max: null, is_negotiable: null, raw_text: null },
  deadline: { date: "2026-08-31", is_rolling: false, raw_text: null },
  keywords: ["백엔드", "Python"],
  extraction_notes: null,
};

/** 요건 텍스트 → 판정 하나 생성 */
function judge(
  requirement_text: string,
  verdict: JudgmentVerdict,
  profile_evidence: string | null = verdict === "unknown" ? null : "프로필 근거"
): RequirementJudgment {
  return { requirement_text, verdict, profile_evidence, reason: `${verdict} 판정 이유` };
}

/** requirements 4건 + preferences 2건의 verdict를 지정해 MatchResult를 만든다 */
function makeResult(
  requirementVerdicts: [JudgmentVerdict, JudgmentVerdict, JudgmentVerdict, JudgmentVerdict],
  preferenceVerdicts: [JudgmentVerdict, JudgmentVerdict]
): MatchResult {
  return {
    requirement_judgments: extraction.requirements.map((r, i) =>
      judge(r.text, requirementVerdicts[i])
    ),
    preference_judgments: extraction.preferences.map((p, i) =>
      judge(p.text, preferenceVerdicts[i])
    ),
    fit_reasons: [],
    gaps: [],
    strengths: [],
    skills_to_learn: [],
    certificates_to_prepare: [],
    expected_interview_questions: [],
    action_items: [],
    overall_comment: "테스트 결과",
  };
}

describe("summarizeMatch — 시나리오", () => {
  it("모든 조건 만족: 전 요건 met → 불일치·critical gap 없음", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "met", "met", "met"], ["met", "met"])
    );

    expect(summary.matchedSkills).toEqual([
      "Python 기반 백엔드 개발 경험",
      "RDBMS 설계 및 운영 경험",
    ]);
    expect(summary.missingSkills).toEqual([]);
    expect(summary.experienceFit).toBe("met");
    expect(summary.educationFit).toBe("met");
    expect(summary.matchedPreferences).toEqual(["AWS 운영 경험", "정보처리기사 자격증"]);
    expect(summary.unmatchedPreferences).toEqual([]);
    expect(summary.unmetRequirements).toEqual([]);
    expect(summary.unknownRequirements).toEqual([]);
    expect(summary.criticalGapCount).toBe(0);
  });

  it("기술 스택 일부 일치: met 1 + not_met 1 → 매칭/부족으로 나뉜다", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "not_met", "met", "met"], ["met", "met"])
    );

    expect(summary.matchedSkills).toEqual(["Python 기반 백엔드 개발 경험"]);
    expect(summary.missingSkills).toEqual(["RDBMS 설계 및 운영 경험"]);
    expect(summary.unmetRequirements).toEqual(["RDBMS 설계 및 운영 경험"]);
    expect(summary.criticalGapCount).toBe(1);
  });

  it("필수 기술 부족: 기술 요건 전부 not_met → criticalGapCount에 집계된다", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["not_met", "not_met", "met", "met"], ["met", "met"])
    );

    expect(summary.matchedSkills).toEqual([]);
    expect(summary.missingSkills).toEqual([
      "Python 기반 백엔드 개발 경험",
      "RDBMS 설계 및 운영 경험",
    ]);
    expect(summary.criticalGapCount).toBe(2);
  });

  it("경력 조건 불일치: experience not_met → experienceFit not_met", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "met", "not_met", "met"], ["met", "met"])
    );

    expect(summary.experienceFit).toBe("not_met");
    expect(summary.educationFit).toBe("met");
    expect(summary.unmetRequirements).toEqual(["관련 업계 경력 3년 이상"]);
  });

  it("학력 조건 불일치: education not_met → educationFit not_met", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "met", "met", "not_met"], ["met", "met"])
    );

    expect(summary.educationFit).toBe("not_met");
    expect(summary.experienceFit).toBe("met");
  });

  it("우대사항 매칭: met만 matchedPreferences, unknown은 불이익 없음(unmatched 제외)", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "met", "met", "met"], ["met", "unknown"])
    );

    expect(summary.matchedPreferences).toEqual(["AWS 운영 경험"]);
    expect(summary.unmatchedPreferences).toEqual([]); // unknown ≠ not_met (4.2 설계 포인트)
  });

  it("partial 기술은 부족한 기술로 분류하되 불일치 조건에는 넣지 않는다", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["partial", "met", "met", "met"], ["met", "met"])
    );

    expect(summary.missingSkills).toEqual(["Python 기반 백엔드 개발 경험"]);
    expect(summary.unmetRequirements).toEqual([]); // partial은 not_met이 아니다
    expect(summary.criticalGapCount).toBe(0);
  });

  it("unknown 요건은 unknownRequirements로 분리된다 (프로필 보완 유도)", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "met", "unknown", "unknown"], ["met", "met"])
    );

    expect(summary.unknownRequirements).toEqual(["관련 업계 경력 3년 이상", "학사 학위 이상"]);
    expect(summary.experienceFit).toBe("unknown");
    expect(summary.educationFit).toBe("unknown");
    expect(summary.criticalGapCount).toBe(0); // unknown은 깎지 않는다
  });

  it("분석 근거(evidence): 필수+우대 전 판정의 근거를 순서대로 싣는다", () => {
    const summary = summarizeMatch(
      extraction,
      makeResult(["met", "met", "met", "met"], ["met", "met"])
    );

    expect(summary.evidences).toHaveLength(6);
    expect(summary.evidences[0]).toEqual({
      requirement_text: "Python 기반 백엔드 개발 경험",
      verdict: "met",
      profile_evidence: "프로필 근거",
      reason: "met 판정 이유",
    });
  });
});

describe("aggregateVerdict — 카테고리 종합 판정 (최악 값 우선)", () => {
  it("not_met > partial > unknown > met 순으로 보수적으로 취한다", () => {
    expect(aggregateVerdict(["met", "not_met", "partial"])).toBe("not_met");
    expect(aggregateVerdict(["met", "partial", "unknown"])).toBe("partial");
    expect(aggregateVerdict(["met", "unknown"])).toBe("unknown");
    expect(aggregateVerdict(["met", "met"])).toBe("met");
  });

  it("요건이 없으면 null", () => {
    expect(aggregateVerdict([])).toBeNull();
  });
});

describe("categorizeJudgments / deriveCriticalGapCount", () => {
  it("extraction 요건과 텍스트로 조인해 카테고리를 붙인다", () => {
    const result = makeResult(["met", "met", "met", "met"], ["met", "met"]);
    const categorized = categorizeJudgments(
      extraction,
      result.requirement_judgments,
      "requirements"
    );

    expect(categorized.map((j) => j.category)).toEqual([
      "skill",
      "skill",
      "experience",
      "education",
    ]);
  });

  it("요건에 없는 텍스트를 판정한 항목은 category null", () => {
    const categorized = categorizeJudgments(
      extraction,
      [judge("공고에 없는 요건", "met")],
      "requirements"
    );
    expect(categorized[0].category).toBeNull();
  });

  it("criticalGapCount = 필수요건 not_met 수 (7.2 발췌 컬럼 정의)", () => {
    expect(
      deriveCriticalGapCount(
        makeResult(["not_met", "not_met", "partial", "met"], ["not_met", "met"])
      )
    ).toBe(2); // 우대 not_met은 세지 않는다
  });
});

describe("checkJudgmentCoverage — 판정 누락·초과 검증", () => {
  it("1:1로 덮으면 문제 없음", () => {
    const coverage = checkJudgmentCoverage(
      extraction,
      makeResult(["met", "met", "met", "met"], ["met", "met"])
    );

    expect(coverage).toEqual({
      missingRequirements: [],
      missingPreferences: [],
      unknownRequirementTexts: [],
      unknownPreferenceTexts: [],
    });
    expect(hasCoverageIssues(coverage)).toBe(false);
  });

  it("판정이 누락된 요건과 공고에 없는 텍스트를 잡아낸다", () => {
    const result = makeResult(["met", "met", "met", "met"], ["met", "met"]);
    result.requirement_judgments = [
      result.requirement_judgments[0],
      judge("LLM이 지어낸 요건", "met"),
    ];

    const coverage = checkJudgmentCoverage(extraction, result);

    expect(coverage.missingRequirements).toEqual([
      "RDBMS 설계 및 운영 경험",
      "관련 업계 경력 3년 이상",
      "학사 학위 이상",
    ]);
    expect(coverage.unknownRequirementTexts).toEqual(["LLM이 지어낸 요건"]);
    expect(hasCoverageIssues(coverage)).toBe(true);
  });

  it("우대사항 누락도 잡아낸다", () => {
    const result = makeResult(["met", "met", "met", "met"], ["met", "met"]);
    result.preference_judgments = [result.preference_judgments[0]];

    const coverage = checkJudgmentCoverage(extraction, result);

    expect(coverage.missingPreferences).toEqual(["정보처리기사 자격증"]);
    expect(hasCoverageIssues(coverage)).toBe(true);
  });
});
