/**
 * robots.txt 준수 — ARCHITECTURE.md 3.2, PRD 7.2 (크롤링 법무 리스크).
 *
 * 단순화한 REP(Robots Exclusion Protocol) 구현:
 *  - User-agent 그룹 중 우리 토큰과 일치하는 그룹 우선, 없으면 * 그룹
 *  - Allow/Disallow 중 매칭 패턴이 더 긴(구체적인) 규칙이 이김, 같으면 Allow 우선
 *  - 패턴의 *(와일드카드)와 $(끝 고정)을 지원
 *  - robots.txt를 가져올 수 없으면(404, 네트워크 오류) 허용으로 간주 (일반 관행)
 */

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface RobotsGroup {
  agents: string[]; // 소문자
  rules: RobotsRule[];
}

/** origin별 파싱 결과 캐시 (호출마다 robots.txt를 다시 받지 않도록) */
const cache = new Map<string, { groups: RobotsGroup[]; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // 연속된 User-agent 줄은 같은 그룹을 공유한다
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!current) continue; // 그룹 없는 규칙은 무시
      if (value === "" && field === "disallow") continue; // "Disallow:" (빈 값) = 전체 허용
      current.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** 패턴 매칭: *는 임의 문자열, 말단 $는 끝 고정 */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    "^" + body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + (anchored ? "$" : "")
  );
  return regex.test(path);
}

/** 파싱된 그룹에서 해당 경로의 허용 여부 판정 (순수 함수 — 단위 테스트 대상) */
export function isPathAllowed(
  groups: RobotsGroup[],
  path: string,
  userAgentToken: string
): boolean {
  const token = userAgentToken.toLowerCase();

  // 우리 토큰과 일치하는 그룹 우선, 없으면 * 그룹
  let applicable = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  if (applicable.length === 0) {
    applicable = groups.filter((g) => g.agents.includes("*"));
  }

  let best: { allow: boolean; length: number } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, path)) continue;
      const length = rule.pattern.length;
      if (
        best === null ||
        length > best.length ||
        (length === best.length && rule.allow && !best.allow)
      ) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return best?.allow ?? true; // 매칭 규칙 없음 = 허용
}

/** URL의 robots.txt 허용 여부 확인. fetchFn 주입으로 단위 테스트 가능 */
export async function isAllowedByRobots(
  url: URL,
  userAgentToken: string,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  const origin = url.origin;
  const cached = cache.get(origin);
  let groups: RobotsGroup[];

  if (cached && cached.expiresAt > Date.now()) {
    groups = cached.groups;
  } else {
    try {
      const res = await fetchFn(`${origin}/robots.txt`, {
        headers: { "user-agent": userAgentToken },
        signal: AbortSignal.timeout(5_000),
      });
      groups = res.ok ? parseRobotsTxt(await res.text()) : [];
    } catch {
      groups = []; // robots.txt 접근 불가 = 허용으로 간주
    }
    cache.set(origin, { groups, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  const path = url.pathname + url.search;
  return isPathAllowed(groups, path, userAgentToken);
}

/** 테스트용: 캐시 초기화 */
export function clearRobotsCache(): void {
  cache.clear();
}
