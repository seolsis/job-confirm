import { notFound } from "next/navigation";

import { isAdminEmail } from "@/lib/admin";
import type { AnalysisFeedback } from "@/lib/db/match-analyses";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

/**
 * 어드민 — 피드백 오답 검토 (M4-4, PRD 7.2 품질 모니터링 루프).
 *
 * 최근 피드백(👎 우선)을 분석 버전 3종과 함께 나열한다 — 오답 사례를 보고
 * 프롬프트/스키마를 개선하고, 버전 기록으로 회귀 비교하는 사이클의 입구.
 * 접근: env ADMIN_EMAILS에 등록된 계정만 (그 외에는 404 — 존재 비노출).
 * 서버 컴포넌트 — service-role로 전체 사용자 데이터를 읽으므로 클라이언트에
 * 코드가 내려가지 않는 서버 렌더링만 사용한다.
 */

export const dynamic = "force-dynamic"; // 항상 최신 피드백을 본다

interface FeedbackRow {
  id: string;
  user_id: string;
  extraction_id: string;
  score: number | null;
  grade: string;
  feedback: AnalysisFeedback;
  feedback_reason: string | null;
  model_id: string;
  prompt_version: string;
  schema_version: string;
  created_at: string;
}

export default async function AdminPage() {
  const auth = await createServerSupabaseClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (user === null || !isAdminEmail(user.email)) notFound();

  const service = createServiceRoleSupabaseClient();

  // 피드백이 달린 분석만 — 👎(오답 후보) 먼저, 최신순
  const { data, error } = await service
    .from("jobConfirm_match_analyses")
    .select(
      "id, user_id, extraction_id, score, grade, feedback, feedback_reason, model_id, prompt_version, schema_version, created_at"
    )
    .not("feedback", "is", null)
    .order("feedback", { ascending: false }) // "up" < "down" 이 아니므로 아래에서 재정렬
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`피드백 조회 실패: ${error.message}`);

  const rows = (data ?? []) as FeedbackRow[];
  const sorted = [...rows].sort((a, b) => {
    if (a.feedback !== b.feedback) return a.feedback === "down" ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });

  // 회사·직무 표시용 조인 (배치)
  const extractionIds = [...new Set(sorted.map((r) => r.extraction_id))];
  const { data: extractions } =
    extractionIds.length > 0
      ? await service
          .from("jobConfirm_posting_extractions")
          .select("id, company_name, job_title")
          .in("id", extractionIds)
      : { data: [] };
  const extractionById = new Map(
    (
      (extractions ?? []) as Array<{
        id: string;
        company_name: string | null;
        job_title: string | null;
      }>
    ).map((e) => [e.id, e])
  );

  const downCount = sorted.filter((r) => r.feedback === "down").length;
  const upCount = sorted.length - downCount;

  return (
    <main className="min-h-screen bg-stone-50 px-4 py-10">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-xl text-stone-700">🛠️ 어드민 — 피드백 검토</h1>
        <p className="mt-1 text-sm text-stone-400">
          최근 100건 기준 👍 {upCount} / 👎 {downCount}
          {sorted.length > 0 &&
            ` (긍정률 ${Math.round((upCount / sorted.length) * 100)}% — 목표 70% 이상)`}
        </p>

        {sorted.length === 0 ? (
          <p className="mt-10 text-center text-sm text-stone-400">아직 피드백이 없습니다.</p>
        ) : (
          <ul className="mt-6 space-y-3">
            {sorted.map((row) => {
              const extraction = extractionById.get(row.extraction_id);
              return (
                <li
                  key={row.id}
                  className={`rounded-2xl border-2 bg-white p-4 text-sm ${
                    row.feedback === "down" ? "border-rose-200" : "border-stone-100"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span>{row.feedback === "down" ? "👎" : "👍"}</span>
                    <span className="text-stone-700">
                      {extraction?.company_name ?? "회사명 없음"} —{" "}
                      {extraction?.job_title ?? "직무 없음"}
                    </span>
                    <span className="text-stone-400">
                      {row.score !== null ? `${row.score}점` : "점수 없음"} · {row.grade}
                    </span>
                    <span className="ml-auto text-xs text-stone-300">
                      {new Date(row.created_at).toLocaleString("ko-KR")}
                    </span>
                  </div>
                  {row.feedback_reason !== null && (
                    <p className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-rose-700">
                      “{row.feedback_reason}”
                    </p>
                  )}
                  <p className="mt-2 font-mono text-xs text-stone-400">
                    {row.model_id} · {row.prompt_version} · {row.schema_version} · analysis{" "}
                    {row.id.slice(0, 8)} · user {row.user_id.slice(0, 8)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
