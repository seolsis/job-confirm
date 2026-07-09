import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { ProfileSnapshot } from "@/lib/db/profile-snapshots";

import { MATCH_JSON_SCHEMA, MATCH_SCHEMA_VERSION, type MatchResult } from "./match-schemas";
import { analyzeMatch, MATCH_MODEL_ID, MatchError, parseMatchResult } from "./match";
import { MATCH_PROMPT_VERSION } from "./prompts/match-v1";
import type { PostingExtraction } from "./schemas";

/**
 * analyzeMatch() 단위 테스트 — 실제 Anthropic API는 절대 호출하지 않는다.
 * extract.test.ts와 대칭 — 요청 파라미터(6.1 표의 매칭 열)와
 * stop_reason별 처리·재시도 정책(8장)을 fake 클라이언트로 검증한다.
 */

const sampleExtraction: PostingExtraction = {
  company_name: "테스트컴퍼니",
  job_title: "백엔드 개발자",
  job_category: "서버 개발",
  responsibilities: ["API 서버 개발"],
  requirements: [
    { text: "Python 3년 이상 실무 경험", category: "experience", evidence: "Python 3년 이상" },
  ],
  preferences: [{ text: "AWS 운영 경험", category: "skill", evidence: "AWS 운영 경험" }],
  required_skills: ["Python"],
  tech_stack: ["Django"],
  experience_level: { type: "mid", min_years: 3, max_years: null, raw_text: "경력 3년 이상" },
  education: { level: null, raw_text: null },
  location: "서울",
  salary: { min: null, max: null, is_negotiable: null, raw_text: null },
  deadline: { date: "2026-08-31", is_rolling: false, raw_text: "마감: 2026-08-31" },
  keywords: ["백엔드", "Python"],
  extraction_notes: null,
};

const sampleProfile: ProfileSnapshot = {
  desired_job: "백엔드 개발자",
  desired_conditions: {},
  educations: [
    { school: "한국대", major: "컴퓨터공학", degree: "학사", status: "졸업", period: null },
  ],
  experiences: [
    {
      company: "지원자테크",
      role: "백엔드 개발",
      period_months: 40,
      description: "Django 커머스 API",
    },
  ],
  skills: [{ name: "Python", level: "상", years: 3 }],
  certificates: [],
  languages: [],
  projects: [],
};

const sampleResult: MatchResult = {
  requirement_judgments: [
    {
      requirement_text: "Python 3년 이상 실무 경험",
      verdict: "met",
      profile_evidence: "경력: 지원자테크 백엔드 40개월 — Django 커머스 API",
      reason: "요구 기간을 초과하는 직접 경험이 있다",
    },
  ],
  preference_judgments: [
    {
      requirement_text: "AWS 운영 경험",
      verdict: "unknown",
      profile_evidence: null,
      reason: "프로필에 인프라 운영 정보가 없다",
    },
  ],
  fit_reasons: ["Python 백엔드 실무 40개월로 필수 경력 요건을 충족한다"],
  gaps: [],
  strengths: [{ strength: "커머스 도메인 경험", how_to_appeal: "거래액 규모를 수치로 제시" }],
  skills_to_learn: [
    { skill: "AWS", priority: "medium", reason: "우대사항", suggestion: "ECS 배포 실습" },
  ],
  certificates_to_prepare: [],
  expected_interview_questions: [
    { question: "대용량 트래픽 경험은?", intent: "실무 깊이 확인", based_on: "posting" },
  ],
  action_items: [
    { action: "AWS 경험 보완", timeframe: "before_apply", expected_impact: "우대사항 충족" },
  ],
  overall_comment: "필수 요건은 충족한다. AWS 우대사항을 보완하면 경쟁력이 높아진다.",
};

interface FakeTurn {
  stop_reason: string;
  text?: string;
  throws?: Error;
}

function makeFakeClient(sequence: FakeTurn[]): {
  client: Anthropic;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const fake = {
    messages: {
      stream(params: Record<string, unknown>) {
        calls.push(params);
        const turn = sequence[Math.min(calls.length - 1, sequence.length - 1)];
        return {
          async finalMessage() {
            if (turn.throws) throw turn.throws;
            return {
              stop_reason: turn.stop_reason,
              content: turn.text !== undefined ? [{ type: "text", text: turn.text }] : [],
              usage: {
                input_tokens: 3000,
                output_tokens: 2000,
                cache_read_input_tokens: 2500,
                cache_creation_input_tokens: 80,
              },
            };
          },
        };
      },
    },
  };
  return { client: fake as unknown as Anthropic, calls };
}

const okTurn: FakeTurn = { stop_reason: "end_turn", text: JSON.stringify(sampleResult) };
const sampleInput = { extraction: sampleExtraction, profileSnapshot: sampleProfile };

