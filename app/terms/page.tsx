import type { Metadata } from "next";
import Link from "next/link";

/**
 * 이용약관 (M4-5, PRD 7.2 #10) — 정적 페이지.
 * ⚠️ 초안 — 런칭 전 법무 검토 필수 (특히 크롤링·AI 분석 면책 조항).
 */

export const metadata: Metadata = { title: "이용약관 — 잡프렌즈" };

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#fef6e4] px-4 py-16">
      <div className="mx-auto max-w-2xl rounded-[2rem] border-2 border-amber-100 bg-white p-8 shadow-[0_4px_0_#fde68a]">
        <h1 className="text-2xl text-stone-700">이용약관</h1>
        <p className="mt-1 text-xs text-stone-400">시행일: 2026년 7월 11일</p>

        <div className="mt-6 space-y-5 text-sm leading-relaxed text-stone-600">
          <section>
            <h2 className="text-base text-stone-700">제1조 (목적)</h2>
            <p>
              이 약관은 잡프렌즈(이하 &ldquo;서비스&rdquo;)의 이용 조건과 절차, 이용자와 운영자의
              권리·의무를 정합니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">제2조 (서비스의 내용)</h2>
            <p>
              서비스는 이용자가 제공한 채용공고(URL 또는 본문)와 이용자가 입력한 프로필을 바탕으로
              AI가 공고를 구조화하고 적합도를 분석한 결과를 제공하며, 지원 현황을 관리하는 보드를
              제공합니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">제3조 (AI 분석 결과의 한계)</h2>
            <p>
              AI 분석 결과는 <strong>참고용 정보</strong>이며 정확성·완전성을 보장하지 않습니다.
              지원 여부 등 최종 판단과 그 결과에 대한 책임은 이용자에게 있습니다. 이용자는 반드시
              공고 원문을 확인해야 합니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">제4조 (공고 데이터의 취급)</h2>
            <p>
              서비스는 이용자가 요청한 채용공고의 본문을 분석 목적으로만 수집·보관합니다. 수집한
              공고 스냅샷은 이용자의 열람 편의(공고 마감·삭제 대비)를 위한 사적 이용 범위로
              한정되며, 별도 재배포하지 않습니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">제5조 (무료 이용 한도)</h2>
            <p>
              무료 플랜의 분석 횟수는 월 단위로 제한되며, 한도와 정책은 서비스 화면에 표시합니다.
              운영자는 사전 고지 후 한도를 변경할 수 있습니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">제6조 (계정과 탈퇴)</h2>
            <p>
              이용자는 언제든 설정 화면에서 탈퇴할 수 있으며, 탈퇴 시 프로필·분석 결과·보드 등 개인
              데이터는 즉시 삭제됩니다 (개인정보처리방침 참조).
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">제7조 (금지 행위)</h2>
            <p>
              자동화 수단을 통한 대량 요청, 타인의 개인정보 입력, 서비스의 정상 운영을 방해하는
              행위를 금지합니다.
            </p>
          </section>
        </div>

        <div className="mt-8 flex gap-4 text-sm">
          <Link href="/privacy" className="text-amber-600 underline">
            개인정보처리방침
          </Link>
          <Link href="/" className="text-stone-400 underline">
            홈으로
          </Link>
        </div>
      </div>
    </main>
  );
}
