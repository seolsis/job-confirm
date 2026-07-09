import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SCHEMA_VERSION,
  type PostingExtraction,
} from "./schemas";

/**
 * structured outputs JSON 스키마 검증 — AI_ANALYSIS_DESIGN.md 3.2
 *
 * 실제 API에서는 이 스키마를 서버가 강제하지만(output_config.format),
 * 여기서는 Ajv로 같은 스키마를 컴파일해 "스키마가 우리가 의도한 형태를
 * 정확히 허용/거부하는지"를 검증한다.
 */

// structured outputs와 유사하게 동작하도록 기본 설정 사용 (coerce 없음)
const ajv = new Ajv({ allowUnionTypes: true });
const validate = ajv.compile(EXTRACTION_JSON_SCHEMA as unknown as object);

/**
 * 온전한 유효 픽스처.
 * PostingExtraction 타입 명시로 "TS 타입 ↔ JSON 스키마" 일치를 양방향 검증한다:
 *  - 컴파일 타임: 이 객체가 TS 타입을 만족하는지 (필드 누락/오타 시 빌드 실패)
 *  - 런타임: 같은 객체가 JSON 스키마를 통과하는지 (아래 첫 테스트)
 */
function makeValid(): PostingExtraction {
  return {
    company_name: "테스트컴퍼니",
    job_title: "백엔드 개발자",
    job_category: "서버 개발",
    responsibilities: ["API 개발", "DB 설계"],
    requirements: [
      {
        text: "Python 3년 이상 실무 경험",
        category: "experience",
        evidence: "Python 3년 이상 실무 경험",
      },
    ],
    preferences: [{ text: "AWS 경험", category: "skill", evidence: "AWS 경험" }],
    required_skills: ["Python", "Django"],
    tech_stack: ["AWS"],
    experience_level: { type: "mid", min_years: 3, max_years: 7, raw_text: "3~7년" },
    education: { level: "bachelor", raw_text: "학사 이상" },
    location: "서울 강남구",
    salary: { min: 5000, max: 7000, is_negotiable: false, raw_text: "5,000~7,000만원" },
    deadline: { date: "2026-08-31", is_rolling: false, raw_text: "~2026.08.31" },
    keywords: ["백엔드", "Python", "커머스"],
    extraction_notes: null,
  };
}

/** 얕은 복사 후 일부 필드를 조작하기 위한 헬퍼 */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("EXTRACTION_JSON_SCHEMA — 유효 데이터", () => {
  it("온전한 구조화 결과를 통과시킨다", () => {
    const valid = validate(makeValid());
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("null 허용 필드는 null을 허용한다 (설계 원칙 4: 없는 정보는 없다고 한다)", () => {
    const doc = makeValid();
    doc.company_name = null;
    doc.job_title = null;
    doc.job_category = null;
    doc.location = null;
    doc.extraction_notes = null;
    doc.experience_level = { type: null, min_years: null, max_years: null, raw_text: null };
    doc.education = { level: null, raw_text: null };
    doc.salary = { min: null, max: null, is_negotiable: null, raw_text: null };
    doc.deadline = { date: null, is_rolling: true, raw_text: null };

    expect(validate(doc)).toBe(true);
  });

  it("빈 배열들을 허용한다 (요건이 없는 공고)", () => {
    const doc = makeValid();
    doc.responsibilities = [];
    doc.requirements = [];
    doc.preferences = [];
    doc.required_skills = [];
    doc.tech_stack = [];
    doc.keywords = [];

    expect(validate(doc)).toBe(true);
  });
});

describe("EXTRACTION_JSON_SCHEMA — required 누락 거부", () => {
  it.each([
    "company_name",
    "requirements",
    "experience_level",
    "deadline",
    "extraction_notes",
  ] as const)("최상위 필드 %s 누락을 거부한다", (field) => {
    const doc = asRecord(makeValid());
    delete doc[field];

    expect(validate(doc)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "required")).toBe(true);
  });

  it("요건 항목의 evidence 누락을 거부한다 (evidence 구조 검증)", () => {
    const doc = makeValid();
    doc.requirements = [
      asRecord({ text: "Python 경험", category: "skill" }) as never, // evidence 없음
    ];

    expect(validate(doc)).toBe(false);
  });

  it("중첩 객체(deadline)의 is_rolling 누락을 거부한다", () => {
    const doc = asRecord(makeValid());
    doc.deadline = { date: null, raw_text: null }; // is_rolling 없음

    expect(validate(doc)).toBe(false);
  });
});

describe("EXTRACTION_JSON_SCHEMA — additionalProperties 거부", () => {
  it("최상위에 스키마 밖 필드가 있으면 거부한다", () => {
    const doc = asRecord(makeValid());
    doc.hallucinated_field = "스키마에 없는 값";

    expect(validate(doc)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "additionalProperties")).toBe(true);
  });

  it("요건 항목 안의 추가 필드도 거부한다", () => {
    const doc = makeValid();
    doc.requirements = [
      asRecord({
        text: "Python",
        category: "skill",
        evidence: "Python",
        confidence: 0.9, // 스키마에 없음
      }) as never,
    ];

    expect(validate(doc)).toBe(false);
  });
});

