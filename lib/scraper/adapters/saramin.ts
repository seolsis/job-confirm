import { elementToText, extractPageMeta, loadHtml, removeNoise } from "../html";
import type { ExtractedContent, SiteAdapter } from "../types";

/**
 * 사람인(saramin.co.kr) 어댑터 — MVP 우선 어댑터 (PRD 5.2, Q5).
 *
 * 공고 상세 페이지(relay/view)의 SSR HTML에는 본문이 없다 — JD는 JS가
 * iframe(relay/view-detail?rec_idx=…)으로 로드한다 (2026-07-10 실측:
 * 메인 페이지는 정제 후 50자 미만 → empty_content의 원인).
 * 그래서 detailUrl()로 상세 문서를 추가 수집하고, extract()는 그 문서의
 * .user_content 등에서 본문을 뽑는다. 상세 수집이 실패하면 오케스트레이터가
 * 메인 페이지 추출 → 범용 추출기 → 붙여넣기 폴백 순으로 내려간다.
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

  /** JD 본문이 담긴 상세 문서 (메인 페이지가 iframe으로 로드하는 그 문서) */
  detailUrl(url: URL): URL | null {
    const recIdx = url.searchParams.get("rec_idx");
    if (recIdx === null || recIdx === "") return null;
    return new URL(
      `https://www.saramin.co.kr/zf_user/jobs/relay/view-detail?rec_idx=${encodeURIComponent(recIdx)}`
    );
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
