import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 이번 마일스톤(M1-6)의 검증 대상은 AI 구조화 모듈이다.
      // client.ts는 "server-only" import 때문에 vitest에서 로드할 수 없어 제외
      // (server-only 강제가 곧 목적인 파일이므로 단위 테스트 대상이 아님).
      include: ["lib/ai/**"],
      exclude: ["lib/ai/client.ts"],
    },
  },
});
