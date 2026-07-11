/**
 * 어드민 판별 (M4-4) — env ADMIN_EMAILS(콤마 구분)에 등록된 이메일만.
 * 별도 역할 테이블 없이 최소로 간다 (PRD S 어드민 "최소 기능").
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (email === null || email === undefined || email === "") return false;
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return admins.includes(email.toLowerCase());
}
