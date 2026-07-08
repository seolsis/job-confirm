/**
 * 1단계 공고 구조화 — structured outputs JSON 스키마 + TypeScript 타입.
 * 근거: docs/AI_ANALYSIS_DESIGN.md 3.2 (출력 스키마)
 *
 * 스키마를 바꾸면 SCHEMA_VERSION을 올린다 — 모든 분석 결과에 버전을 남겨
 * 프롬프트/스키마 개선 전후를 회귀 비교할 수 있어야 한다 (설계 원칙 5).
 * DB의 posting_extractions.schema_version과 1:1로 대응한다.
 */

export const EXTRACTION_SCHEMA_VERSION = "extract-schema-v1";

/** 요건/우대 항목의 분류 */
export type RequirementCategory =
  "skill" | "experience" | "education" | "certificate" | "language" | "soft_skill" | "other";

/** 요건/우대 항목 — 2단계 매칭이 이 단위로 판정하므로 항목 분리가 전체 품질을 좌우한다 */
export interface RequirementItem {
  /** 요건 원문 (예: "Python 3년 이상 경험") */
  text: string;
  category: RequirementCategory;
  /** 원문에서 발췌한 근거 문장 — 환각 억제 + "근거 보기" UI + 오답 검수 재료 */
  evidence: string;
}

/** 구조화 결과 전체 (jsonb로 posting_extractions.extracted에 저장) */
export interface PostingExtraction {
  company_name: string | null;
  job_title: string | null;
  job_category: string | null;
  responsibilities: string[];
  requirements: RequirementItem[];
  preferences: RequirementItem[];
  /** 요건에서 뽑은 기술 명사 (정규화: "리액트" → "React") */
  required_skills: string[];
  /** 회사가 쓰는 기술 스택 */
  tech_stack: string[];
  experience_level: {
    type: "entry" | "junior" | "mid" | "senior" | "any" | null;
    min_years: number | null;
    max_years: number | null;
    /** 정규화 값이 틀렸을 때 원문으로 검증하기 위한 보존 필드 */
    raw_text: string | null;
  };
  education: {
    level: "none" | "high_school" | "associate" | "bachelor" | "master" | "phd" | null;
    raw_text: string | null;
  };
  location: string | null;
  salary: {
    /** 만원 단위 */
    min: number | null;
    max: number | null;
    is_negotiable: boolean | null;
    raw_text: string | null;
  };
  deadline: {
    /** YYYY-MM-DD */
    date: string | null;
    /** 상시 채용 여부 */
    is_rolling: boolean;
    raw_text: string | null;
  };
  /** 검색·추천·중복감지용 핵심 키워드 5~10개 */
  keywords: string[];
  /** 추출 중 애매했던 점 (검수용). 채용공고가 아니면 그 사유를 여기에 쓴다 */
  extraction_notes: string | null;
}

/** 요건/우대 항목의 JSON 스키마 (공용) */
const requirementItemSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "요건 원문 (의미 단위로 분리된 한 항목)" },
    category: {
      type: "string",
      enum: ["skill", "experience", "education", "certificate", "language", "soft_skill", "other"],
    },
    evidence: { type: "string", description: "원문에서 그대로 발췌한 근거 문장" },
  },
  required: ["text", "category", "evidence"],
  additionalProperties: false,
} as const;

/**
 * structured outputs용 JSON 스키마 (output_config.format에 전달).
 * 스키마가 강제되므로 "JSON 파싱 실패 → 재시도" 로직이 필요 없다 (6.1).
 * 주의: structured outputs는 모든 object에 additionalProperties:false와
 * required 전체 나열을 요구한다. 수치 제약(minimum 등)은 지원되지 않는다.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    company_name: { type: ["string", "null"], description: "회사명. 원문에 없으면 null" },
    job_title: { type: ["string", "null"], description: "직무명 (예: 백엔드 개발자)" },
    job_category: { type: ["string", "null"], description: "모집 분야 (예: 서버 개발)" },
    responsibilities: {
      type: "array",
      items: { type: "string" },
      description: "주요 업무 (항목별 분리)",
    },
    requirements: {
      type: "array",
      items: requirementItemSchema,
      description: "자격 요건 (필수) — 매칭의 핵심 입력. 의미 단위로 분리",
    },
    preferences: {
      type: "array",
      items: requirementItemSchema,
      description: "우대 사항 — requirements와 동일 구조",
    },
    required_skills: {
      type: "array",
      items: { type: "string" },
      description: "요건에서 뽑은 기술 명사. 한/영 표기 정규화 (예: 리액트 → React)",
    },
    tech_stack: {
      type: "array",
      items: { type: "string" },
      description: "회사가 사용하는 기술 스택",
    },
    experience_level: {
      type: "object",
      properties: {
        type: { type: ["string", "null"], enum: ["entry", "junior", "mid", "senior", "any", null] },
        min_years: { type: ["number", "null"] },
        max_years: { type: ["number", "null"] },
        raw_text: { type: ["string", "null"] },
      },
      required: ["type", "min_years", "max_years", "raw_text"],
      additionalProperties: false,
    },
    education: {
      type: "object",
      properties: {
        level: {
          type: ["string", "null"],
          enum: ["none", "high_school", "associate", "bachelor", "master", "phd", null],
        },
        raw_text: { type: ["string", "null"] },
      },
      required: ["level", "raw_text"],
      additionalProperties: false,
    },
    location: { type: ["string", "null"], description: "근무 지역" },
    salary: {
      type: "object",
      properties: {
        min: { type: ["number", "null"], description: "만원 단위" },
        max: { type: ["number", "null"], description: "만원 단위" },
        is_negotiable: { type: ["boolean", "null"] },
        raw_text: { type: ["string", "null"], description: '"회사 내규에 따름" 등 원문 보존' },
      },
      required: ["min", "max", "is_negotiable", "raw_text"],
      additionalProperties: false,
    },
    deadline: {
      type: "object",
      properties: {
        date: { type: ["string", "null"], description: "YYYY-MM-DD" },
        is_rolling: { type: "boolean", description: "상시 채용 여부" },
        raw_text: { type: ["string", "null"] },
      },
      required: ["date", "is_rolling", "raw_text"],
      additionalProperties: false,
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "핵심 키워드 5~10개 (검색·추천·중복감지용)",
    },
    extraction_notes: {
      type: ["string", "null"],
      description: "추출 중 애매했던 점. 본문이 채용공고가 아니면 그 사유",
    },
  },
  required: [
    "company_name",
    "job_title",
    "job_category",
    "responsibilities",
    "requirements",
    "preferences",
    "required_skills",
    "tech_stack",
    "experience_level",
    "education",
    "location",
    "salary",
    "deadline",
    "keywords",
    "extraction_notes",
  ],
  additionalProperties: false,
} as const;
