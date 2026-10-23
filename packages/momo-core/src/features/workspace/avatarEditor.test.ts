import { describe, expect, it } from "vitest";
import { MEMBER_AVATAR_MAX_BYTES } from "../../lib/api";
import { KOMETTO_EXPRESSIONS, KOMETTO_EXPRESSION_NAMES } from "../onboarding/guide";
import { buildPng, rgbaBuffer } from "./__fixtures__/avatarFixture";
import {
  AVATAR_EDITOR_COPY,
  AVATAR_EMOJI_SCALE,
  AVATAR_PNG_FILE_NAME,
  AVATAR_PNG_MIME,
  AVATAR_PNG_SIZE,
  AVATAR_PRESET_CROP,
  AVATAR_PRESET_IDS,
  AVATAR_SAMPLE_SIZE,
  avatarComposeFailureMessage,
  avatarPresetLabel,
  composeAvatarPng,
  isAvatarPresetId,
  isValidAvatarDraft,
  isValidAvatarGlyph,
  judgeAvatarDraft,
  normalizeFreeColor,
  planAvatar,
  planGlyph,
  renderAvatarPng,
  sampleAvatarForeground,
  type AvatarCanvasPorts,
  type AvatarComposeFailure,
  type AvatarDraft,
  type AvatarForeground,
} from "./avatarEditor";
import { avatarBackgroundById } from "./avatarPalette";

// 아바타 편집기 모델 (#4261): 서버 변경 없이 클라이언트가 그린 정사각 PNG 한 장이 정본이다.

const BUTTER = avatarBackgroundById("butter")!.hex;
const NAVY = avatarBackgroundById("navy")!.hex;
const YELLOW = [255, 204, 77] as const;

const face = (over: Partial<Extract<AvatarDraft, { kind: "emoji" }>> = {}): AvatarDraft => ({
  kind: "emoji",
  emoji: "😀",
  bg: NAVY,
  ...over,
});

interface FakeLayer {
  readonly size: number;
  bg: string | null;
  foreground: AvatarForeground | null;
}

/**
 * 그림판 없이 포트의 계약만 흉내 낸다. `png` 는 포트가 굽는 **바로 그 바이트**이고, 시험은 그것이 한 글자도
 * 바뀌지 않고 나오는지 본다(정본). `glyph` 는 표본 층이 읽혀 주는 픽셀이다.
 */
function fakePorts(
  options: {
    glyph?: ArrayLike<number> | null;
    png?: Uint8Array | null;
    noCanvas?: boolean;
    paintOk?: boolean;
  } = {}
) {
  const log: string[] = [];
  const layers: FakeLayer[] = [];
  const produced = options.png === undefined ? buildPng({ payload: [7, 7, 7, 7, 7, 7] }) : options.png;
  const glyph = options.glyph === undefined ? rgbaBuffer(128 * 128, [{ rgb: YELLOW, count: 2400 }]) : options.glyph;
  const ports: AvatarCanvasPorts<FakeLayer> = {
    createLayer(size) {
      if (options.noCanvas) return null;
      const layer: FakeLayer = { size, bg: null, foreground: null };
      layers.push(layer);
      log.push(`create:${size}`);
      return layer;
    },
    fillBackground(layer, hex) {
      layer.bg = hex;
      log.push(`fill:${layer.size}:${hex}`);
    },
    async paintForeground(layer, foreground) {
      layer.foreground = foreground;
      log.push(`paint:${layer.size}:${foreground.kind}`);
      return options.paintOk !== false;
    },
    readPixels(layer) {
      log.push(`read:${layer.size}`);
      return glyph;
    },
    async toPng(layer) {
      log.push(`png:${layer.size}`);
      return produced;
    },
    release(layer) {
      log.push(`release:${layer.size}`);
    },
  };
  return { ports, log, layers, produced };
}

