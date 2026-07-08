import "server-only"; // 클라이언트 번들에 import되면 빌드가 실패한다 — 서버 전용 강제

import { createClient } from "@supabase/supabase-js";

import { supabaseUrl } from "./env";

/**
 * service-role 클라이언트 (RLS 우회) — ARCHITECTURE.md 3.4
 *
 * 사용처: 공유 테이블 쓰기 전용 — jobConfirm_job_postings, jobConfirm_posting_extractions
 * 및 서버만 기록하는 테이블(jobConfirm_match_analyses, jobConfirm_usage_logs,
 * jobConfirm_analysis_jobs 등). Route Handler 내부에서만 사용한다.
 *
 * 절대 금지:
 *   - Client Component에서 import (위의 "server-only"가 빌드 단계에서 차단)
 *   - SUPABASE_SERVICE_ROLE_KEY를 NEXT_PUBLIC_ 접두사로 노출
 */
export function createServiceRoleSupabaseClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "환경 변수 SUPABASE_SERVICE_ROLE_KEY이(가) 설정되지 않았습니다. .env.example을 참고해 .env.local을 채워주세요."
    );
  }

  return createClient(supabaseUrl(), serviceRoleKey, {
    auth: {
      // 사용자 세션과 무관한 관리용 클라이언트 — 세션 저장·갱신을 하지 않는다
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
