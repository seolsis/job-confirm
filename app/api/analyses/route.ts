import { NextResponse, type NextRequest } from "next/server";

import {
  AnalysisPipelineError,
  AnalysisRequestError,
  runAnalysisPipeline,
} from "@/lib/ai/analysis-pipeline";
import { createAiClient } from "@/lib/ai/client";
import type { JobErrorCode } from "@/lib/db/analysis-jobs";
import { getOrCreateProfileSnapshot } from "@/lib/db/profile-snapshots";
import { getProfileByUserId, toProfileSnapshot } from "@/lib/db/profiles";
import { parseHttpUrl } from "@/lib/scraper/url";
import { createRouteHandlerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

/**
 * POST /api/analyses — 분석 파이프라인 진입점 (ARCHITECTURE.md 2장 ①~③).
 *
 * 요청 본문: { url: string } 또는 { pastedText: string } 중 하나.
 * 매칭 기준 스냅샷은 클라이언트가 보내지 않는다 — 세션 사용자의 현재 프로필을
 * 직렬화해 자동 확보한다(M2-4): 같은 내용이면 기존 스냅샷 재사용(content_hash).
 * 프로필이 비어 있으면 400(code: profile_required)으로 온보딩을 유도한다.
 *
 * 파이프라인은 이 핸들러 안에서 동기로 완주한다 (M1 — 별도 잡 큐 없음, 3.1).
 * 진행 상태는 응답이 아니라 analysis_jobs 행 + Realtime으로 전달되므로(3.3)
 * 실패해도 잡이 failed(error_code)로 남아 있어 폴백 UI 분기가 가능하다.
 */

// LLM 2회 호출로 수십 초가 걸린다 — Vercel 실행 시간 확보 (3.1)
export const maxDuration = 300;

/** error_code → HTTP 상태. 사용자 조치 가능(수집 실패·공고 아님)은 422, 나머지는 502 */
const ERROR_STATUS: Record<JobErrorCode, number> = {
  fetch_failed: 422,
  not_a_posting: 422,
  llm_error: 502,
  quota_exceeded: 429, // 쿼터 판정(lib/quota)은 M4 — 매핑만 준비해 둔다
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. 사용자 식별 — 세션 쿠키 기반 (M1은 임시 계정 1개로 내부 테스트)
  const auth = await createRouteHandlerSupabaseClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (user === null) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }

  // 2. 본문 검증
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const pastedText = typeof body.pastedText === "string" ? body.pastedText : "";

  if ((url !== "") === (pastedText.trim() !== "")) {
    return NextResponse.json(
      { error: "url 또는 pastedText 중 하나만 지정하세요" },
      { status: 400 }
    );
  }
  if (url !== "") {
    try {
      parseHttpUrl(url); // 형식 오류는 잡을 만들기 전에 400으로 거절
    } catch {
      return NextResponse.json({ error: "올바른 http(s) URL이 아닙니다" }, { status: 400 });
    }
  }

  // 3. 매칭 기준 스냅샷 자동 확보 — 세션 클라이언트(RLS 본인)로 프로필을 읽고
  //    같은 내용이면 기존 스냅샷을 재사용한다 (M2-2)
  const profile = await getProfileByUserId(auth, user.id);
  if (profile === null) {
    // 가입 트리거가 행을 만들므로 없다는 것은 이상 상태다
    console.error(`[api/analyses] 프로필 행 없음 (user: ${user.id}) — 가입 트리거 확인 필요`);
    return NextResponse.json({ error: "프로필을 찾을 수 없습니다" }, { status: 500 });
  }
  if (profile.completeness === 0) {
    // 빈 프로필로는 매칭이 전부 unknown → 엉터리 분석에 LLM 비용만 쓴다 (PRD 2.1)
    return NextResponse.json(
      { error: "프로필을 먼저 입력해 주세요", code: "profile_required" },
      { status: 400 }
    );
  }
  const { row: snapshot } = await getOrCreateProfileSnapshot(
    auth,
    user.id,
    toProfileSnapshot(profile)
  );

  // 4. 파이프라인 실행 — 잡 생성부터 done/failed 마감까지 내부에서 처리된다
  try {
    const result = await runAnalysisPipeline(
      { anthropic: createAiClient(), supabase: createServiceRoleSupabaseClient() },
      {
        userId: user.id,
        profileSnapshotId: snapshot.id,
        ...(url !== "" ? { url } : { pastedText }),
      }
    );

    return NextResponse.json({
      jobId: result.job.id,
      postingId: result.posting.id,
      extractionId: result.extraction.id,
      analysisId: result.analysis.id,
      score: result.analysis.score,
      grade: result.analysis.grade,
      criticalGapCount: result.analysis.critical_gap_count,
      extractionCacheHit: result.extractionCacheHit,
    });
  } catch (error) {
    if (error instanceof AnalysisRequestError) {
      // 잡 생성 전 거절 — 스냅샷 없음(타인 소유 포함)은 404, 입력 오류는 400
      const status = error.code === "snapshot_not_found" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof AnalysisPipelineError) {
      // 잡은 failed(error_code)로 마감된 상태 — 클라이언트는 jobId로 상세 확인 가능
      return NextResponse.json(
        { jobId: error.jobId, errorCode: error.errorCode },
        { status: ERROR_STATUS[error.errorCode] }
      );
    }
    console.error("[api/analyses] 처리되지 않은 오류", error);
    return NextResponse.json({ error: "분석 처리 중 오류가 발생했습니다" }, { status: 500 });
  }
}
