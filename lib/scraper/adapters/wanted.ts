import { elementToText, extractPageMeta, loadHtml } from "../html";
import type { ExtractedContent, SiteAdapter } from "../types";

/**
 * 원티드(wanted.co.kr) 어댑터 — MVP 우선 어댑터 (PRD 5.2, Q5).
 *
 * 원티드 공고 페이지는 SSR HTML에 JSON-LD(JobPosting)를 포함하므로
 * 이를 1순위로 파싱한다. JSON-LD가 없으면(마크업 변경 등) null을 반환하고
 * 오케스트레이터가 범용 추출기로 폴백한다.
 */

/** JSON-LD 트리에서 @type: JobPosting 노드를 찾는다 */
function findJobPostingNode(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPostingNode(item);
      if (found) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["@type"] === "JobPosting") return obj;
    if ("@graph" in obj) return findJobPostingNode(obj["@graph"]);
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** JSON-LD의 HTML description을 줄 구조를 살린 텍스트로 변환 */
function htmlToPlainText(html: string): string {
  const $ = loadHtml(`<div id="__root">${html}</div>`);
  return elementToText($, $("#__root"));
}

export const wantedAdapter: SiteAdapter = {
  sourceSite: "wanted",

  matches(url: URL): boolean {
    return url.hostname === "wanted.co.kr" || url.hostname.endsWith(".wanted.co.kr");
  },

  extract(html: string): ExtractedContent | null {
    const $ = loadHtml(html);

    let jobPosting: Record<string, unknown> | null = null;
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        jobPosting = findJobPostingNode(JSON.parse($(el).text()));
      } catch {
        continue; // 깨진 JSON-LD는 무시하고 다음 스크립트 시도
      }
      if (jobPosting) break;
    }
    if (!jobPosting) return null;

    const title = asString(jobPosting["title"]);
    const description = asString(jobPosting["description"]);
    if (!description) return null;

    // 프롬프트 힌트가 되도록 주요 필드를 라벨과 함께 본문 상단에 배치한다
    // (필드 해석·판정은 하지 않는다 — 그건 LLM 구조화 단계의 몫)
    const org = jobPosting["hiringOrganization"];
    const companyName =
      org !== null && typeof org === "object"
        ? asString((org as Record<string, unknown>)["name"])
        : null;

    const lines: string[] = [];
    if (title) lines.push(`공고 제목: ${title}`);
    if (companyName) lines.push(`회사: ${companyName}`);
    const validThrough = asString(jobPosting["validThrough"]);
    if (validThrough) lines.push(`마감: ${validThrough}`);
    lines.push("", htmlToPlainText(description));

    const meta = extractPageMeta($);
    return {
      title: title ?? meta.title,
      siteName: meta.siteName ?? "원티드",
      bodyText: lines.join("\n"),
    };
  },
};
