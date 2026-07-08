/**
 * Supabase 공개 환경 변수 접근 헬퍼.
 *
 * NEXT_PUBLIC_* 값은 빌드 시 클라이언트 번들에 인라인되므로
 * 반드시 `process.env.NEXT_PUBLIC_...` 리터럴로 참조해야 한다.
 * 서버 전용 키(SUPABASE_SERVICE_ROLE_KEY)는 여기 두지 않는다 — service-role.ts 참고.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `환경 변수 ${name}이(가) 설정되지 않았습니다. .env.example을 참고해 .env.local을 채워주세요.`
    );
  }
  return value;
}

export function supabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function supabaseAnonKey(): string {
  return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
