"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * S2 — 로그인 (M2-1, PRD 3.1). MVP는 이메일 로그인부터, Google OAuth는 M2 후반.
 *
 * 성공 시 전체 내비게이션(location.assign)으로 이동한다 — @supabase/ssr이 심은
 * 세션 쿠키를 서버(proxy·Route Handler)가 확실히 읽게 하기 위함.
 * 미인증으로 보호 경로에 접근하면 proxy가 ?next=<경로>를 붙여 여기로 보낸다.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createBrowserSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setSubmitting(false);
      setError(
        signInError.message === "Invalid login credentials"
          ? "이메일 또는 비밀번호가 올바르지 않습니다."
          : `로그인에 실패했습니다: ${signInError.message}`
      );
      return;
    }

    // proxy 가드가 붙여준 원래 목적지로 복귀 (없으면 홈)
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next !== null && next.startsWith("/") ? next : "/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-xl font-bold">로그인</h1>

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
          비밀번호
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>

        {error !== null && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "로그인 중…" : "로그인"}
        </button>
      </form>

      <p className="mt-4 text-sm text-gray-600">
        계정이 없으신가요?{" "}
        <Link href="/signup" className="text-blue-600 underline">
          회원가입
        </Link>
      </p>
    </main>
  );
}
