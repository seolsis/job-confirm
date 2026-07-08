import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler"; // cheerio가 노드 타입을 domhandler에서 가져온다

/**
 * Cheerio 기반 HTML 파서 유틸 — 어댑터·범용 추출기가 공유한다.
 * 전부 순수 함수라 픽스처 HTML 문자열로 단위 테스트할 수 있다.
 */

export function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}

/** 페이지 메타데이터 — 구조화 프롬프트의 추출 힌트 (AI_ANALYSIS_DESIGN.md 3.1) */
export function extractPageMeta($: CheerioAPI): {
  title: string | null;
  siteName: string | null;
} {
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
  const docTitle = $("title").first().text().trim();
  const siteName = $('meta[property="og:site_name"]').attr("content")?.trim();

  return {
    title: ogTitle || docTitle || null,
    siteName: siteName || null,
  };
}

/**
 * 요소의 텍스트를 줄 구조를 살려 추출한다.
 * cheerio의 .text()는 블록 경계를 지워버리므로, 블록 요소 뒤에
 * 개행을 심은 뒤 텍스트를 뽑는다. (원본 DOM은 복제해 훼손하지 않음)
 */
export function elementToText($: CheerioAPI, element: Cheerio<AnyNode>): string {
  const clone = element.clone();

  clone.find("script, style, noscript, iframe, svg, template").remove();
  clone.find("br").replaceWith("\n");
  clone
    .find("p, div, li, tr, section, article, h1, h2, h3, h4, h5, h6, dt, dd, ul, ol, table")
    .each((_, el) => {
      $(el).append("\n");
      $(el).prepend("\n");
    });

  return clone.text();
}

/** 본문 추출 전에 문서에서 노이즈(내비게이션·광고 영역 등)를 제거한다 */
export function removeNoise($: CheerioAPI): void {
  $(
    "script, style, noscript, iframe, svg, template, " +
      "nav, header, footer, aside, form, button, " +
      '[role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]'
  ).remove();
}
