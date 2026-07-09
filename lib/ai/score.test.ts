import { describe, expect, it } from "vitest";

import type { JudgmentVerdict, MatchResult, RequirementJudgment } from "./match-schemas";
import { DEFAULT_SCORE_CONFIG, fitScore, gradeForScore, scoreMatch, sectionScore } from "./score";
import type { PostingExtraction } from "./schemas";

/**
 * 점수 산식 단위 테스트 (M1-11) — AI_ANALYSIS_DESIGN.md 5.2 그대로.
 * 전부 순수 함수 — 같은 판정이면 항상 같은 점수 (5.1: LLM에게 점수를 직접 안 시키는 이유).
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

function judge(requirement_text: string, verdict: JudgmentVerdict): RequirementJudgment {
  return {
    requirement_text,
    verdict,
    profile_evidence: verdict === "unknown" ? null : "프로필 근거",
    reason: `${verdict} 판정 이유`,
  };
}

/** requirements 4건(skill, skill, experience, education) + preferences 2건의 verdict 지정 */
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

describe("scoreMatch — 산식 (5.2)", () => {
  it("전 항목 met이면 100점 recommend (①70 + ②20 + ③10)", () => {
    const score = scoreMatch(extraction, makeResult(["met", "met", "met", "met"], ["met", "met"]));

    expect(score).toEqual({
      score: 100,
      grade: "recommend",
      scoreBreakdown: { requirements: 70, preferences: 20, fit: 10 },
      criticalGapCount: 0,
    });
  });

  it("혼합 판정: met/partial/not_met/unknown + 우대 met/not_met → 47점 prepare", () => {
    // ① unknown 분모 제외: 판정 대상 3건, Σ = 1 + 0.5 + 0 = 1.5 → 70 × 1.5/3 = 35
    // ② Σ = 1/2 → 10
    // ③ 경력(not_met) 0 + 학력(unknown) 4×0.5 = 2
    const score = scoreMatch(
      extraction,
      makeResult(["met", "partial", "not_met", "unknown"], ["met", "not_met"])
    );

    expect(score.score).toBe(47); // 35 + 10 + 2
    expect(score.grade).toBe("prepare");
    expect(score.scoreBreakdown).toEqual({ requirements: 35, preferences: 10, fit: 2 });
    expect(score.criticalGapCount).toBe(1);
  });

  it("unknown은 0점이 아니라 분모에서 빠진다 — 나머지가 전부 met이면 ①은 만점", () => {
    const score = scoreMatch(
      extraction,
      makeResult(["met", "met", "met", "unknown"], ["met", "met"])
    );

    // ① = 70 × 3/3 = 70 (unknown을 0으로 치면 52.5가 됐을 것)
    expect(score.scoreBreakdown?.requirements).toBe(70);
    // ③ 경력 met 6 + 학력 unknown 2 = 8
    expect(score.scoreBreakdown?.fit).toBe(8);
    expect(score.score).toBe(98);
  });

  it("반올림: ①52.5 + ②20 + ③7 = 79.5 → 80점 recommend", () => {
    // ① [met, partial, partial, met] Σ=3, /4 → 52.5
    // ② [met, unknown] → 판정 대상 1건 Σ=1 → 20
    // ③ 경력 partial 3 + 학력 met 4 = 7
    const score = scoreMatch(
      extraction,
      makeResult(["met", "partial", "partial", "met"], ["met", "unknown"])
    );

    expect(score.scoreBreakdown).toEqual({ requirements: 52.5, preferences: 20, fit: 7 });
    expect(score.score).toBe(80);
    expect(score.grade).toBe("recommend");
  });

  it("critical gap이 있어도 점수는 산식대로 — 뱃지용 카운트만 병기한다 (5.2)", () => {
    const score = scoreMatch(
      extraction,
      makeResult(["not_met", "met", "met", "met"], ["met", "met"])
    );

    expect(score.score).toBe(83); // ① 70×3/4=52.5 + ② 20 + ③ 10 = 82.5 → 83
    expect(score.grade).toBe("recommend");
    expect(score.criticalGapCount).toBe(1); // 점수가 높아도 미충족 1건을 숨기지 않는다
  });
});

