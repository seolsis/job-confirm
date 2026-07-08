/**
 * 본문 텍스트 정제 — AI_ANALYSIS_DESIGN.md 2장 [0] 전처리의 "정제" 단계.
 * 추출된 텍스트의 공백·개행을 정리해 스냅샷 저장과 LLM 입력에 적합한 형태로 만든다.
 */

/** LLM 입력·스냅샷 크기 상한 (문자 수). 공고 본문은 보통 수천 자 수준이다. */
const MAX_BODY_LENGTH = 50_000;

export function cleanText(raw: string): string {
  const cleaned = raw
    .replace(/\r\n?/g, "\n") // 개행 통일
    .replace(/[ ​﻿]/g, " ") // nbsp, zero-width space, BOM -> 공백
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim()) // 줄 내 공백 축약
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // 3개 이상 연속 개행 → 2개
    .trim();

  return cleaned.length > MAX_BODY_LENGTH ? cleaned.slice(0, MAX_BODY_LENGTH) : cleaned;
}
