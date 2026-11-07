// ADR-0218 §14 M2.7·M2.3·M2.5: 포트의 순수 규칙. 바이트 상한은 개수가 아니라 바이트로 세고(MA11), 수명은 마지막으로 읽거나 쓴 뒤에서 센다.
import { describe, expect, it } from "vitest";
import type { Expression } from "./types";
import {
  EXPRESSION_DISK_BUDGET_BYTES,
  EXPRESSION_DISK_LAST_READ_GRANULARITY_MS,
  EXPRESSION_DISK_LIFETIME_MS,
  EXPRESSION_DISK_PREFIX,
  expressionDiskKey,
  expressionDiskName,
  expressionIdOfDiskKey,
  activeDiskKeys,
  isExpressionDiskName,
  isListedDiskTarget,
  listedDiskTarget,
  parseExpressionImagePath,
  planTrim,
  shouldTouchLastRead,
  type DiskEntryMeta,
} from "./diskCache";

const ID = "00000000-0000-4000-8000-000000000011";
const SHA = "ab".repeat(32);
const WS = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";


describe("칸 이름과 키", () => {
  it("칸 이름은 워크스페이스·멤버 둘 다 들어가고 `oort-shell-` 로 시작하지 않으며, uuid 가 아니면 만들지 않는다", () => {
    const name = expressionDiskName(WS, ME)!;
    expect(name).toBe(`${EXPRESSION_DISK_PREFIX}${WS}.${ME}`);
    expect(name.startsWith("oort-shell-")).toBe(false);
    expect(isExpressionDiskName(name)).toBe(true);
    expect(isExpressionDiskName("oort-shell-v1")).toBe(false);
    expect(expressionDiskName(WS, "someone")).toBeNull();
    expect(expressionDiskName("../x", ME)).toBeNull();
    expect(expressionDiskName(WS, ME)).not.toBe(expressionDiskName(WS, "00000000-0000-4000-8000-0000000000aa"));
  });

  it("활성 그림 주소만 읽는다: 초안·그 밖의 모양·틀린 size·틀린 sha 는 null 이다(디스크를 아예 보지 않는다)", () => {
    const ok = parseExpressionImagePath(`/v1/workspaces/${WS}/expressions/${ID}/image?size=large&v=${SHA}`);
    expect(ok).toEqual({ id: ID, size: "large", sha: SHA, key: expressionDiskKey(ID, "large", SHA) });
    expect(expressionIdOfDiskKey(ok!.key)).toBe(ID);
    expect(parseExpressionImagePath(`/v1/workspaces/${WS}/expression-drafts/${ID}/image?size=large&v=${SHA}`)).toBeNull();
    expect(parseExpressionImagePath(`/v1/workspaces/${WS}/expressions/${ID}/image?size=huge&v=${SHA}`)).toBeNull();
    expect(parseExpressionImagePath(`/v1/workspaces/${WS}/expressions/${ID}/image?size=large&v=${SHA.slice(2)}`)).toBeNull();
    // 서버의 id 는 소문자다. 대문자가 섞인 주소는 다른 표현이거나 위조라서 디스크를 보지 않는다.
    expect(parseExpressionImagePath(`/v1/workspaces/${WS}/expressions/00000000-0000-4abc-8000-00000000000A/image?size=large&v=${SHA}`)).toBeNull();
    expect(parseExpressionImagePath("/a")).toBeNull();
  });
});

