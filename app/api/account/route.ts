import { NextResponse } from "next/server";

import { createRouteHandlerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

/**
 * DELETE /api/account — 회원 탈퇴 (S10, PRD 7.2의 "탈퇴 시 완전 삭제").
 *
 * auth.users 행을 지우면 jobConfirm_* 사용자 데이터(프로필·스냅샷·분석·카드·
 * 이력·쿼터 로그·잡)는 전부 FK on delete cascade로 함께 삭제된다.
 * 공유 캐시(job_postings, posting_extractions)는 사용자 무관 데이터라 남는다.
 * auth admin API는 service-role 전용이므로 이 라우트를 거친다.
 */
export async function DELETE(): Promise<NextResponse> {
  const auth = await createRouteHandlerSupabaseClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (user === null) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }

  const service = createServiceRoleSupabaseClient();
  const { error } = await service.auth.admin.deleteUser(user.id);
  if (error !== null) {
    console.error(`[api/account] 회원 탈퇴 실패 (user: ${user.id}): ${error.message}`);
    return NextResponse.json(
      { error: "탈퇴 처리에 실패했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 500 }
    );
  }

  // 세션 쿠키 정리 — 계정이 사라졌으므로 로컬 세션도 무효화한다
  await auth.auth.signOut();
  return NextResponse.json({ ok: true });
}
