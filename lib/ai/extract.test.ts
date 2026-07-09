import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { EXTRACT_PROMPT_VERSION } from "./prompts/extract-v1";
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SCHEMA_VERSION,
  type PostingExtraction,
} from "./schemas";
import {
  ExtractionError,
  EXTRACTION_MODEL_ID,
  extractJobPosting,
  parseExtraction,
} from "./extract";

/**
 * extractJobPosting() 단위 테스트 — 실제 Anthropic API는 절대 호출하지 않는다.
 * 스트리밍 클라이언트(messages.stream → finalMessage)를 fake로 대체해
 * 요청 파라미터와 stop_reason별 처리·재시도 정책(AI_ANALYSIS_DESIGN.md 8장)을 검증한다.
 */

/** 온전한 구조화 결과 픽스처 (PostingExtraction 타입으로 컴파일 타임 검증됨) */
const sampleExtraction: PostingExtraction = {
  company_name: "테스트컴퍼니",
  job_title: "백엔드 개발자",
  job_category: "서버 개발",
  responsibilities: ["커머스 API 서버 개발"],
  requirements: [
    {
      text: "Python 3년 이상 실무 경험",
      category: "experience",
      evidence: "Python 3년 이상 실무 경험",
    },
  ],
  preferences: [{ text: "AWS 운영 경험", category: "skill", evidence: "AWS 운영 경험" }],
  required_skills: ["Python"],
  tech_stack: ["Django"],
  experience_level: { type: "mid", min_years: 3, max_years: null, raw_text: "경력 3년 이상" },
  education: { level: null, raw_text: null },
  location: "서울",
  salary: { min: 5000, max: 7000, is_negotiable: null, raw_text: "5,000~7,000만원" },
  deadline: { date: "2026-08-31", is_rolling: false, raw_text: "마감: 2026-08-31" },
  keywords: ["백엔드", "Python", "테스트컴퍼니"],
  extraction_notes: null,
};

/** fake 응답 한 건의 명세 */
interface FakeTurn {
  stop_reason: string;
  text?: string;
  /** usage 필드를 덮어쓰고 싶을 때 */
  usage?: Partial<Record<string, number>>;
  /** finalMessage가 아예 던져야 할 때 (API 오류 시뮬레이션) */
  throws?: Error;
}

interface FakeClient {
  client: Anthropic;
  /** messages.stream에 전달된 요청 파라미터들 (호출 순서대로) */
  calls: Record<string, unknown>[];
}

/** 호출마다 sequence를 하나씩 소비하는 fake 클라이언트 (마지막 항목 반복) */
function makeFakeClient(sequence: FakeTurn[]): FakeClient {
  const calls: Record<string, unknown>[] = [];
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
                input_tokens: 1200,
                output_tokens: 800,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 50,
                ...turn.usage,
              },
            };
          },
        };
      },
    },
  };
  return { client: fake as unknown as Anthropic, calls };
}

const okTurn: FakeTurn = { stop_reason: "end_turn", text: JSON.stringify(sampleExtraction) };

describe("extractJobPosting — 성공 케이스", () => {
  it("구조화 결과를 파싱해 반환한다", async () => {
    const { client } = makeFakeClient([okTurn]);
    const result = await extractJobPosting(client, { bodyText: "공고 본문" });

    expect(result.extracted).toEqual(sampleExtraction);
  });

  it("model_id / prompt_version / schema_version을 결과에 그대로 싣는다 (설계 원칙 5)", async () => {
    const { client } = makeFakeClient([okTurn]);
    const result = await extractJobPosting(client, { bodyText: "공고 본문" });

    expect(result.modelId).toBe(EXTRACTION_MODEL_ID);
    expect(result.promptVersion).toBe(EXTRACT_PROMPT_VERSION);
    expect(result.schemaVersion).toBe(EXTRACTION_SCHEMA_VERSION);
  });

  it("token_usage를 input/output/cache_read/cache_creation으로 매핑한다 (6.2 사용량 기록)", async () => {
    const { client } = makeFakeClient([okTurn]);
    const result = await extractJobPosting(client, { bodyText: "공고 본문" });

    expect(result.tokenUsage).toEqual({
      input: 1200,
      output: 800,
      cache_read: 1000,
      cache_creation: 50,
    });
  });

  it("usage에 캐시 필드가 없으면 0으로 채운다", async () => {
    const { client } = makeFakeClient([
      {
        ...okTurn,
        usage: {
          cache_read_input_tokens: undefined,
          cache_creation_input_tokens: undefined,
        },
      },
    ]);
    const result = await extractJobPosting(client, { bodyText: "공고 본문" });

    expect(result.tokenUsage.cache_read).toBe(0);
    expect(result.tokenUsage.cache_creation).toBe(0);
  });
});

