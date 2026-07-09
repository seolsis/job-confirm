import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // tsconfig의 "@/*" 경로 별칭 (vitest는 tsconfig paths를 자동 해석하지 않는다)
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 검증 대상: AI 구조화 모듈(M1-6) + 저장 계층·서비스(M1-7).
      // client.ts는 "server-only" import 때문에 vitest에서 로드할 수 없어 제외
      // (server-only 강제가 곧 목적인 파일이므로 단위 테스트 대상이 아님).
      include: ["lib/ai/**", "lib/db/**"],
      exclude: ["lib/ai/client.ts"],
    },
  },
});