describe("상수", () => {
  it("정사각 512 PNG 한 장이고, 이름은 이모지·사람 이름을 싣지 않는다", () => {
    expect(AVATAR_PNG_SIZE).toBe(512);
    expect(AVATAR_PNG_MIME).toBe("image/png");
    expect(AVATAR_PNG_FILE_NAME).toBe("avatar.png");
    expect(AVATAR_PNG_FILE_NAME).toMatch(/^[a-z.]+$/);
  });

  it("표본은 본 그림의 1/4 크기(픽셀 1/16)다", () => {
    expect(AVATAR_SAMPLE_SIZE * 4).toBe(AVATAR_PNG_SIZE);
  });

  it("512 PNG 는 서버 상한(5MiB·4096px)보다 한참 작다", () => {
    expect(AVATAR_PNG_SIZE).toBeLessThanOrEqual(4096);
    expect(MEMBER_AVATAR_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("프리셋", () => {
  it("코메토 표정 정본 여섯 id 를 그대로 쓴다 (새 이름을 만들지 않는다)", () => {
    expect([...AVATAR_PRESET_IDS]).toEqual([...KOMETTO_EXPRESSIONS]);
    expect(AVATAR_PRESET_IDS).toHaveLength(6);
    expect(isAvatarPresetId("happy")).toBe(true);
    expect(isAvatarPresetId("joy")).toBe(false);
    expect(isAvatarPresetId(undefined)).toBe(false);
  });

  it("이름은 「코메토 + 정본 표정 이름」이고 서로 다르다", () => {
    for (const id of AVATAR_PRESET_IDS) {
      expect(avatarPresetLabel(id)).toBe(`코메토 ${KOMETTO_EXPRESSION_NAMES[id]}`);
    }
    expect(new Set(AVATAR_PRESET_IDS.map(avatarPresetLabel)).size).toBe(6);
  });

  it("자르기 값은 문서와 같다: 바꾸려면 이 시험과 expressions.md 3절을 함께 고친다", () => {
    expect(AVATAR_PRESET_CROP).toEqual({ x: 0.025, y: 0.105, size: 0.8 });
  });

  it("자르기는 원본 안에 있는 정사각이고 정본 컷을 늘이지 않는다", () => {
    expect(AVATAR_PRESET_CROP.x).toBeGreaterThanOrEqual(0);
    expect(AVATAR_PRESET_CROP.y).toBeGreaterThanOrEqual(0);
    expect(AVATAR_PRESET_CROP.size).toBeGreaterThan(0);
    expect(AVATAR_PRESET_CROP.x + AVATAR_PRESET_CROP.size).toBeLessThanOrEqual(1);
    expect(AVATAR_PRESET_CROP.y + AVATAR_PRESET_CROP.size).toBeLessThanOrEqual(1);
  });
});

describe("normalizeFreeColor", () => {
  it("#rgb · rgb · #rrggbb · rrggbb 를 소문자 #rrggbb 로 편다", () => {
    expect(normalizeFreeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeFreeColor("abc")).toBe("#aabbcc");
    expect(normalizeFreeColor("#1A2B3C")).toBe("#1a2b3c");
    expect(normalizeFreeColor("  1a2b3c ")).toBe("#1a2b3c");
  });

  it("그 밖은 모두 null 이다: 이름 색, rgb(), 8자리, 글자 섞임, 빈 값", () => {
    for (const bad of ["", "#", "red", "rgb(1,2,3)", "#12345", "#1234567", "#12345678", "#gggggg", "##123456", "12 34 56"]) {
      expect(normalizeFreeColor(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("isValidAvatarDraft", () => {
  it("이모지: 비어 있으면 안 되고, ZWJ 가족 이모지는 되며, 너무 길면 안 된다", () => {
    expect(isValidAvatarDraft(face())).toBe(true);
    expect(isValidAvatarDraft(face({ emoji: "" }))).toBe(false);
    expect(isValidAvatarDraft(face({ emoji: "   " }))).toBe(false);
    expect(isValidAvatarDraft(face({ emoji: "👨‍👩‍👧‍👦" }))).toBe(true); // 코드포인트 7개
    expect(isValidAvatarDraft(face({ emoji: "😀".repeat(17) }))).toBe(false);
  });

  it("프리셋: 정본 id 만 되고, 배경은 어느 꼴이든 #rrggbb 여야 한다", () => {
    expect(isValidAvatarDraft({ kind: "preset", preset: "happy", bg: NAVY })).toBe(true);
    expect(isValidAvatarDraft({ kind: "preset", preset: "joy" as never, bg: NAVY })).toBe(false);
    expect(isValidAvatarDraft(face({ bg: "navy" }))).toBe(false);
    expect(isValidAvatarDraft(face({ bg: "#fff" }))).toBe(false);
  });
});

describe("planAvatar: 본 그림과 표본이 같은 계획에서 나온다", () => {
  it("이모지 글꼴 크기는 한 변의 비율이라 표본과 본 그림이 같은 모양이다", () => {
    const big = planAvatar(face(), AVATAR_PNG_SIZE);
    const small = planAvatar(face(), AVATAR_SAMPLE_SIZE);
    expect(big.foreground).toMatchObject({ kind: "emoji", text: "😀", fontPx: Math.round(512 * AVATAR_EMOJI_SCALE) });
    expect(small.foreground).toMatchObject({ kind: "emoji", fontPx: Math.round(128 * AVATAR_EMOJI_SCALE) });
    const ratio = (plan: typeof big) => (plan.foreground.kind === "emoji" ? plan.foreground.fontPx / plan.size : 0);
    expect(Math.abs(ratio(big) - ratio(small))).toBeLessThan(0.01);
    expect(big.bg).toBe(NAVY);
  });

  it("이모지 글리프 상자는 사람 아바타의 안쪽 원(rounded-full)에 들어온다", () => {
    // 글리프 상자는 글꼴 크기의 최대 1.2배. 그 정사각의 꼭짓점이 원 밖으로 나가면 이모지가 잘린다.
    const halfDiagonal = ((AVATAR_EMOJI_SCALE * 1.2) / 2) * Math.SQRT2;
    expect(halfDiagonal).toBeLessThan(0.5);
  });

  it("이모지에는 잉크가 없다: 색 글꼴이 제 색으로 그려진다", () => {
    expect(planAvatar(face(), 512).foreground).not.toHaveProperty("ink");
  });

  it("코메토는 정본 컷 id 와 공통 자르기 비율을 그대로 쓴다", () => {
    for (const preset of AVATAR_PRESET_IDS) {
      expect(planAvatar({ kind: "preset", preset, bg: NAVY }, 512).foreground).toEqual({
        kind: "art",
        art: preset,
        crop: AVATAR_PRESET_CROP,
      });
    }
  });
});

describe("planGlyph · isValidAvatarGlyph", () => {
  it("글리프만 계획한다: 한 변에 대한 글꼴 비율이 크기에 상관없이 같고 코메토는 자르기 비율이 같다", () => {
    for (const size of [112, 128, 512]) {
      expect(planGlyph({ kind: "emoji", emoji: "🚀" }, size)).toEqual({
        kind: "emoji",
        text: "🚀",
        fontPx: Math.round(size * AVATAR_EMOJI_SCALE),
      });
      expect(planGlyph({ kind: "preset", preset: "sleepy" }, size)).toEqual({
        kind: "art",
        art: "sleepy",
        crop: AVATAR_PRESET_CROP,
      });
    }
  });

  it("글리프의 유효성은 배경과 무관하다: 빈 이모지·긴 이모지·모르는 표정은 안 된다", () => {
    expect(isValidAvatarGlyph({ kind: "emoji", emoji: "🚀" })).toBe(true);
    expect(isValidAvatarGlyph({ kind: "emoji", emoji: " " })).toBe(false);
    expect(isValidAvatarGlyph({ kind: "emoji", emoji: "😀".repeat(17) })).toBe(false);
    expect(isValidAvatarGlyph({ kind: "preset", preset: "joy" as never })).toBe(false);
  });

  it("그릴 수 없는 글리프는 그림판을 건드리지 않고 표본도 못 얻는다", async () => {
    const { ports, log } = fakePorts();
    expect(await sampleAvatarForeground(ports, { kind: "emoji", emoji: "" })).toEqual({
      ok: false,
      reason: "paint-failed",
    });
    expect(log).toEqual([]);
  });
});

describe("judgeAvatarDraft", () => {
  it("이모지는 표본을 본다: 표본이 없으면 blank, 묻히면 low-contrast", () => {
    expect(judgeAvatarDraft(face(), null)).toMatchObject({ ok: false, reason: "blank" });
    const yellow = rgbaBuffer(128 * 128, [{ rgb: YELLOW, count: 2400 }]);
    expect(judgeAvatarDraft(face({ bg: BUTTER }), yellow)).toMatchObject({ ok: false, reason: "low-contrast" });
    expect(judgeAvatarDraft(face({ bg: NAVY }), yellow).ok).toBe(true);
  });
});

describe("sampleAvatarForeground", () => {
  it("배경 없이 표본 크기로 글리프만 그려 픽셀을 읽고 층을 놓는다", async () => {
    const { ports, log, layers } = fakePorts();
    const sample = await sampleAvatarForeground(ports, face());
    expect(sample.ok).toBe(true);
    expect(log).toEqual(["create:128", "paint:128:emoji", "read:128", "release:128"]);
    expect(layers[0].bg).toBeNull(); // 배경을 깔지 않는다: 깔면 글리프와 배경을 가를 수 없다
  });

  it("그림판이 없거나 그리지 못하면 이유를 말하고, 그래도 층은 놓는다", async () => {
    expect(await sampleAvatarForeground(fakePorts({ noCanvas: true }).ports, face())).toEqual({
      ok: false,
      reason: "no-canvas",
    });
    const failing = fakePorts({ paintOk: false });
    expect(await sampleAvatarForeground(failing.ports, face())).toEqual({ ok: false, reason: "paint-failed" });
    expect(failing.log).toContain("release:128");
    const unreadable = fakePorts({ glyph: null });
    expect(await sampleAvatarForeground(unreadable.ports, face())).toEqual({ ok: false, reason: "paint-failed" });
  });
});

describe("renderAvatarPng: 판정 없는 미리보기 길", () => {
  it("배경을 먼저 깔고 그 위에 글리프를 그린 뒤 PNG 로 굽는다", async () => {
    const { ports, log, produced } = fakePorts();
    const out = await renderAvatarPng(ports, face());
    expect(out).toMatchObject({ ok: true, width: 512, height: 512 });
    expect(log).toEqual(["create:512", `fill:512:${NAVY}`, "paint:512:emoji", "png:512", "release:512"]);
    expect(out.ok && [...out.png]).toEqual([...(produced as Uint8Array)]);
  });

  it("작은 크기로도 굽는다(미리보기 알갱이): 그림판 크기와 PNG 크기가 같아야 하고, 다르면 막는다", async () => {
    const small = fakePorts({ png: buildPng({ width: 112, height: 112 }) });
    const out = await renderAvatarPng(small.ports, face(), 112);
    expect(out).toMatchObject({ ok: true, width: 112, height: 112 });
    expect(small.log).toEqual(["create:112", `fill:112:${NAVY}`, "paint:112:emoji", "png:112", "release:112"]);
    // 포트가 요청한 크기가 아닌 PNG 를 내놓으면 올리지 않는다.
    const wrong = fakePorts({ png: buildPng({ width: 512, height: 512 }) });
    expect(await renderAvatarPng(wrong.ports, face(), 112)).toEqual({ ok: false, reason: "bad-output" });
  });

  it("묻히는 조합도 그린다: 왜 안 되는지가 눈에 보이게 한다", async () => {
    const { ports } = fakePorts();
    expect((await renderAvatarPng(ports, face({ bg: BUTTER }))).ok).toBe(true);
  });
});

describe("composeAvatarPng: 올리는 길", () => {
  it("통과하면 포트가 구운 바이트를 한 바이트도 바꾸지 않고 내놓는다 (그려 올린 PNG가 정본)", async () => {
    const { ports, produced } = fakePorts();
    const out = await composeAvatarPng(ports, face());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.png]).toEqual([...(produced as Uint8Array)]);
    expect([out.width, out.height]).toEqual([512, 512]);
    expect(out.share).toBeGreaterThanOrEqual(0.5);
  });

  it("표본 → 판정 → 본 그림 순서다: 표본 층에는 배경이 없고 본 그림 층에만 배경이 깔린다", async () => {
    const { ports, log } = fakePorts();
    await composeAvatarPng(ports, face());
    expect(log).toEqual([
      "create:128",
      "paint:128:emoji",
      "read:128",
      "release:128",
      "create:512",
      `fill:512:${NAVY}`,
      "paint:512:emoji",
      "png:512",
      "release:512",
    ]);
  });

  it("묻히는 조합은 PNG 를 만들지 않는다: 저장 경로가 판정을 건너뛰지 않는다", async () => {
    const { ports, log } = fakePorts();
    const out = await composeAvatarPng(ports, face({ bg: BUTTER }));
    expect(out).toEqual({ ok: false, reason: "low-contrast" });
    expect(log.some((entry) => entry.startsWith("png:"))).toBe(false);
    expect(log.some((entry) => entry.startsWith("create:512"))).toBe(false);
  });

  it("같은 초안을 미리보기는 그리고 올리는 길은 막는다 (판정 유무가 두 길의 유일한 차이)", async () => {
    const draft = face({ bg: BUTTER });
    expect((await renderAvatarPng(fakePorts().ports, draft)).ok).toBe(true);
    expect((await composeAvatarPng(fakePorts().ports, draft)).ok).toBe(false);
  });

  it("글리프가 그려지지 않았으면 blank 로 막는다 (글꼴에 없는 이모지)", async () => {
    const { ports } = fakePorts({ glyph: new Uint8ClampedArray(128 * 128 * 4) });
    expect(await composeAvatarPng(ports, face())).toEqual({ ok: false, reason: "blank" });
  });

  it("코메토 프리셋도 같은 판정을 받는다: 진한 배경만 서고 연한 배경은 막힌다", async () => {
    // 정본 컷의 실측 비율(진한 배경에서 0.70~0.74, 연한 배경에서 0.26)을 표본으로 흉내 낸다.
    const art = rgbaBuffer(128 * 128, [
      { rgb: [181, 217, 251], count: 6000 }, // 후드 하늘색
      { rgb: [252, 247, 238], count: 1500 }, // 림 크림색
      { rgb: [24, 24, 28], count: 3200 }, // 얼굴 창
    ]);
    const preset = (bg: string): AvatarDraft => ({ kind: "preset", preset: "idle", bg });
    expect((await composeAvatarPng(fakePorts({ glyph: art }).ports, preset(NAVY))).ok).toBe(true);
    expect(await composeAvatarPng(fakePorts({ glyph: art }).ports, preset(BUTTER))).toEqual({
      ok: false,
      reason: "low-contrast",
    });
  });

  it("초안이 그릴 수 없는 꼴이면 포트를 건드리지 않고 invalid-draft 다", async () => {
    const { ports, log } = fakePorts();
    expect(await composeAvatarPng(ports, face({ emoji: "" }))).toEqual({ ok: false, reason: "invalid-draft" });
    expect(await composeAvatarPng(ports, face({ bg: "navy" }))).toEqual({ ok: false, reason: "invalid-draft" });
    expect(await composeAvatarPng(ports, { kind: "preset", preset: "joy" as never, bg: NAVY })).toEqual({
      ok: false,
      reason: "invalid-draft",
    });
    expect(log).toEqual([]);
  });

  it("포트가 PNG 가 아닌 것·엉뚱한 크기·상한을 넘는 것을 내놓으면 올리지 않는다", async () => {
    const svg = Uint8Array.from([...'<svg xmlns="http://www.w3.org/2000/svg"/>'].map((ch) => ch.charCodeAt(0)));
    const cases: [string, Uint8Array | null, AvatarComposeFailure][] = [
      ["PNG 가 아니다(SVG)", svg, "bad-output"],
      ["너비만 다르다 511×512", buildPng({ width: 511, height: 512 }), "bad-output"],
      ["높이만 다르다 512×511", buildPng({ width: 512, height: 511 }), "bad-output"],
      ["512×256", buildPng({ width: 512, height: 256 }), "bad-output"],
      ["1024×1024", buildPng({ width: 1024, height: 1024 }), "bad-output"],
      ["5MiB 초과", buildPng({ payload: new Uint8Array(MEMBER_AVATAR_MAX_BYTES + 1) }), "bad-output"],
      ["빈 바이트", new Uint8Array(0), "encode-failed"],
      ["굽지 못함", null, "encode-failed"],
    ];
    for (const [name, png, reason] of cases) {
      expect(await composeAvatarPng(fakePorts({ png }).ports, face()), name).toEqual({ ok: false, reason });
    }
  });

  it("그림판이 없거나 본 그림을 못 그려도 던지지 않고 층을 놓는다", async () => {
    expect(await composeAvatarPng(fakePorts({ noCanvas: true }).ports, face())).toEqual({ ok: false, reason: "no-canvas" });
    const failing = fakePorts({ paintOk: false });
    expect(await composeAvatarPng(failing.ports, face())).toEqual({ ok: false, reason: "paint-failed" });
    expect(failing.log.at(-1)).toBe("release:128"); // 표본 층도 놓는다
  });
});

describe("실패 문구", () => {
  const reasons: AvatarComposeFailure[] = [
    "invalid-draft",
    "no-canvas",
    "paint-failed",
    "blank",
    "low-contrast",
    "invalid-color",
    "encode-failed",
    "bad-output",
  ];

  it("모든 사유가 해요체 한 문장이고 대시·사과·과장이 없다", () => {
    for (const reason of reasons) {
      for (const kind of ["emoji", "preset"] as const) {
        const text = avatarComposeFailureMessage(reason, kind);
        expect(text, `${reason}/${kind}`).toMatch(/요\.$/);
        expect(text).not.toMatch(/[—–]/);
        expect(text).not.toMatch(/죄송|실패했습니다/);
      }
    }
  });

  it("묻힘은 무엇이 묻히는지 말하고(이모지/코메토) 다음 행동을 알려 준다", () => {
    expect(avatarComposeFailureMessage("low-contrast", "emoji")).toBe(AVATAR_EDITOR_COPY.emojiLowContrast);
    expect(avatarComposeFailureMessage("low-contrast", "preset")).toBe(AVATAR_EDITOR_COPY.presetLowContrast);
    expect(AVATAR_EDITOR_COPY.emojiLowContrast).toContain("다른 색을 골라");
    expect(AVATAR_EDITOR_COPY.emojiBlank).toContain("다른 이모지를 골라");
  });
});
