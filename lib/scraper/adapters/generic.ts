import { elementToText, extractPageMeta, loadHtml, removeNoise } from "../html";
import type { ExtractedContent, SiteAdapter } from "../types";

/**
 * 범용 본문 추출기 — ARCHITECTURE.md 3.2 (사이트 어댑터 + 범용 본문 추출).
 *
 * 자사 채용페이지 등 어댑터가 없는 사이트에서 본문으로 보이는 영역을
 * 휴리스틱으로 고른다:
 *   1) 노이즈(nav/header/footer 등) 제거
 *   2) 본문 후보 선택자 중 텍스트가 가장 긴 요소 선택
 *   3) 후보가 모두 짧으면 body 전체 텍스트로 폴백
 *
 * JS 렌더링이 필요한 사이트는 여기서 빈 결과가 나온다 → 상위에서
 * empty_content 오류 → 붙여넣기 폴백 UI로 안내한다 (MVP 정책, ARCHITECTURE.md 3.2).
 */

/** 본문일 확률이 높은 컨테이너 후보 (일반적인 마크업 관행 순) */
const CANDIDATE_SELECTORS = [
  "main",
  "article",
  '[role="main"]',
  "#main",
  "#content",
  "#container",
  ".content",
  ".main-content",
  ".job-description",
  ".job-detail",
  ".recruit-detail",
];

/** 후보로 인정할 최소 텍스트 길이 — 이보다 짧으면 본문이 아니라고 본다 */
const MIN_CANDIDATE_LENGTH = 200;

export const genericAdapter: SiteAdapter = {
  sourceSite: "generic",

  matches(): boolean {
    return true; // 전용 어댑터가 없는 모든 URL의 마지막 보루
  },

  extract(html: string): ExtractedContent | null {
    const $ = loadHtml(html);
    const meta = extractPageMeta($);
    removeNoise($);

    // 후보 중 텍스트가 가장 긴 요소를 본문으로 채택
    let best: { text: string; length: number } | null = null;
    for (const selector of CANDIDATE_SELECTORS) {
      for (const el of $(selector).toArray()) {
        const text = elementToText($, $(el)).trim();
        if (text.length >= MIN_CANDIDATE_LENGTH && (best === null || text.length > best.length)) {
          best = { text, length: text.length };
        }
      }
    }

    // 후보가 없으면 body 전체 — 그래도 비면 null (→ 붙여넣기 폴백)
    const bodyText = best?.text ?? elementToText($, $("body")).trim();
    if (bodyText === "") return null;

    return {
      title: meta.title,
      siteName: meta.siteName,
      bodyText,
    };
  },
};
