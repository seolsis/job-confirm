import { NextResponse, type NextRequest } from "next/server";

import { getMatchAnalysisById, updateAnalysisFeedback } from "@/lib/db/match-analyses";
import { createRouteHandlerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

/**
 * PUT /api/analyses/{analysisId}/feedback — 분석 결과 피드백 (M4-2, PRD 4.1 F14).
 *
 * 요청 본문: { feedback: "up" | "down" | null, reason?: string }
 * null은 철회(같은 버튼 다시 누르기). reason은 👎에만 저장된다.
 *
 * match_analyses write는 RLS상 서버만 가능하므로 이 라우트를 거친다 —
 * 어드민의 오답 사례 검토(품질 모니터링 루프, PRD 7.2)가 이 데이터를 쓴다.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ analysisId: string }> }
): Promise<NextResponse> {
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
  const feedback = body.feedback;
  if (feedback !== "up" && feedback !== "down" && feedback !== null) {
    return NextResponse.json(
      { error: "feedback은 up, down, null 중 하나여야 합니다" },
      { status: 400 }
    );
  }
  const reason = typeof body.reason === "string" ? body.reason : null;

  const { analysisId } = await context.params;
  const service = createServiceRoleSupabaseClient();

  // 소유권 확인 — 타인 분석은 "없음"으로 취급한다 (존재 비노출)
  const analysis = await getMatchAnalysisById(service, analysisId);
  if (analysis === null || analysis.user_id !== user.id) {
    return NextResponse.json({ error: "분석 결과를 찾을 수 없습니다" }, { status: 404 });
  }

  const updated = await updateAnalysisFeedback(service, analysisId, feedback, reason);
  return NextResponse.json({
    feedback: updated.feedback,
    feedbackReason: updated.feedback_reason,
  });
}
