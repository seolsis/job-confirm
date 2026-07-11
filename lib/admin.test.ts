import { afterEach, describe, expect, it, vi } from "vitest";

import { isAdminEmail } from "./admin";

describe("isAdminEmail (env ADMIN_EMAILS)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("등록된 이메일만 허용한다 (대소문자·공백 무시)", () => {
    vi.stubEnv("ADMIN_EMAILS", "Admin@Example.com , second@example.com");
    expect(isAdminEmail("admin@example.com")).toBe(true);
    expect(isAdminEmail("SECOND@EXAMPLE.COM")).toBe(true);
    expect(isAdminEmail("other@example.com")).toBe(false);
  });

  it("env 미설정이면 아무도 어드민이 아니다", () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    expect(isAdminEmail("admin@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});
