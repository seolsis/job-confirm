import { elementToText, extractPageMeta, loadHtml } from "../html";
import type { ExtractedContent, SiteAdapter } from "../types";

/**
 * 원티드(wanted.co.kr) 어댑터 — MVP 우선 어댑터 (PRD 5.2, Q5).
 *
 * 1순위: __NEXT_DATA__(Next.js SSR 데이터)의 initialData — 자격요건·우대사항·
 * 혜택·경력 연차까지 담긴 완전한 구조화 JD다.
 * 2순위(폴백): JSON-LD(JobPosting) — description이 주요 업무 요약만 담고 있어
 * 자격요건이 누락된다 (M2-4 실측: 요건 0건 → 100점 오판의 원인).
 * 둘 다 실패하면 null을 반환하고 오케스트레이터가 범용 추출기로 폴백한다.
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

/** __NEXT_DATA__.props.pageProps.initialData — 원티드 공고 상세의 SSR 데이터 */
interface WantedInitialData {
  position: string;
  company: { company_name: string | null };
  address: { full_location: string | null; location: string | null } | null;
  career: { annual_from: number | null; annual_to: number | null; is_newbie: boolean } | null;
  close_time: string | null;
  due_time: string | null;
  intro: string | null;
  main_tasks: string | null;
  requirements: string | null;
  preferred_points: string | null;
  benefits: string | null;
}

/** initialData 후보를 방어적으로 검증한다 — 필수는 position + 본문 섹션 1개 이상 */
function asInitialData(value: unknown): WantedInitialData | null {
  if (value === null || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (asString(data["position"]) === null) return null;
  const hasBody = ["intro", "main_tasks", "requirements"].some(
    (key) => asString(data[key]) !== null
  );
  return hasBody ? (data as unknown as WantedInitialData) : null;
}

/** initialData → 라벨 있는 본문 텍스트 (필드 해석·판정은 LLM 구조화 단계의 몫) */
function buildBodyFromInitialData(data: WantedInitialData): string {
  const lines: string[] = [`공고 제목: ${data.position}`];

  const companyName = asString(data.company?.company_name);
  if (companyName) lines.push(`회사: ${companyName}`);

  const career = data.career;
  if (career && (career.annual_from !== null || career.annual_to !== null)) {
    const from = career.annual_from !== null ? `${career.annual_from}년` : "";
    const to = career.annual_to !== null ? `${career.annual_to}년` : "";
    lines.push(
      `경력: ${from}${from || to ? " ~ " : ""}${to}${career.is_newbie ? " (신입 가능)" : ""}`
    );
  }

  const location = asString(data.address?.full_location) ?? asString(data.address?.location);
  if (location) lines.push(`근무지: ${location}`);

  const deadline = asString(data.close_time) ?? asString(data.due_time);
  if (deadline) lines.push(`마감: ${deadline}`);

  const sections: Array<[string, string | null | undefined]> = [
    ["소개", data.intro],
    ["주요업무", data.main_tasks],
    ["자격요건", data.requirements],
    ["우대사항", data.preferred_points],
    ["혜택 및 복지", data.benefits],
  ];
  for (const [label, text] of sections) {
    const value = asString(text);
    if (value) lines.push("", `[${label}]`, value);
  }

  return lines.join("\n");
}

export const wantedAdapter: SiteAdapter = {
  sourceSite: "wanted",

  matches(url: URL): boolean {
    return url.hostname === "wanted.co.kr" || url.hostname.endsWith(".wanted.co.kr");
  },

  extract(html: string): ExtractedContent | null {
    const $ = loadHtml(html);

    // 1순위 — __NEXT_DATA__의 initialData (완전한 구조화 JD)
    try {
      const nextData = JSON.parse($("script#__NEXT_DATA__").text()) as {
        props?: { pageProps?: { initialData?: unknown } };
      };
      const data = asInitialData(nextData.props?.pageProps?.initialData);
      if (data) {
        const meta = extractPageMeta($);
        return {
          title: data.position,
          siteName: meta.siteName ?? "원티드",
          bodyText: buildBodyFromInitialData(data),
        };
      }
    } catch {
      // __NEXT_DATA__가 없거나 구조가 바뀜 — JSON-LD 폴백으로 진행
    }

    // 2순위(폴백) — JSON-LD JobPosting (description이 요약본이라 자격요건이 빠질 수 있다)
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
