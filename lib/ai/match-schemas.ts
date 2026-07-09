/**
 * 2단계 프로필 매칭 — structured outputs JSON 스키마 + TypeScript 타입.
 * 근거: docs/AI_ANALYSIS_DESIGN.md 4.2 (출력 스키마)
 *
 * 스키마를 바꾸면 MATCH_SCHEMA_VERSION을 올린다 — DB의
 * match_analyses.schema_version과 1:1로 대응한다 (설계 원칙 5).
 */

export const MATCH_SCHEMA_VERSION = "match-schema-v1";

/** 요건별 판정 — 점수 산출(M1-11)의 원천. LLM은 범주형 판정만 하고 숫자는 내지 않는다 (설계 원칙 2) */
export type JudgmentVerdict = "met" | "partial" | "not_met" | "unknown";

export interface RequirementJudgment {
  /** 1단계 extraction의 requirements[].text 그대로 — 요건과 판정을 텍스트로 조인한다 */
  requirement_text: string;
  verdict: JudgmentVerdict;
  /** 판정 근거가 된 프로필 항목. unknown이면 null */
  profile_evidence: string | null;
  /** 한 문장 판정 이유 */
  reason: string;
}

export type GapSeverity = "critical" | "moderate" | "minor";

export interface Gap {
  /** 무엇이 부족한가 */
  gap: string;
  /** 필수요건 미충족 = critical */
  severity: GapSeverity;
  related_requirement: string | null;
}

export interface Strength {
  strength: string;
  /** 자소서·면접 어필 방법 */
  how_to_appeal: string;
}

export type LearnPriority = "high" | "medium" | "low";

export interface SkillToLearn {
  skill: string;
  priority: LearnPriority;
  /** 왜 필요한가 (어느 요건과 연결되는가) */
  reason: string;
  /** 학습 방향 한 줄 제안 */
  suggestion: string;
}

export interface CertificateToPrepare {
  certificate: string;
  reason: string;
  priority: LearnPriority;
}

export type QuestionSource = "posting" | "profile_gap" | "profile_strength";

export interface ExpectedInterviewQuestion {
  question: string;
  /** 면접관의 의도 */
  intent: string;
  /** 질문의 출처 — UI에서 준비 우선순위 구분용 (4.2 설계 포인트) */
  based_on: QuestionSource;
}

export type ActionTimeframe = "before_apply" | "before_document" | "before_interview";

export interface ActionItem {
  action: string;
  /** 취준탭 카드 상태와 연결된다 (예: 면접 예정 → before_interview 재노출) */
  timeframe: ActionTimeframe;
  expected_impact: string;
}

/** 매칭 분석 결과 전체 (jsonb로 match_analyses.result에 저장) */
export interface MatchResult {
  requirement_judgments: RequirementJudgment[];
  /** 우대사항별 판정 — 동일 구조 */
  preference_judgments: RequirementJudgment[];
  /** 적합한 이유 3~5개 — profile_evidence가 있는 것만 (과장 금지) */
  fit_reasons: string[];
  gaps: Gap[];
  strengths: Strength[];
  skills_to_learn: SkillToLearn[];
  certificates_to_prepare: CertificateToPrepare[];
  expected_interview_questions: ExpectedInterviewQuestion[];
  action_items: ActionItem[];
  /** 종합 코멘트 2~3문장 (점수와 함께 상단 노출) */
  overall_comment: string;
}

/** 요건/우대 판정 항목의 JSON 스키마 (공용) */
const judgmentSchema = {
  type: "object",
  properties: {
    requirement_text: {
      type: "string",
      description: "입력 공고 JSON의 requirements[].text(또는 preferences[].text)를 그대로 복사",
    },
    verdict: { type: "string", enum: ["met", "partial", "not_met", "unknown"] },
    profile_evidence: {
      type: ["string", "null"],
      description: "판정 근거가 된 프로필 항목. unknown이면 null",
    },
    reason: { type: "string", description: "한 문장 판정 이유" },
  },
  required: ["requirement_text", "verdict", "profile_evidence", "reason"],
  additionalProperties: false,
} as const;

/**
 * structured outputs용 JSON 스키마 (output_config.format에 전달).
 * 주의: 모든 object에 additionalProperties:false와 required 전체 나열이 필요하다.
 */
export const MATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    requirement_judgments: {
      type: "array",
      items: judgmentSchema,
      description: "자격 요건별 판정 — 점수 산출의 원천. 모든 요건에 하나씩",
    },
    preference_judgments: {
      type: "array",
      items: judgmentSchema,
      description: "우대사항별 판정 — 동일 구조. 모든 우대 항목에 하나씩",
    },
    fit_reasons: {
      type: "array",
      items: { type: "string" },
      description: "적합한 이유 3~5개. profile_evidence가 있는 것만 (과장 금지)",
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gap: { type: "string", description: "무엇이 부족한가" },
          severity: {
            type: "string",
            enum: ["critical", "moderate", "minor"],
            description: "필수요건 미충족(not_met)이면 critical",
          },
          related_requirement: { type: ["string", "null"] },
        },
        required: ["gap", "severity", "related_requirement"],
        additionalProperties: false,
      },
      description: "부족한 역량",
    },
    strengths: {
      type: "array",
      items: {
        type: "object",
        properties: {
          strength: { type: "string" },
          how_to_appeal: { type: "string", description: "자소서·면접 어필 방법" },
        },
        required: ["strength", "how_to_appeal"],
        additionalProperties: false,
      },
      description: "강점 (어필 포인트)",
    },
    skills_to_learn: {
      type: "array",
      items: {
        type: "object",
        properties: {
          skill: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string", description: "왜 필요한가 (어느 요건과 연결되는가)" },
          suggestion: { type: "string", description: "학습 방향 한 줄 제안" },
        },
        required: ["skill", "priority", "reason", "suggestion"],
        additionalProperties: false,
      },
      description: "공부해야 할 기술",
    },
    certificates_to_prepare: {
      type: "array",
      items: {
        type: "object",
        properties: {
          certificate: { type: "string" },
          reason: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["certificate", "reason", "priority"],
        additionalProperties: false,
      },
      description: "준비해야 할 자격증",
    },
    expected_interview_questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          intent: { type: "string", description: "면접관의 의도" },
          based_on: { type: "string", enum: ["posting", "profile_gap", "profile_strength"] },
        },
        required: ["question", "intent", "based_on"],
        additionalProperties: false,
      },
      description: "예상 면접 질문",
    },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          timeframe: {
            type: "string",
            enum: ["before_apply", "before_document", "before_interview"],
          },
          expected_impact: { type: "string" },
        },
        required: ["action", "timeframe", "expected_impact"],
        additionalProperties: false,
      },
      description: "합격 가능성을 높이기 위한 행동",
    },
    overall_comment: {
      type: "string",
      description: "종합 코멘트 2~3문장 (냉정하지만 건설적으로)",
    },
  },
  required: [
    "requirement_judgments",
    "preference_judgments",
    "fit_reasons",
    "gaps",
    "strengths",
    "skills_to_learn",
    "certificates_to_prepare",
    "expected_interview_questions",
    "action_items",
    "overall_comment",
  ],
  additionalProperties: false,
} as const;
