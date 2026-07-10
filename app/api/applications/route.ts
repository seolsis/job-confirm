import { NextResponse, type NextRequest } from "next/server";

import { createApplication } from "@/lib/db/applications";
import { getMatchAnalysisById } from "@/lib/db/match-analyses";
import { getExtractionById } from "@/lib/db/posting-extractions";
import { createRouteHandlerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

/**
 * POST /api/applications — 분석 결과를 취준탭 카드로 저장 (M3-2, PRD 2.2 마지막 단계).
 *
 * 요청 본문: { analysisId: string }
 *
 * 카드 insert는 RLS상 서버(service-role)만 가능하므로 이 라우트를 거친다
 * (ARCHITECTURE.md 4.2 — 상태·메모 변경만 클라이언트 직접 update 허용).
 * posting_id는 analysis → extraction → posting 경로로 서버가 찾는다.
 * 같은 공고를 다시 저장하면 기존 카드에 최신 분석만 연결한다 (중복 카드 방지).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await createRouteHandlerSupabaseClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (user === null) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const analysisId = typeof body.analysisId === "string" ? body.analysisId : "";
  if (analysisId === "") {
    return NextResponse.json({ error: "analysisId가 필요합니다" }, { status: 400 });
  }

  const service = createServiceRoleSupabaseClient();

  // 분석 소유권 확인 — 타인 분석은 "없음"으로 취급한다 (존재 비노출)
  const analysis = await getMatchAnalysisById(service, analysisId);
  if (analysis === null || analysis.user_id !== user.id) {
    return NextResponse.json({ error: "분석 결과를 찾을 수 없습니다" }, { status: 404 });
  }

  const extraction = await getExtractionById(service, analysis.extraction_id);
  if (extraction === null) {
    console.error(`[api/applications] extraction 없음 (analysis: ${analysisId})`);
    return NextResponse.json({ error: "공고 정보를 찾을 수 없습니다" }, { status: 500 });
  }

  const { row, alreadySaved } = await createApplication(service, {
    userId: user.id,
    postingId: extraction.posting_id,
    analysisId,
  });

  return NextResponse.json({ applicationId: row.id, status: row.status, alreadySaved });
}