describe("청소 계획 (planTrim)", () => {
  const meta = (size: number, lastReadAt: number, writtenAt = lastReadAt): DiskEntryMeta => ({ size, writtenAt, lastReadAt });
  const now = 10 * EXPRESSION_DISK_LIFETIME_MS;

  it("수명: 마지막으로 읽거나 쓴 뒤 7일이 지난 항목만 고른다(최근에 읽은 옛 항목은 남긴다)", () => {
    const entries = new Map([
      ["old", meta(10, now - EXPRESSION_DISK_LIFETIME_MS - 1)],
      ["edge", meta(10, now - EXPRESSION_DISK_LIFETIME_MS)],
      ["read-recently", meta(10, now - 1000, now - EXPRESSION_DISK_LIFETIME_MS * 3)],
    ]);
    expect(planTrim(entries, now)).toEqual(["old"]);
  });

  it("상한은 개수가 아니라 바이트로 센다: 오래 읽지 않은 것부터 예산 안이 될 때까지만 버린다", () => {
    const entries = new Map([
      ["a", meta(10, now - 400)],
      ["b", meta(10, now - 300)],
      ["c", meta(10, now - 200)],
      ["d", meta(10, now - 100)],
    ]);
    // 합 40, 예산 25: 오래 읽지 않은 a·b 둘만 버려 20 이 된다(개수로 세어 3개 상한을 두면 하나만 버려 30 > 25 가 남는다).
    expect(planTrim(entries, now, 25)).toEqual(["a", "b"]);
    // 크기가 제각각이면 바이트로 센다: 큰 것 하나가 오래됐으면 그것 하나로 끝난다.
    const uneven = new Map([["big", meta(200, now - 400)], ["x", meta(10, now - 300)], ["y", meta(10, now - 200)]]);
    expect(planTrim(uneven, now, 215)).toEqual(["big"]);
    expect(planTrim(uneven, now, 1000)).toEqual([]);
  });

  it("기본 상한은 128 MiB·수명은 7일이다", () => {
    expect(EXPRESSION_DISK_BUDGET_BYTES).toBe(128 * 1024 * 1024);
    expect(EXPRESSION_DISK_LIFETIME_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("마지막 읽은 시각은 1분 단위로만 다시 쓴다", () => {
    const entry = meta(10, 1_000_000);
    expect(shouldTouchLastRead(entry, 1_000_000 + EXPRESSION_DISK_LAST_READ_GRANULARITY_MS - 1)).toBe(false);
    expect(shouldTouchLastRead(entry, 1_000_000 + EXPRESSION_DISK_LAST_READ_GRANULARITY_MS)).toBe(true);
  });
});

describe("목록 대조(읽기 문 3번·대조 청소의 기준)", () => {
  const media = (sha: string) => ({ mime: "image/png" as const, sha256: sha, bytes: 10, width: 8, height: 8, frameCount: 1, durationMs: 0 });
  const item = (id: string, status: "active" | "hidden", sha: string): Expression => ({
    id, workspaceId: WS, name: "x", displayName: "x", tags: [], subjectMemberId: null, version: "1", status, kind: "sticker",
    media: status === "active" ? { small: media(sha), large: media(sha), thumb: media(sha) } : null,
    origin: { kind: "upload", sourceUrl: null, prompt: null }, createdBy: ME, createdAtMs: 0,
  });
  const path = (id: string, sha: string) => `/v1/workspaces/${WS}/expressions/${id}/image?size=large&v=${sha}`;

  it("주소의 (id, size, sha) 가 active 항목의 sha 와 같을 때만 대상이다. 숨김·삭제·다른 sha·초안 주소는 대상이 아니다", () => {
    const items = [item(ID, "active", SHA)];
    expect(listedDiskTarget(items, path(ID, SHA))?.media.sha256).toBe(SHA);
    expect(isListedDiskTarget(items, parseExpressionImagePath(path(ID, SHA))!)).toBe(true);
    expect(listedDiskTarget(items, path(ID, "cd".repeat(32)))).toBeNull(); // 그림이 바뀌었다(옛 sha)
    expect(listedDiskTarget([item(ID, "hidden", SHA)], path(ID, SHA))).toBeNull(); // 숨김
    expect(listedDiskTarget([], path(ID, SHA))).toBeNull(); // 목록에 없다
    expect(listedDiskTarget(items, `/v1/workspaces/${WS}/expression-drafts/${ID}/image?size=large&v=${SHA}`)).toBeNull();
  });

  it("활성 키는 active 항목의 세 크기뿐이다", () => {
    const keys = activeDiskKeys([item(ID, "active", SHA), item("00000000-0000-4000-8000-000000000012", "hidden", SHA)]);
    expect([...keys].sort()).toEqual(["large", "small", "thumb"].map((size) => expressionDiskKey(ID, size as "small", SHA)).sort());
  });
});
