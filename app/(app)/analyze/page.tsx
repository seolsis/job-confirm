"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

/**
 * S4 — 메인 공고 입력 (M2-4, PRD 3.2). 제품의 얼굴 — 검색엔진처럼 단순하게.
 *
 * URL 입력 + 붙여넣기 폴백(수집 실패 대응, PRD 7.1의 MVP 필수 항목).
 * POST /api/analyses는 파이프라인을 동기로 완주하므로(수십 초) 제출 중 상태를
 * 유지하다가, 성공/실패 모두 jobId가 있으면 S6(/analyze/{jobId})로 이동한다 —
 * 실패한 잡도 error_code 안내를 S6가 표시한다.
 *
 * UI: 화이트 기반 미니멀 + 파스텔 저채도 (프로젝트 디자인 방향).
 */

type InputMode = "url" | "paste";

export default function AnalyzeInputPage() {
  const [mode, setMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNeedsProfile(false);
    setSubmitting(true);

    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "url" ? { url } : { pastedText }),
      });
      const data = (await response.json()) as {
        jobId?: string;
        error?: string;
        code?: string;
        errorCode?: string;
      };

      // 성공이든 파이프라인 실패든 잡이 만들어졌다면 S6가 상태를 보여준다
      if (typeof data.jobId === "string") {
        window.location.assign(`/analyze/${data.jobId}`);
        return;
      }
      if (data.code === "profile_required") {
        setNeedsProfile(true);
        setSubmitting(false);
        return;
      }
      setError(data.error ?? "분석 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      setSubmitting(false);
    } catch {
      setError("네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-16">
      <h1 className="text-center text-2xl font-bold text-slate-800">이 공고, 나한테 맞을까?</h1>
      <p className="mt-3 text-center text-sm text-slate-500">
        채용공고 URL을 붙여넣으면 AI가 내 프로필과 비교해 적합도를 알려드려요.
      </p>

      {/* 입력 방식 토글 — URL / 본문 붙여넣기 폴백 */}
      <div className="mt-8 flex justify-center gap-2">
        <ModeButton active={mode === "url"} onClick={() => setMode("url")}>
          URL로 분석
        </ModeButton>
        <ModeButton active={mode === "paste"} onClick={() => setMode("paste")}>
          본문 붙여넣기
        </ModeButton>
      </div>

      <form onSubmit={handleSubmit} className="mt-4">
        {mode === "url" ? (
          <input
            type="url"
            required
            placeholder="https://www.wanted.co.kr/wd/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm shadow-sm outline-none placeholder:text-slate-300 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
        ) : (
          <textarea
            required
            rows={10}
            placeholder="공고 본문을 통째로 붙여넣어 주세요 (수집이 안 되는 사이트도 분석할 수 있어요)"
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm shadow-sm outline-none placeholder:text-slate-300 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
        )}

        {error !== null && <p className="mt-3 text-sm text-rose-500">{error}</p>}
        {needsProfile && (
          <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
            분석하려면 프로필이 필요해요.{" "}
            <Link href="/profile/onboarding" className="font-medium underline">
              1분 만에 입력하기
            </Link>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-4 w-full rounded-xl bg-indigo-200 py-3.5 text-sm font-semibold text-indigo-900 transition-colors hover:bg-indigo-300 disabled:opacity-60"
        >
          {submitting ? "분석 중… (30초 정도 걸려요)" : "분석하기"}
        </button>
      </form>

      {submitting && (
        <p className="mt-4 text-center text-xs text-slate-400">
          공고를 수집하고 프로필과 비교하는 중이에요. 잠시만 기다려 주세요.
        </p>
      )}

      <p className="mt-10 text-center text-xs text-slate-400">
        AI 분석은 참고용이에요. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
      </p>
    </main>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
        active ? "bg-indigo-100 font-medium text-indigo-800" : "text-slate-400 hover:text-slate-600"
      }`}
    >
      {children}
    </button>
  );
}
