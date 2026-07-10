import type { Metadata } from "next";
import { Jua } from "next/font/google";
import "./globals.css";

// 둥근 한글 디스플레이 폰트 — "동물 친구들" 세계관의 목소리 (single weight)
const jua = Jua({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-jua",
  display: "swap",
});

export const metadata: Metadata = {
  title: "잡프렌즈 — 취업 준비를 함께하는 동물 친구들",
  description:
    "채용공고 URL을 붙여넣으면 동물 친구들이 공고를 분석하고 내 프로필과 비교해 적합도를 알려줘요.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${jua.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
