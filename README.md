# job-confirm — AI 채용공고 분석 서비스

채용공고 URL을 붙여넣으면 AI가 공고를 분석하고, 내 프로필과 비교해 적합도를 알려주는 서비스.

> "이 공고, 나한테 맞아?"라는 질문에 30초 안에 근거 있는 답을 준다.

## 문서

| 문서                                                       | 내용                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| [docs/PRD.md](./docs/PRD.md)                               | 제품 기획서 — 서비스 구조, 사용자 플로우, 화면/기능, MVP 정의 |
| [docs/AI_ANALYSIS_DESIGN.md](./docs/AI_ANALYSIS_DESIGN.md) | AI 분석 파이프라인 설계 — 2단계 분석, 점수 산식, 데이터 저장  |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)             | 기술 아키텍처 — Next.js + Supabase 스택 결정, 프로젝트 구조   |

## 기술 스택

- **Next.js** (App Router, TypeScript) — 프론트엔드 + Route Handlers 백엔드
- **Tailwind CSS** — 스타일링 (반응형 웹)
- **Supabase** — Postgres / Auth / Realtime / Storage _(예정)_
- **Anthropic Claude API** — 공고 구조화 + 프로필 매칭 분석 _(예정)_
- **Vercel** — 배포 _(예정)_

## 시작하기

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정 (.env.example 참고)
#    .env.local 파일을 만들고 키를 채운다
cp .env.example .env.local

# 3. 개발 서버 실행
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 연다.

## 스크립트

| 명령                   | 설명                 |
| ---------------------- | -------------------- |
| `npm run dev`          | 개발 서버 실행       |
| `npm run build`        | 프로덕션 빌드        |
| `npm run start`        | 프로덕션 서버 실행   |
| `npm run lint`         | ESLint 검사          |
| `npm run format`       | Prettier 포맷팅 적용 |
| `npm run format:check` | Prettier 포맷팅 검사 |

## 프로젝트 구조

```
job-confirm/
├─ app/
│  ├─ (marketing)/            # 랜딩 (비로그인)
│  ├─ (auth)/login, signup/   # 회원가입 / 로그인
│  ├─ (app)/                  # 로그인 필수 영역 (미들웨어 가드)
│  │  ├─ analyze/             # 공고 입력 + 분석 진행 + 결과
│  │  ├─ board/               # 취준탭 칸반 + 카드 상세
│  │  ├─ profile/             # 프로필 관리
│  │  └─ settings/            # 설정 / 마이페이지
│  └─ api/
│     └─ analyses/            # 분석 파이프라인 API
├─ lib/
│  ├─ supabase/               # 클라이언트 팩토리 (browser/server/service-role)
│  ├─ scraper/                # 사이트 어댑터 + 범용 추출기 + 정제
│  └─ ai/                     # 구조화 → 매칭 → 점수 파이프라인
│     └─ prompts/             # 버전별 프롬프트
├─ supabase/
│  └─ migrations/             # SQL 마이그레이션 (스키마의 단일 진실)
└─ docs/                      # PRD, 설계 문서
```

## 개발 마일스톤

1. **M1 — 분석 코어**: 수집 → 구조화 → 매칭 → 결과 화면 _(M1-1 프로젝트 세팅 완료)_
2. **M2 — 계정·프로필**: Supabase Auth, 온보딩, 프로필 관리
3. **M3 — 취준탭**: 칸반 보드, 상태 관리, D-day
4. **M4 — 런칭 준비**: 쿼터, 피드백, 랜딩, 배포

자세한 내용은 [docs/ARCHITECTURE.md 7장](./docs/ARCHITECTURE.md#7-mvp-구현-순서-기술-관점) 참고.
