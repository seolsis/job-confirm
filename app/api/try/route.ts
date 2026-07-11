import { NextResponse, type NextRequest } from "next/server";

import { isNotAPosting } from "@/lib/ai/analysis-pipeline";
import { createAiClient } from "@/lib/ai/client";
import { ExtractPostingError, extractAndStorePosting } from "@/lib/ai/extraction-service";
import { lookupExtractionByUrl } from "@/lib/ai/url-entry-service";
import { insertJobPosting } from "@/lib/db/postings";
import { scrapeJobPosting, ScrapeError } from "@/lib/scraper";
import { parseHttpUrl } from "@/lib/scraper/url";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

/**
 * POST /api/try — 비로그인 체험 (M4-3, PRD 2.5 전환 퍼널).
 *
 * 공고 구조화(LLM #1)까지만 무료로 보여준다 — 적합도(LLM #2)는 가입 후.
 * 결과는 공유 캐시(job_postings/posting_extractions)에 저장되므로 가입 후
 * 같은 URL을 분석하면 구조화가 재사용된다 (전환 시 비용 절약).
 *
 * 남용 방지 (MVP 최소): 브라우저 쿠키 기준 3회. 캐시 히트는 LLM 비용이
 * 없으므로 차감하지 않는다. IP 단위 제한은 배포 인프라(M4-5)에서 보강한다.
 */

export const maxDuration = 120; // LLM 1회 호출

const TRY_COOKIE = "jc_try_used";
const TRY_LIMIT = 3;

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url === "") {
    return NextResponse.json({ error: "url이 필요합니다" }, { status: 400 });
  }
  try {
    parseHttpUrl(url);
  } catch {
    return NextResponse.json({ error: "올바른 http(s) URL이 아닙니다" }, { status: 400 });
  }

  const used = Number(request.cookies.get(TRY_COOKIE)?.value ?? "0") || 0;
  const supabase = createServiceRoleSupabaseClient();

  try {
    // 1. 캐시 조회 — 히트면 LLM 없이 반환하고 횟수도 차감하지 않는다
    const lookup = await lookupExtractionByUrl(supabase, url);
    if (lookup.cacheHit) {
      if (isNotAPosting(lookup.extraction.extracted)) {
        return NextResponse.json(
          { error: "채용공고가 아닌 것 같아요. 공고 상세 페이지 URL인지 확인해 주세요." },
          { status: 422 }
        );
      }
      return NextResponse.json({
        extracted: lookup.extraction.extracted,
        cacheHit: true,
        remaining: Math.max(0, TRY_LIMIT - used),
      });
    }

    // 2. 미스 — 무료 체험 한도 확인 후 수집·구조화 (LLM #1)
    if (used >= TRY_LIMIT) {
      return NextResponse.json(
        {
          error: `무료 체험은 ${TRY_LIMIT}회까지예요. 가입하면 매달 분석을 계속할 수 있어요!`,
          code: "try_limit",
        },
        { status: 429 }
      );
    }

    let posting = lookup.posting;
    let hints: { title: string | null; siteName: string | null } = {
      title: null,
      siteName: null,
    };
    if (posting === null) {
      const scraped = await scrapeJobPosting(url);
      posting = await insertJobPosting(supabase, scraped);
      hints = { title: scraped.title, siteName: scraped.siteName };
    }
    const output = await extractAndStorePosting(
      { anthropic: createAiClient(), supabase },
      posting.id,
      hints
    );

    if (isNotAPosting(output.extraction.extracted)) {
      return NextResponse.json(
        { error: "채용공고가 아닌 것 같아요. 공고 상세 페이지 URL인지 확인해 주세요." },
        { status: 422 }
      );
    }

    const nextUsed = output.cacheHit ? used : used + 1;
    const response = NextResponse.json({
      extracted: output.extraction.extracted,
      cacheHit: output.cacheHit,
      remaining: Math.max(0, TRY_LIMIT - nextUsed),
    });
    response.cookies.set(TRY_COOKIE, String(nextUsed), {
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: true,
      sameSite: "lax",
    });
    return response;
  } catch (error) {
    if (error instanceof ScrapeError) {
      return NextResponse.json(
        {
          error:
            "이 사이트는 자동으로 가져올 수 없었어요. 가입하면 본문 붙여넣기로 분석할 수 있어요!",
          code: "fetch_failed",
        },
        { status: 422 }
      );
    }
    if (error instanceof ExtractPostingError) {
      return NextResponse.json(
        { error: "공고를 정리하는 데 실패했어요. 잠시 후 다시 시도해 주세요." },
        { status: 502 }
      );
    }
    console.error("[api/try] 처리되지 않은 오류", error);
    return NextResponse.json({ error: "처리 중 오류가 발생했습니다" }, { status: 500 });
  }
}