describe("scoreMatch — insufficient_profile 게이트", () => {
  it("필수요건 unknown 비율 50% 초과 → 점수 대신 프로필 부족 상태", () => {
    const score = scoreMatch(
      extraction,
      makeResult(["unknown", "unknown", "unknown", "not_met"], ["met", "met"])
    );

    expect(score).toEqual({
      score: null,
      grade: "insufficient_profile",
      scoreBreakdown: null,
      criticalGapCount: 1, // 게이트에 걸려도 카운트는 계산한다
    });
  });

  it("정확히 50%는 통과한다 (초과 조건)", () => {
    const score = scoreMatch(
      extraction,
      makeResult(["met", "met", "unknown", "unknown"], ["not_met", "not_met"])
    );

    // ① 70×2/2=70, ② 0, ③ 경력 unknown 3 + 학력 unknown 2 = 5 → 75
    expect(score.score).toBe(75);
    expect(score.grade).toBe("challenge");
  });

  it("insufficientUnknownRatio를 덮어쓸 수 있다 (운영 튜닝 값)", () => {
    const strict = scoreMatch(
      extraction,
      makeResult(["met", "met", "met", "unknown"], ["met", "met"]),
      { ...DEFAULT_SCORE_CONFIG, insufficientUnknownRatio: 0.2 }
    );

    expect(strict.grade).toBe("insufficient_profile"); // 25% > 20%
  });
});

describe("gradeForScore — 등급 구간 (5.2)", () => {
  it("80~100 recommend │ 60~79 challenge │ 40~59 prepare │ 0~39 large_gap", () => {
    expect(gradeForScore(100)).toBe("recommend");
    expect(gradeForScore(80)).toBe("recommend");
    expect(gradeForScore(79)).toBe("challenge");
    expect(gradeForScore(60)).toBe("challenge");
    expect(gradeForScore(59)).toBe("prepare");
    expect(gradeForScore(40)).toBe("prepare");
    expect(gradeForScore(39)).toBe("large_gap");
    expect(gradeForScore(0)).toBe("large_gap");
  });
});

describe("sectionScore / fitScore — 구성 요소", () => {
  it("sectionScore: met=1, partial=0.5, not_met=0 가중 평균", () => {
    expect(sectionScore(["met", "not_met"], 70, 0.5)).toBe(35);
    expect(sectionScore(["partial"], 20, 0.5)).toBe(10);
  });

  it("sectionScore: 항목이 없으면 만점 (감점 사유 없음)", () => {
    expect(sectionScore([], 20, 0.5)).toBe(20);
  });

  it("sectionScore: 전부 unknown이면 절반 (③ unknown 규칙과 동일한 보수적 취급)", () => {
    expect(sectionScore(["unknown", "unknown"], 20, 0.5)).toBe(10);
  });

  it("fitScore: met=만점, unknown=절반, not_met=0, 요건 없음(null)=만점", () => {
    expect(fitScore("met", 6, 0.5)).toBe(6);
    expect(fitScore("unknown", 6, 0.5)).toBe(3);
    expect(fitScore("not_met", 6, 0.5)).toBe(0);
    expect(fitScore("partial", 4, 0.5)).toBe(2);
    expect(fitScore(null, 4, 0.5)).toBe(4);
  });
});

describe("scoreMatch — 우대사항이 없는 공고", () => {
  it("preferences가 빈 공고는 ②를 만점 처리한다 (배점 손해 없음)", () => {
    const noPref: PostingExtraction = { ...extraction, preferences: [] };
    const result = makeResult(["met", "met", "met", "met"], ["met", "met"]);
    result.preference_judgments = [];

    const score = scoreMatch(noPref, result);

    expect(score.scoreBreakdown?.preferences).toBe(20);
    expect(score.score).toBe(100);
  });
});

describe("결정성 — 같은 판정이면 항상 같은 점수 (5.1)", () => {
  it("동일 입력 반복 호출 시 결과가 완전히 같다", () => {
    const result = makeResult(["met", "partial", "not_met", "unknown"], ["met", "not_met"]);
    const first = scoreMatch(extraction, result);
    const second = scoreMatch(extraction, result);

    expect(second).toEqual(first);
  });
});
