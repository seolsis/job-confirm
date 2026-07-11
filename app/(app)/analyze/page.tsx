"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

/**
 * S4 — 메인 공고 입력 (PRD 3.2). "동물 친구들의 모험" 컨셉:
 * 토돌이(🐰)에게 공고를 건네주는 화면. 검색엔진처럼 단순하게.
 *
 * URL 입력 + 붙여넣기 폴백(수집 실패 대응, PRD 7.1의 MVP 필수 항목).
 * POST /api/analyses는 파이프라인을 동기로 완주하므로(수십 초) 제출 중에는
 * 친구들이 일하는 연출을 보여주고, 성공/실패 모두 jobId가 있으면
 * S6(/analyze/{jobId})로 이동한다 — 실패한 잡도 error_code 안내를 S6가 표시한다.
 *
 * 첫 진입에는 여행 안내(S13 온보딩 튜토리얼, 간이)를 보여준다 — localStorage로
 * 1회만. 닫으면 다시 나오지 않는다.
 */

type InputMode = "url" | "paste";

/** S13 튜토리얼 "봤음" 플래그 — 기기(브라우저) 단위로 충분해 localStorage 사용 */
const TUTORIAL_SEEN_KEY = "jobConfirm.tutorialSeen";

/** useSearchParams는 정적 페이지에서 Suspense 경계가 필요하다 (Next 규칙) */
export default function AnalyzeInputPage() {
  return (
    <Suspense fallback={null}>
      <AnalyzeInputForm />
    </Suspense>
  );
}

