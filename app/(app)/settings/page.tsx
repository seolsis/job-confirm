"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * S10 — 설정 / 마이페이지 (PRD 3.1, MVP 최소).
 *
 * 계정 정보(이메일·가입일·로그인 방식), 바로가기, 로그아웃, 회원 탈퇴.
 * 알림은 MVP에 없으므로 "준비 중"으로 정직하게 표시한다.
 * 탈퇴는 DELETE /api/account — auth.users 삭제 시 사용자 데이터는
 * FK cascade로 완전 삭제된다 (PRD 7.2 개인정보 요건).
 */

interface AccountInfo {
  email: string | null;
  createdAt: string | null;
  provider: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  email: "이메일",
  google: "Google",
};

export default function SettingsPage() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // 탈퇴 2단계 확인 — 브라우저 confirm 대신 인라인 확인 UI
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user !== null) {
        setAccount({
          email: user.email ?? null,
          createdAt: user.created_at ?? null,
          provider: user.app_metadata.provider ?? "email",
        });
      }
      setLoading(false);
    })();
  }, [supabase]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.assign("/login");
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch("/api/account", { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "탈퇴 처리에 실패했어. 잠시 후 다시 시도해 줘.");
        setDeleting(false);
        return;
      }
      // 서버가 세션을 정리했지만 브라우저 저장분도 비운다
      await supabase.auth.signOut();
      window.location.assign("/");
    } catch {
      setError("네트워크가 불안정한 것 같아. 잠시 후 다시 시도해 줘.");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
        <p className="text-center text-sm text-stone-400">
          <span className="animate-hop inline-block text-3xl" aria-hidden>
            ⚙️
          </span>
          <br />
          설정을 가져오는 중…
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
      <nav className="fixed top-4 right-4 z-10">
        <Link
          href="/analyze"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🔍</span> 공고 분석하러 가기
        </Link>
      </nav>

      <div className="mx-auto max-w-xl">
        <div className="text-center">
          <span className="inline-block animate-float text-6xl" aria-hidden>
            🦔
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-sm text-sm text-stone-600">
            여행 가방을 정리하는 곳이야. 계정이랑 데이터를 관리할 수 있어.
          </div>
        </div>

        {/* 계정 정보 */}
        <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <h1 className="text-xl text-stone-700">설정</h1>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-stone-400">이메일</dt>
              <dd className="truncate text-stone-700">{account?.email ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">로그인 방식</dt>
              <dd className="text-stone-700">
                {PROVIDER_LABELS[account?.provider ?? ""] ?? account?.provider}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">함께한 날</dt>
              <dd className="text-stone-700">
                {account?.createdAt !== null && account?.createdAt !== undefined
                  ? `${new Date(account.createdAt).toLocaleDateString("ko-KR")}부터`
                  : "—"}
              </dd>
            </div>
          </dl>
        </section>

        {/* 바로가기 */}
        <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <h2 className="text-base text-stone-700">🧭 바로가기</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/profile"
              className="rounded-full border-2 border-amber-100 bg-white px-4 py-2 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
            >
              🐥 내 프로필
            </Link>
            <Link
              href="/board"
              className="rounded-full border-2 border-amber-100 bg-white px-4 py-2 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
            >
              🗂️ 취준 보드
            </Link>
          </div>
        </section>

        {/* 약관·정책 (M4-5) */}
        <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <h2 className="text-base text-stone-700">📜 약관과 정책</h2>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <Link
              href="/terms"
              className="rounded-full border-2 border-amber-100 bg-white px-4 py-2 text-stone-600 transition-transform hover:-translate-y-0.5"
            >
              이용약관
            </Link>
            <Link
              href="/privacy"
              className="rounded-full border-2 border-amber-100 bg-white px-4 py-2 text-stone-600 transition-transform hover:-translate-y-0.5"
            >
              개인정보처리방침
            </Link>
          </div>
        </section>

        {/* 알림 — MVP 미제공 (정직하게 준비 중 표시) */}
        <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <h2 className="text-base text-stone-700">🔔 알림</h2>
          <p className="mt-2 text-sm text-stone-400">
            마감·면접 알림은 준비 중이야. 곧 편지를 보낼 수 있게 될 거야!
          </p>
        </section>

        {/* 로그아웃 */}
        <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <h2 className="text-base text-stone-700">🎒 여행 잠시 쉬기</h2>
          <p className="mt-2 text-sm text-stone-400">데이터는 그대로 남아 있어. 언제든 돌아와!</p>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="mt-3 rounded-full border-2 border-amber-100 bg-white px-5 py-2 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
          >
            로그아웃
          </button>
        </section>

        {/* 회원 탈퇴 — 2단계 확인 */}
        <section className="mt-6 rounded-[2rem] border-2 border-rose-100 bg-white p-6">
          <h2 className="text-base text-stone-700">🌧️ 여행 끝내기 (회원 탈퇴)</h2>
          <p className="mt-2 text-sm text-stone-400">
            프로필, 분석 결과, 취준 보드가 <strong className="text-rose-500">모두 삭제</strong>되고
            되돌릴 수 없어.
          </p>

          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="mt-3 rounded-full border-2 border-rose-100 bg-white px-5 py-2 text-sm text-rose-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
            >
              탈퇴하기
            </button>
          ) : (
            <div className="mt-3 rounded-2xl border-2 border-rose-100 bg-rose-50/60 p-4">
              <p className="text-sm text-rose-600">정말 모든 데이터를 삭제하고 떠날 거야?</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleDeleteAccount()}
                  disabled={deleting}
                  className="rounded-full bg-rose-400 px-5 py-2 text-sm text-white transition-colors hover:bg-rose-500 disabled:opacity-60"
                >
                  {deleting ? "삭제하는 중…" : "응, 모두 삭제할게"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="rounded-full border-2 border-stone-200 bg-white px-5 py-2 text-sm text-stone-500"
                >
                  아니, 더 여행할래
                </button>
              </div>
            </div>
          )}

          {error !== null && (
            <p className="mt-3 rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              🥺 {error}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
