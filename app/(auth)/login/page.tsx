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

    // proxy 가드가 붙여준 원래 목적지로 복귀 (없으면 공고 입력 화면)
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next !== null && next.startsWith("/") ? next : "/analyze");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-4 py-12">
      <div className="w-full max-w-sm rounded-3xl border border-slate-100 bg-white p-8 shadow-xl shadow-slate-200/60">
        <h1 className="text-2xl font-bold text-slate-800">로그인</h1>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            이메일
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition-colors focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            비밀번호
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition-colors focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
            />
          </label>

          {error !== null && (
            <p className="rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm text-rose-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-indigo-200 py-2.5 text-sm font-semibold text-indigo-900 shadow-sm shadow-indigo-100 transition-colors hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "로그인 중…" : "로그인"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          계정이 없으신가요?{" "}
          <Link href="/signup" className="font-medium text-indigo-600 hover:text-indigo-700">
            회원가입
          </Link>
        </p>
      </div>
    </main>
  );
}