function AnalyzeInputForm() {
  // 실패 화면의 "본문 붙여넣기로 다시" 버튼이 ?mode=paste로 진입시킨다
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<InputMode>(
    searchParams.get("mode") === "paste" ? "paste" : "url"
  );
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);

  // S13 — 첫 진입에만 여행 안내를 보여준다. 이 컴포넌트는 useSearchParams로
  // Suspense 경계까지 클라이언트 렌더링되므로 초기값에서 localStorage를 읽어도
  // 서버 HTML과 불일치가 생기지 않는다 (typeof window 가드는 방어용).
  const [showTutorial, setShowTutorial] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(TUTORIAL_SEEN_KEY) === null
  );

  function dismissTutorial() {
    window.localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    setShowTutorial(false);
  }

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
      setError(data.error ?? "분석 요청에 실패했어. 잠시 후 다시 시도해 줄래?");
      setSubmitting(false);
    } catch {
      setError("네트워크가 불안정한 것 같아. 잠시 후 다시 시도해 줘!");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-16">
      {/* 상단 내비 — 취준탭(S7)·프로필(S9)·설정(S10) 진입점 (상시 노출) */}
      <nav className="fixed top-4 right-4 z-10 flex gap-2">
        <Link
          href="/board"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🗂️</span> 취준 보드
        </Link>
        <Link
          href="/profile"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🐥</span> 내 프로필
        </Link>
        <Link
          href="/settings"
          aria-label="설정"
          className="flex items-center rounded-full border-2 border-amber-100 bg-white/90 px-3 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>⚙️</span>
        </Link>
      </nav>

      <div className="w-full max-w-2xl">
        {/* S13 — 첫 여행 안내 (간이 온보딩 튜토리얼, 1회 노출) */}
        {showTutorial && !submitting && (
          <div className="animate-pop-in mb-8 rounded-[2rem] border-2 border-sky-100 bg-white/90 p-6 shadow-[0_4px_0_#bae6fd]">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base text-stone-700">🗺️ 처음 왔구나! 여행은 이렇게 진행돼</h2>
              <button
                type="button"
                onClick={dismissTutorial}
                aria-label="안내 닫기"
                className="shrink-0 rounded-full px-2 text-stone-300 transition-colors hover:text-stone-500"
              >
                ✕
              </button>
            </div>
            <ol className="mt-4 space-y-3 text-sm text-stone-600">
              <li className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>
                  🔗
                </span>
                <span>
                  <strong className="text-stone-700">① 공고를 건네줘</strong> — 채용공고 URL을
                  붙여넣으면 돼. 안 열리는 사이트는 본문 붙여넣기로!
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>
                  🐾
                </span>
                <span>
                  <strong className="text-stone-700">② 친구들이 분석해</strong> — 다람이가 물어오고,
                  부엉 박사가 정리하고, 토돌이가 네 프로필과 비교해 줘.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>
                  🗂️
                </span>
                <span>
                  <strong className="text-stone-700">③ 보드에 모아 관리해</strong> — 결과 화면에서
                  [취준탭에 저장]을 누르면 관심 공고부터 최종 합격까지 한눈에 관리할 수 있어.
                </span>
              </li>
            </ol>
            <p className="mt-4 text-xs text-stone-400">
              💡{" "}
              <Link href="/profile" className="underline">
                프로필
              </Link>
              을 채울수록 분석이 정확해져!
            </p>
          </div>
        )}

        {/* 토돌이의 인사 */}
        <div className="text-center">
          <span
            className={`inline-block text-6xl ${submitting ? "animate-hop" : "animate-float"}`}
            aria-hidden
          >
            🐰
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-sm text-sm text-stone-600">
            {submitting
              ? "친구들이 출발했어! 공고를 살펴보고 올게."
              : "궁금한 공고를 보여줘! 너한테 맞는지 같이 봐줄게."}
          </div>
        </div>

        <div className="mt-8 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a] sm:p-8">
          <h1 className="text-center text-2xl text-stone-700">이 공고, 나한테 맞을까?</h1>

          {/* 입력 방식 토글 — URL / 본문 붙여넣기 폴백 */}
          <div className="mt-6 flex justify-center gap-1 rounded-full bg-amber-50 p-1">
            <ModeButton active={mode === "url"} onClick={() => setMode("url")}>
              🔗 URL로 분석
            </ModeButton>
            <ModeButton active={mode === "paste"} onClick={() => setMode("paste")}>
              📋 본문 붙여넣기
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
                className="w-full rounded-2xl border-2 border-amber-100 bg-white px-5 py-4 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
              />
            ) : (
              <textarea
                required
                rows={10}
                placeholder="공고 본문을 통째로 붙여넣어 줘 (다람이가 못 가는 사이트도 분석할 수 있어!)"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                className="w-full rounded-2xl border-2 border-amber-100 bg-white px-5 py-4 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
              />
            )}

            {error !== null && (
              <p className="mt-3 rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                🥺 {error}
              </p>
            )}
            {needsProfile && (
              <div className="mt-3 rounded-2xl border-2 border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
                🐥 먼저 너에 대해 알려줘야 비교할 수 있어!{" "}
                <Link href="/profile/onboarding" className="underline">
                  1분 만에 프로필 입력하기
                </Link>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-4 w-full rounded-full bg-amber-300 py-4 text-base text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? "친구들이 분석하는 중… 🐾" : "분석 부탁하기 🔍"}
            </button>
          </form>

          {/* 제출 중 — 친구들이 순서대로 일하러 가는 연출 (hop + 시차) */}
          {submitting && (
            <div className="mt-6 text-center" aria-hidden>
              <div className="flex justify-center gap-4 text-3xl">
                {["🐿️", "🦉", "🐰", "🐢"].map((friend, index) => (
                  <span
                    key={friend}
                    className="animate-hop inline-block"
                    style={{ animationDelay: `${index * 0.15}s` }}
                  >
                    {friend}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-stone-400">30초 정도 걸려. 조금만 기다려 줘!</p>
            </div>
          )}
        </div>

        <p className="mt-8 text-center text-xs text-stone-400">
          친구들의 분석은 참고용이에요. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
        </p>
      </div>
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
      className={`rounded-full px-4 py-2 text-sm transition-colors ${
        active ? "bg-white text-amber-700 shadow-sm" : "text-stone-400 hover:text-stone-600"
      }`}
    >
      {children}
    </button>
  );
}
