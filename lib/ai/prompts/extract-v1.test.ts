import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildExtractUserMessage,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM_PROMPT,
} from "./extract-v1";

/**
 * 프롬프트 검증 — AI_ANALYSIS_DESIGN.md 3.3
 *
 * 시스템 프롬프트는 프롬프트 캐시 대상이라 "바이트 단위 고정"이 계약이다.
 * 아래 해시 고정 테스트는 prompt_version을 올리지 않은 내용 변경을 잡아낸다.
 */

/**
 * EXTRACT_SYSTEM_PROMPT의 SHA-256 (extract-v1 기준).
 *
 * 이 테스트가 깨졌다면 시스템 프롬프트 내용이 바뀐 것이다. 대응 방법:
 *  1. 새 버전 파일(extract-v2.ts)을 만들고 EXTRACT_PROMPT_VERSION을 올린 뒤
 *  2. 새 버전의 해시로 이 상수를 갱신한다.
 * 버전을 올리지 않고 해시만 바꾸는 것은 금지 — DB에 기록된 prompt_version과
 * 실제 프롬프트가 어긋나 회귀 비교(6.3)가 불가능해진다.
 */
const EXTRACT_V1_PROMPT_SHA256 = "cdbd99f0fef52c4388d73527f0bc7b5db06a87e231271187f949d8f4be750976";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("EXTRACT_SYSTEM_PROMPT — 고정성", () => {
  it("prompt_version 변경 없이 내용이 바뀌지 않았다 (해시 고정)", () => {
    expect(EXTRACT_PROMPT_VERSION).toBe("extract-v1");
    expect(sha256(EXTRACT_SYSTEM_PROMPT)).toBe(EXTRACT_V1_PROMPT_SHA256);
  });

  it("고정 문자열이다 — 호출 시점과 무관하게 항상 같은 값", () => {
    // 모듈 상수이므로 참조가 동일하고, 시간·환경에 따라 변하는 보간이 없어야 한다
    const first = EXTRACT_SYSTEM_PROMPT;
    const second = EXTRACT_SYSTEM_PROMPT;
    expect(first).toBe(second);
    // 캐시를 깨뜨리는 흔한 실수: 날짜·시각 보간
    expect(EXTRACT_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO 타임스탬프 없음
  });

  it("핵심 추출 규칙이 포함돼 있다 (설계 원칙 3·4)", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain("원문에 없는 정보는 null");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("의미 단위로 분리");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("evidence는 원문 그대로 발췌");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("기술명 정규화");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("채용공고가 아닌 경우");
  });
});

describe("buildExtractUserMessage", () => {
  it("메타데이터와 본문을 섹션으로 구성한다", () => {
    const message = buildExtractUserMessage({
      siteName: "원티드",
      title: "백엔드 개발자 채용",
      bodyText: "공고 본문입니다",
    });

    expect(message).toBe(
      "## 수집 메타데이터\n수집 사이트: 원티드\n페이지 제목: 백엔드 개발자 채용\n\n## 공고 본문\n공고 본문입니다"
    );
  });

  it("메타데이터가 없으면 본문 섹션만 만든다", () => {
    const message = buildExtractUserMessage({ siteName: null, title: null, bodyText: "본문만" });

    expect(message).toBe("## 공고 본문\n본문만");
  });

  it("제목만 있으면 사이트 줄을 생략한다", () => {
    const message = buildExtractUserMessage({ siteName: null, title: "제목", bodyText: "본문" });

    expect(message).toBe("## 수집 메타데이터\n페이지 제목: 제목\n\n## 공고 본문\n본문");
  });

  it("사이트명만 있으면 제목 줄을 생략한다", () => {
    const message = buildExtractUserMessage({ siteName: "사람인", title: null, bodyText: "본문" });

    expect(message).toBe("## 수집 메타데이터\n수집 사이트: 사람인\n\n## 공고 본문\n본문");
  });

  it("순수 함수다 — 같은 입력이면 항상 같은 출력", () => {
    const input = { siteName: "원티드", title: "제목", bodyText: "본문" };
    expect(buildExtractUserMessage(input)).toBe(buildExtractUserMessage(input));
  });
});