describe("analyzeMatch — 성공 케이스", () => {
  it("매칭 결과를 파싱해 반환한다", async () => {
    const { client } = makeFakeClient([okTurn]);
    const output = await analyzeMatch(client, sampleInput);

    expect(output.result).toEqual(sampleResult);
  });

  it("model_id / prompt_version / schema_version을 결과에 그대로 싣는다 (설계 원칙 5)", async () => {
    const { client } = makeFakeClient([okTurn]);
    const output = await analyzeMatch(client, sampleInput);

    expect(output.modelId).toBe(MATCH_MODEL_ID);
    expect(output.promptVersion).toBe(MATCH_PROMPT_VERSION);
    expect(output.schemaVersion).toBe(MATCH_SCHEMA_VERSION);
  });

  it("token_usage를 매핑한다 (6.2 사용량 기록)", async () => {
    const { client } = makeFakeClient([okTurn]);
    const output = await analyzeMatch(client, sampleInput);

    expect(output.tokenUsage).toEqual({
      input: 3000,
      output: 2000,
      cache_read: 2500,
      cache_creation: 80,
    });
  });
});

describe("analyzeMatch — 요청 파라미터 (6.1 호출 파라미터 표의 매칭 열)", () => {
  async function capture(): Promise<Record<string, unknown>> {
    const { client, calls } = makeFakeClient([okTurn]);
    await analyzeMatch(client, sampleInput);
    return calls[0];
  }

  it("모델·max_tokens 16k·adaptive thinking·effort high를 사용한다", async () => {
    const params = await capture();

    expect(params.model).toBe("claude-opus-4-8");
    expect(params.max_tokens).toBe(16000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect((params.output_config as Record<string, unknown>).effort).toBe("high");
  });

  it("structured outputs로 매칭 스키마를 강제한다", async () => {
    const params = await capture();
    const format = (params.output_config as { format: Record<string, unknown> }).format;

    expect(format.type).toBe("json_schema");
    expect(format.schema).toBe(MATCH_JSON_SCHEMA); // 동일 객체 참조 — 스키마 변형 없음
  });

  it("고정 시스템 프롬프트에 cache_control을 건다 (3.3)", async () => {
    const params = await capture();
    const system = params.system as Array<Record<string, unknown>>;

    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("공고 JSON과 프로필 스냅샷 JSON을 전부 user 메시지에 담는다 (4.3)", async () => {
    const params = await capture();
    const messages = params.messages as Array<{ role: string; content: string }>;

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("구조화된 채용공고");
    expect(messages[0].content).toContain("테스트컴퍼니"); // extraction 내용
    expect(messages[0].content).toContain("지원자 프로필");
    expect(messages[0].content).toContain("지원자테크"); // 프로필 내용
    // 시스템 프롬프트에는 가변 값이 섞이지 않는다 (캐시 무효화 방지)
    const system = params.system as Array<{ text: string }>;
    expect(system[0].text).not.toContain("테스트컴퍼니");
    expect(system[0].text).not.toContain("지원자테크");
  });
});

describe("analyzeMatch — stop_reason별 처리와 재시도 (8장)", () => {
  it("refusal: 1회 재시도 후 성공하면 결과를 반환한다", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "refusal" }, okTurn]);
    const output = await analyzeMatch(client, sampleInput);

    expect(output.result.overall_comment).toContain("필수 요건은 충족한다");
    expect(calls).toHaveLength(2);
  });

  it("refusal: 재시도까지 거부되면 MatchError(refusal)", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "refusal" }]);
    const error = await analyzeMatch(client, sampleInput).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MatchError);
    expect((error as MatchError).code).toBe("refusal");
    expect(calls).toHaveLength(2); // 최초 1회 + 재시도 1회
  });

  it("max_tokens: 재시도도 잘리면 MatchError(truncated)", async () => {
    const { client, calls } = makeFakeClient([
      { stop_reason: "max_tokens", text: '{"requirement_judgments": [' },
    ]);
    const error = await analyzeMatch(client, sampleInput).catch((e: unknown) => e);

    expect((error as MatchError).code).toBe("truncated");
    expect(calls).toHaveLength(2);
  });

  it("maxRetries: 0이면 재시도 없이 즉시 실패한다", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "refusal" }]);
    const error = await analyzeMatch(client, sampleInput, { maxRetries: 0 }).catch(
      (e: unknown) => e
    );

    expect((error as MatchError).code).toBe("refusal");
    expect(calls).toHaveLength(1);
  });

  it("API 오류(429/5xx 등 SDK 예외)는 재시도하지 않고 그대로 전파한다", async () => {
    const apiError = new Error("rate limited");
    const { client, calls } = makeFakeClient([{ stop_reason: "end_turn", throws: apiError }]);
    const error = await analyzeMatch(client, sampleInput).catch((e: unknown) => e);

    expect(error).toBe(apiError);
    expect(calls).toHaveLength(1);
  });
});

describe("parseMatchResult (순수 함수)", () => {
  it("유효한 JSON을 그대로 파싱한다", () => {
    expect(parseMatchResult(JSON.stringify(sampleResult))).toEqual(sampleResult);
  });

  it("깨진 JSON이면 MatchError(invalid_json)", () => {
    try {
      parseMatchResult("{broken");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MatchError);
      expect((e as MatchError).code).toBe("invalid_json");
    }
  });
});