describe("extractJobPosting — 요청 파라미터 (6.1 호출 파라미터 표)", () => {
  async function capture(input: Parameters<typeof extractJobPosting>[1]) {
    const { client, calls } = makeFakeClient([okTurn]);
    await extractJobPosting(client, input);
    return calls[0];
  }

  it("모델·max_tokens·adaptive thinking·effort medium을 사용한다", async () => {
    const params = await capture({ bodyText: "본문" });

    expect(params.model).toBe("claude-opus-4-8");
    expect(params.max_tokens).toBe(8000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect((params.output_config as Record<string, unknown>).effort).toBe("medium");
  });

  it("structured outputs로 추출 스키마를 강제한다", async () => {
    const params = await capture({ bodyText: "본문" });
    const format = (params.output_config as { format: Record<string, unknown> }).format;

    expect(format.type).toBe("json_schema");
    expect(format.schema).toBe(EXTRACTION_JSON_SCHEMA); // 동일 객체 참조 — 스키마 변형 없음
  });

  it("고정 시스템 프롬프트에 cache_control을 건다 (3.3 프롬프트 캐시)", async () => {
    const params = await capture({ bodyText: "본문" });
    const system = params.system as Array<Record<string, unknown>>;

    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("가변 입력(메타데이터·본문)은 전부 user 메시지에 담는다", async () => {
    const params = await capture({
      bodyText: "공고 본문입니다",
      title: "제목",
      siteName: "원티드",
    });
    const messages = params.messages as Array<{ role: string; content: string }>;

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("공고 본문입니다");
    expect(messages[0].content).toContain("수집 사이트: 원티드");
    expect(messages[0].content).toContain("페이지 제목: 제목");
    // 시스템 프롬프트에는 가변 값이 섞이지 않는다 (캐시 무효화 방지)
    const system = params.system as Array<{ text: string }>;
    expect(system[0].text).not.toContain("원티드");
  });
});

describe("extractJobPosting — stop_reason별 처리와 재시도 (8장)", () => {
  it("refusal: 1회 재시도 후 성공하면 결과를 반환한다", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "refusal" }, okTurn]);
    const result = await extractJobPosting(client, { bodyText: "본문" });

    expect(result.extracted.company_name).toBe("테스트컴퍼니");
    expect(calls).toHaveLength(2);
  });

  it("refusal: 재시도까지 거부되면 ExtractionError(refusal)를 던진다", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "refusal" }]);
    const error = await extractJobPosting(client, { bodyText: "본문" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).code).toBe("refusal");
    expect(calls).toHaveLength(2); // 최초 1회 + 재시도 1회
  });

  it("max_tokens: 1회 재시도 후 성공하면 결과를 반환한다", async () => {
    const { client, calls } = makeFakeClient([
      { stop_reason: "max_tokens", text: '{"company_name": "잘림' },
      okTurn,
    ]);
    const result = await extractJobPosting(client, { bodyText: "본문" });

    expect(result.extracted.job_title).toBe("백엔드 개발자");
    expect(calls).toHaveLength(2);
  });

  it("max_tokens: 재시도도 잘리면 ExtractionError(truncated)를 던진다", async () => {
    const { client, calls } = makeFakeClient([
      { stop_reason: "max_tokens", text: '{"company_name": "잘림' },
    ]);
    const error = await extractJobPosting(client, { bodyText: "본문" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).code).toBe("truncated");
    expect(calls).toHaveLength(2);
  });

  it("maxRetries: 0이면 재시도 없이 즉시 실패한다", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "max_tokens", text: "{" }]);
    const error = await extractJobPosting(client, { bodyText: "본문" }, { maxRetries: 0 }).catch(
      (e: unknown) => e
    );

    expect((error as ExtractionError).code).toBe("truncated");
    expect(calls).toHaveLength(1);
  });

  it("end_turn인데 텍스트 블록이 없으면 ExtractionError(empty_output)", async () => {
    const { client } = makeFakeClient([{ stop_reason: "end_turn" }]);
    const error = await extractJobPosting(client, { bodyText: "본문" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).code).toBe("empty_output");
  });

  it("malformed structured output: JSON이 깨져 있으면 재시도 후 ExtractionError(invalid_json)", async () => {
    const { client, calls } = makeFakeClient([{ stop_reason: "end_turn", text: "json 아님 {" }]);
    const error = await extractJobPosting(client, { bodyText: "본문" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).code).toBe("invalid_json");
    expect(calls).toHaveLength(2);
  });

  it("API 오류(429/5xx 등 SDK 예외)는 재시도하지 않고 그대로 전파한다", async () => {
    const apiError = new Error("rate limited");
    const { client, calls } = makeFakeClient([{ stop_reason: "end_turn", throws: apiError }]);
    const error = await extractJobPosting(client, { bodyText: "본문" }).catch((e: unknown) => e);

    expect(error).toBe(apiError); // SDK가 이미 지수 백오프로 재시도한 뒤이므로 이 계층은 손대지 않음
    expect(calls).toHaveLength(1);
  });
});

describe("parseExtraction (순수 함수)", () => {
  it("유효한 JSON을 그대로 파싱한다", () => {
    expect(parseExtraction(JSON.stringify(sampleExtraction))).toEqual(sampleExtraction);
  });

  it("깨진 JSON이면 ExtractionError(invalid_json)를 던진다", () => {
    expect(() => parseExtraction("{broken")).toThrowError(ExtractionError);
    try {
      parseExtraction("{broken");
    } catch (e) {
      expect((e as ExtractionError).code).toBe("invalid_json");
    }
  });
});