describe("EXTRACTION_JSON_SCHEMA — enum·타입 검증", () => {
  it("requirements[].category는 정의된 7개 값만 허용한다", () => {
    const doc = makeValid();
    doc.requirements = [
      asRecord({ text: "t", category: "not_a_category", evidence: "t" }) as never,
    ];

    expect(validate(doc)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "enum")).toBe(true);
  });

  it("experience_level.type의 enum 밖 값을 거부한다 (null은 허용)", () => {
    const doc = asRecord(makeValid());
    doc.experience_level = { type: "expert", min_years: null, max_years: null, raw_text: null };
    expect(validate(doc)).toBe(false);

    doc.experience_level = { type: null, min_years: null, max_years: null, raw_text: null };
    expect(validate(doc)).toBe(true);
  });

  it("education.level의 enum 밖 값을 거부한다", () => {
    const doc = asRecord(makeValid());
    doc.education = { level: "elementary", raw_text: null };

    expect(validate(doc)).toBe(false);
  });

  it("null 불가 필드에 null이 오면 거부한다 (deadline.is_rolling, evidence)", () => {
    const doc1 = asRecord(makeValid());
    doc1.deadline = { date: null, is_rolling: null, raw_text: null };
    expect(validate(doc1)).toBe(false);

    const doc2 = makeValid();
    doc2.requirements = [asRecord({ text: "t", category: "skill", evidence: null }) as never];
    expect(validate(doc2)).toBe(false);
  });

  it("타입 위반을 거부한다 (salary.min에 문자열, keywords에 숫자)", () => {
    const doc1 = asRecord(makeValid());
    doc1.salary = { min: "5000만원", max: null, is_negotiable: null, raw_text: null };
    expect(validate(doc1)).toBe(false);

    const doc2 = asRecord(makeValid());
    doc2.keywords = ["백엔드", 123];
    expect(validate(doc2)).toBe(false);
  });
});

describe("TypeScript 타입 ↔ JSON 스키마 일치", () => {
  it("스키마 properties 키 집합 == required 목록 == PostingExtraction 키 집합", () => {
    const schemaProps = Object.keys(EXTRACTION_JSON_SCHEMA.properties).sort();
    const schemaRequired = [...EXTRACTION_JSON_SCHEMA.required].sort();
    // makeValid()는 PostingExtraction 타입으로 컴파일 타임 검증된 완전한 객체다
    const typeKeys = Object.keys(makeValid()).sort();

    // structured outputs 요구사항: 모든 property가 required에 나열돼야 한다
    expect(schemaProps).toEqual(schemaRequired);
    // TS 타입과 스키마가 같은 필드 집합을 가리켜야 한다
    expect(schemaProps).toEqual(typeKeys);
  });

  it("중첩 객체의 키 집합도 타입과 일치한다", () => {
    const doc = makeValid();
    const props = EXTRACTION_JSON_SCHEMA.properties;

    expect(Object.keys(props.experience_level.properties).sort()).toEqual(
      Object.keys(doc.experience_level).sort()
    );
    expect(Object.keys(props.education.properties).sort()).toEqual(
      Object.keys(doc.education).sort()
    );
    expect(Object.keys(props.salary.properties).sort()).toEqual(Object.keys(doc.salary).sort());
    expect(Object.keys(props.deadline.properties).sort()).toEqual(Object.keys(doc.deadline).sort());
    expect(Object.keys(props.requirements.items.properties).sort()).toEqual(
      Object.keys(doc.requirements[0]).sort()
    );
  });

  it("requirements와 preferences는 같은 항목 스키마를 공유한다", () => {
    expect(EXTRACTION_JSON_SCHEMA.properties.requirements.items).toBe(
      EXTRACTION_JSON_SCHEMA.properties.preferences.items
    );
  });

  it("모든 object 노드에 additionalProperties: false가 걸려 있다 (structured outputs 요구사항)", () => {
    const objects: Array<{ additionalProperties?: boolean }> = [
      EXTRACTION_JSON_SCHEMA,
      EXTRACTION_JSON_SCHEMA.properties.experience_level,
      EXTRACTION_JSON_SCHEMA.properties.education,
      EXTRACTION_JSON_SCHEMA.properties.salary,
      EXTRACTION_JSON_SCHEMA.properties.deadline,
      EXTRACTION_JSON_SCHEMA.properties.requirements.items,
    ];
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
    }
  });
});

describe("schema_version 상수", () => {
  it("현재 스키마 버전은 extract-schema-v1이다 (DB posting_extractions.schema_version과 1:1)", () => {
    expect(EXTRACTION_SCHEMA_VERSION).toBe("extract-schema-v1");
  });
});
