import { elementToText, extractPageMeta, loadHtml, removeNoise } from "../html";
import type { ExtractedContent, SiteAdapter } from "../types";

/**
 * 사람인(saramin.co.kr) 어댑터 — MVP 우선 어댑터 (PRD 5.2, Q5).
 *
 * 사람인 공고 상세는 서버 렌더링된 요약 영역(.jv_summary/.jv_cont)을 갖는다.
 * 상세 본문 iframe(외부 문서)은 접근하지 않고, 페이지 내 텍스트만 수집한다.
 * 대상 선택자가 모두 비어 있으면 null을 반환해 범용 추출기로 폴백한다.
 */

/** 공고 본문이 담기는 영역 선택자 (우선순위 순) */
const CONTENT_SELECTORS = [
  ".jview", // 공고 상세 전체 래퍼
  ".jv_cont", // 상세 컨텐츠 블록
  ".wrap_jv_cont",
  ".user_content", // 기업이 직접 작성한 본문
];

/** 이 길이 미만이면 본문으로 보지 않는다 (요약 껍데기만 잡힌 경우) */
const MIN_CONTENT_LENGTH = 100;

export const saraminAdapter: SiteAdapter = {
  sourceSite: "saramin",

  matches(url: URL): boolean {
    return url.hostname === "saramin.co.kr" || url.hostname.endsWith(".saramin.co.kr");
  },

  extract(html: string): ExtractedContent | null {
    const $ = loadHtml(html);
    const meta = extractPageMeta($);
    removeNoise($);

    let bodyText: string | null = null;
    for (const selector of CONTENT_SELECTORS) {
      const element = $(selector).first();
      if (element.length === 0) continue;
      const text = elementToText($, element).trim();
      if (text.length >= MIN_CONTENT_LENGTH) {
        bodyText = text;
        break;
      }
    }
    if (!bodyText) return null;

    return {
      title: meta.title,
      siteName: meta.siteName ?? "사람인",
      bodyText,
    };
  },
};
