import {
  QUALITY_STEPS,
  SIDE_FACTORS,
  importPhoto,
  type PhotoPorts,
  type PickOutcome,
} from '../src/design/background/photo';
import {PHOTO_MAX_BYTES, PHOTO_MAX_LONG_SIDE} from '@momo/core/design/mobileBackground';

// =============================================================================
// ADR-0189 증보 2 — 내 사진: 긴 변 ≤ 1600px · JPEG · ~1MB (#3907).
//
// 실제 expo 모듈은 시험에서 돌지 않는다(`photoNative.ts` 는 런타임 미검증). 대신 포트를
// 바꿔 **상한 산수**와 실패 갈래를 잰다: 어떤 크기·품질에서 줄이기를 부르는가, 1MB 를
// 넘는 결과를 절대 보관하지 않는가, 임시 파일을 남기지 않는가.
// =============================================================================

interface Trace {
  shrinks: Array<{longSide: number; quality: number}>;
  kept: Array<{uri: string; name: string}>;
  discarded: string[];
}

function ports(options: {
  pick: PickOutcome;
  /** 호출마다 결과 바이트 수를 정한다. */
  size: (call: {longSide: number; quality: number}) => number | null;
}): {ports: PhotoPorts; trace: Trace} {
  const trace: Trace = {shrinks: [], kept: [], discarded: []};
  const sizes = new Map<string, number | null>();
  let n = 0;
  return {
    trace,
    ports: {
      pick: async () => options.pick,
      shrink: async (_uri, {longSide, quality, width, height}) => {
        trace.shrinks.push({longSide, quality});
        n += 1;
        const uri = `file:///cache/shrunk-${n}.jpg`;
        sizes.set(uri, options.size({longSide, quality}));
        const scale = Math.min(1, longSide / Math.max(width, height));
        return {uri, width: Math.round(width * scale), height: Math.round(height * scale)};
      },
      sizeOf: uri => sizes.get(uri) ?? null,
      keep: (uri, name) => trace.kept.push({uri, name}),
      discard: uri => trace.discarded.push(uri),
      now: () => 1_760_600_000_000,
    },
  };
}

const BIG: PickOutcome = {kind: 'picked', uri: 'file:///photos/IMG_1.heic', width: 4032, height: 3024};

describe('상한', () => {
  it('큰 사진은 긴 변 1600 으로 줄이고 첫 품질에서 1MB 아래면 거기서 멈춘다', async () => {
    const {ports: p, trace} = ports({pick: BIG, size: () => 700_000});
    const result = await importPhoto(p);
    expect(trace.shrinks).toEqual([{longSide: 1600, quality: QUALITY_STEPS[0]}]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.file).toBe('bg-1760600000000.jpg');
    expect(Math.max(result.choice.width, result.choice.height)).toBeLessThanOrEqual(PHOTO_MAX_LONG_SIDE);
    expect(trace.kept).toHaveLength(1);
    expect(trace.discarded).toEqual([]);
  });

  it('세로 사진도 긴 변이 기준이다', async () => {
    const {ports: p} = ports({
      pick: {kind: 'picked', uri: 'u', width: 3000, height: 4000},
      size: () => 500_000,
    });
    const result = await importPhoto(p);
    expect(result.ok && Math.max(result.choice.width, result.choice.height)).toBe(1600);
  });

  it('작은 사진은 키우지 않는다 — 긴 변이 그대로다', async () => {
    const {ports: p, trace} = ports({
      pick: {kind: 'picked', uri: 'u', width: 800, height: 600},
      size: () => 90_000,
    });
    const result = await importPhoto(p);
    expect(trace.shrinks[0].longSide).toBe(800);
    expect(result.ok && result.choice.width).toBe(800);
  });

  it('1MB 를 넘으면 품질을 먼저 낮추고, 넘은 임시 파일은 지운다', async () => {
    const {ports: p, trace} = ports({
      pick: BIG,
      size: ({quality}) => (quality > 0.6 ? 1_400_000 : 800_000),
    });
    const result = await importPhoto(p);
    expect(trace.shrinks.map(s => s.quality)).toEqual([0.85, 0.7, 0.55]);
    expect(new Set(trace.shrinks.map(s => s.longSide))).toEqual(new Set([1600]));
    expect(trace.discarded).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it('품질을 다 낮춰도 크면 해상도를 한 단 낮춘다', async () => {
    const {ports: p, trace} = ports({
      pick: BIG,
      size: ({longSide}) => (longSide === 1600 ? 2_000_000 : 900_000),
    });
    const result = await importPhoto(p);
    expect(trace.shrinks.filter(s => s.longSide === 1600)).toHaveLength(QUALITY_STEPS.length);
    expect(trace.shrinks[QUALITY_STEPS.length].longSide).toBe(Math.round(1600 * SIDE_FACTORS[1]));
    expect(result.ok).toBe(true);
  });

  it('끝까지 크면 too-large 이고 아무것도 보관하지 않는다', async () => {
    const {ports: p, trace} = ports({pick: BIG, size: () => 5_000_000});
    const result = await importPhoto(p);
    expect(result).toEqual({ok: false, reason: 'too-large'});
    expect(trace.kept).toEqual([]);
    expect(trace.discarded).toHaveLength(QUALITY_STEPS.length * SIDE_FACTORS.length);
  });

  it('보관되는 어떤 결과도 1MB 를 넘지 않는다', async () => {
    for (const bytes of [10_000, 999_999, PHOTO_MAX_BYTES]) {
      const {ports: p, trace} = ports({pick: BIG, size: () => bytes});
      const result = await importPhoto(p);
      expect(result.ok).toBe(true);
      expect(trace.kept).toHaveLength(1);
    }
    const {ports: over} = ports({pick: BIG, size: () => PHOTO_MAX_BYTES + 1});
    expect((await importPhoto(over)).ok).toBe(false);
  });
});

describe('실패 갈래', () => {
  it('취소는 조용한 실패다', async () => {
    const {ports: p, trace} = ports({pick: {kind: 'cancelled'}, size: () => 1});
    expect(await importPhoto(p)).toEqual({ok: false, reason: 'cancelled'});
    expect(trace.shrinks).toEqual([]);
  });

  it('권한 거부와 고르기 오류를 구분한다', async () => {
    expect(await importPhoto(ports({pick: {kind: 'denied'}, size: () => 1}).ports)).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(await importPhoto(ports({pick: {kind: 'error'}, size: () => 1}).ports)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('크기를 못 재면 읽지 못한 사진이다', async () => {
    const {ports: p} = ports({pick: BIG, size: () => null});
    expect(await importPhoto(p)).toEqual({ok: false, reason: 'unreadable'});
  });

  it('줄이기가 던지면 읽지 못한 사진이다 — 앱이 죽지 않는다', async () => {
    const {ports: base} = ports({pick: BIG, size: () => 1});
    const result = await importPhoto({
      ...base,
      shrink: async () => {
        throw new Error('decode failed');
      },
    });
    expect(result).toEqual({ok: false, reason: 'unreadable'});
  });

  it('치수가 이상한 사진은 줄이기 전에 거절한다', async () => {
    const {ports: p, trace} = ports({
      pick: {kind: 'picked', uri: 'u', width: 0, height: 0},
      size: () => 1,
    });
    expect(await importPhoto(p)).toEqual({ok: false, reason: 'unreadable'});
    expect(trace.shrinks).toEqual([]);
  });
});
