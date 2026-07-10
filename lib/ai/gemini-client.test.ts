import { ApiError, GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGeminiClient } from "./gemini-client";

/**
 * Gemini 어댑터 단위 테스트 — 실제 Google API는 호출하지 않는다.
 * GoogleGenAI.prototype.models.generateContent를 모킹해 일시적 오류(429/5xx,
 * 네트워크 예외) 재시도와 stop_reason 변환을 검증한다.
 *
 * 배경(2026-07-10 실측): Gemini 무료 티어에서 503 UNAVAILABLE("high demand")과
 * 네트워크 헤더 타임아웃이 실제로 발생해 분석 전체가 즉시 실패했다.
 * Anthropic SDK는 이런 오류를 자동 재시도하지만 이 어댑터는 직접 fetch를
 * 다루므로 같은 안전망이 없었다 — withTransientRetry로 보강했다.
 */

// "server-only"는 Next.js 웹팩 조건부 해석(browser 필드)으로 서버 빌드에서만
// no-op이 된다. vitest는 순수 Node라 항상 throw하는 원본이 로드되므로 모킹한다
// (런타임 가드 자체는 그대로 — client.ts와 동일한 목적, 여기선 테스트만 우회).
vi.mock("server-only", () => ({}));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: vi.fn(),
  };
});

const okResponse = {
  candidates: [{ finishReason: "STOP" }],
  text: '{"ok": true}',
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
};

function mockGenerateContent(impl: (...args: unknown[]) => unknown) {
  const generateContent = vi.fn(impl);
  // `new GoogleGenAI(...)`로 호출되므로 화살표 함수(non-constructible)가 아닌
  // 생성자 함수로 모킹해야 한다
  vi.mocked(GoogleGenAI).mockImplementation(function (this: unknown) {
    return Object.assign(this as object, { models: { generateContent } });
  } as unknown as typeof GoogleGenAI);
  return generateContent;
}

const baseParams = {
  model: "gemini-3.5-flash",
  max_tokens: 100,
  system: [{ type: "text", text: "system prompt" }],
  messages: [{ role: "user", content: "hello" }],
};

beforeEach(() => {
  process.env.GOOGLE_API_KEY = "test-key";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * 대기 없이 재시도 흐름만 진행시키는 헬퍼 — 호출 즉시(동기적으로) rejection
 * 핸들러를 붙인 뒤에 백오프 타이머를 흘려보낸다. 순서를 지키지 않으면
 * "타이머 진행 중에는 아직 아무도 안 받은" 찰나에 reject가 발생해
 * UnhandledRejection 경고가 뜬다 (assertion은 나중에 await됨).
 */
async function expectResolves<T>(promise: Promise<T>): Promise<T> {
  const assertion = promise; // Promise.all이 아래에서 동기적으로 .then을 건다
  await Promise.all([assertion, vi.advanceTimersByTimeAsync(60_000)]).then(([v]) => v);
  return assertion;
}

async function expectRejects(promise: Promise<unknown>, expected: unknown): Promise<void> {
  const assertion = expect(promise).rejects.toBe(expected); // 동기적으로 핸들러 부착
  await vi.advanceTimersByTimeAsync(60_000);
  await assertion;
}

describe("createGeminiClient — 성공 경로", () => {
  it("정상 응답을 Anthropic 형태로 변환한다", async () => {
    mockGenerateContent(async () => okResponse);
    const client = createGeminiClient();

    const message = await client.messages.stream(baseParams as never).finalMessage();

    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: '{"ok": true}' }]);
    expect(message.usage.input_tokens).toBe(10);
    expect(message.usage.output_tokens).toBe(5);
  });
});

describe("createGeminiClient — 일시적 오류 재시도", () => {
  it("503 UNAVAILABLE은 재시도 후 성공하면 결과를 반환한다", async () => {
    const generateContent = mockGenerateContent(
      vi
        .fn()
        .mockRejectedValueOnce(new ApiError({ message: "high demand", status: 503 } as never))
        .mockResolvedValueOnce(okResponse)
    );
    const client = createGeminiClient();

    const message = await expectResolves(
      client.messages.stream(baseParams as never).finalMessage()
    );

    expect(message.stop_reason).toBe("end_turn");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("네트워크 예외(TypeError: fetch failed)도 재시도한다", async () => {
    const generateContent = mockGenerateContent(
      vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(okResponse)
    );
    const client = createGeminiClient();

    const message = await expectResolves(
      client.messages.stream(baseParams as never).finalMessage()
    );

    expect(message.stop_reason).toBe("end_turn");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("재시도를 소진하면 마지막 오류를 그대로 던진다 (최대 4회 시도)", async () => {
    const error = new ApiError({ message: "still down", status: 503 } as never);
    const generateContent = mockGenerateContent(vi.fn().mockRejectedValue(error));
    const client = createGeminiClient();

    await expectRejects(client.messages.stream(baseParams as never).finalMessage(), error);
    expect(generateContent).toHaveBeenCalledTimes(4); // 최초 1회 + 재시도 3회
  });

  it("재시도 대상이 아닌 오류(400)는 즉시 던진다 (재시도 없음)", async () => {
    const error = new ApiError({ message: "bad request", status: 400 } as never);
    const generateContent = mockGenerateContent(vi.fn().mockRejectedValue(error));
    const client = createGeminiClient();

    await expect(client.messages.stream(baseParams as never).finalMessage()).rejects.toBe(error);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("createGeminiClient — stop_reason 변환", () => {
  it("안전 차단 finishReason은 refusal로 변환한다 (재시도 정책 재사용)", async () => {
    mockGenerateContent(async () => ({
      candidates: [{ finishReason: "SAFETY" }],
      text: "",
      usageMetadata: {},
    }));
    const client = createGeminiClient();

    const message = await client.messages.stream(baseParams as never).finalMessage();
    expect(message.stop_reason).toBe("refusal");
  });

  it("MAX_TOKENS는 max_tokens로 변환한다", async () => {
    mockGenerateContent(async () => ({
      candidates: [{ finishReason: "MAX_TOKENS" }],
      text: "partial",
      usageMetadata: {},
    }));
    const client = createGeminiClient();

    const message = await client.messages.stream(baseParams as never).finalMessage();
    expect(message.stop_reason).toBe("max_tokens");
  });
});
