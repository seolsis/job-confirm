"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * S2 — 회원가입 (M2-1, PRD 3.1). 이메일 + 비밀번호.
 *
 * 가입 성공 시 DB 트리거("jobConfirm_on_auth_user_created")가
 * jobConfirm_profiles 행을 자동 생성한다 (마이그레이션 4.1절).
 *
 * Supabase 프로젝트의 이메일 확인(Confirm email) 설정에 따라 두 경로로 갈린다:
 *  - 확인 꺼짐: 즉시 세션 발급 → 홈으로 이동
 *  - 확인 켜짐: 세션 없음 → 확인 메일 안내 표시
 */
export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsEmailConfirm, setNeedsEmailConfirm] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createBrowserSupabaseClient();
    const { data, error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) {
      setSubmitting(false);
      setError(`회원가입에 실패했습니다: ${signUpError.message}`);
      return;
    }

    if (data.session === null) {
      // 이메일 확인이 켜져 있는 프로젝트 — 메일의 링크를 눌러야 로그인 가능
      setSubmitting(false);
      setNeedsEmailConfirm(true);
      return;
    }

    // 가입 직후 바로 프로필 온보딩으로 — 로그인→프로필→분석 흐름 (M2 목표)
    window.location.assign("/profile/onboarding");
  }

  if (needsEmailConfirm) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <h1 className="text-xl font-bold">확인 메일을 보냈습니다</h1>
        <p className="mt-4 text-sm text-gray-700">
          {email} 로 보낸 메일의 링크를 누르면 가입이 완료됩니다. 완료 후{" "}
          <Link href="/login" className="text-indigo-600 underline">
            로그인
          </Link>
          해 주세요.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-xl font-bold">회원가입</h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          이메일
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          비밀번호 (6자 이상)
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>

        {error !== null && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-indigo-200 py-2.5 text-sm font-semibold text-indigo-900 transition-colors hover:bg-indigo-300 disabled:opacity-60"
        >
          {submitting ? "가입 중…" : "회원가입"}
        </button>
      </form>

      <p className="mt-4 text-sm text-gray-600">
        이미 계정이 있으신가요?{" "}
        <Link href="/login" className="text-indigo-600 underline">
          로그인
        </Link>
      </p>
    </main>
  );
}
