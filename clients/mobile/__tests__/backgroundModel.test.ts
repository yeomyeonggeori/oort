import fs from 'fs';
import path from 'path';

import {
  BACKGROUND_FALLBACK_COPY,
  NO_BACKGROUND,
  PRESET_IDS,
  PRESETS,
  SOLID_IDS,
  SOLIDS,
  backgroundLabel,
  effectiveBackground,
  parseBackground,
  serializeBackground,
  type BackgroundChoice,
} from '@momo/core/design/mobileBackground';

// =============================================================================
// ADR-0189 증보 2 — 배경 선택의 저장 모양과 접근성 폴백 (#3907).
// =============================================================================

const CHOICES: BackgroundChoice[] = [
  NO_BACKGROUND,
  {kind: 'solid', id: 'sage'},
  {kind: 'preset', id: 'bam'},
  {kind: 'photo', file: 'bg-1760600000000.jpg', width: 1600, height: 1200},
];

describe('저장 왕복', () => {
  it.each(CHOICES)('%j 가 그대로 돌아온다', choice => {
    expect(parseBackground(serializeBackground(choice))).toEqual(choice);
  });

  it('없거나 깨졌거나 모르는 값이면 없음이다 — 화면을 잠그지 않는다', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'not json',
      '[]',
      '{"v":2,"kind":"solid","id":"sage"}',
      '{"v":1,"kind":"solid","id":"neon"}',
      '{"v":1,"kind":"preset","id":"x"}',
      '{"v":1,"kind":"video"}',
    ]) {
      expect(parseBackground(raw as string | null | undefined)).toEqual(NO_BACKGROUND);
    }
  });

  it('사진은 샌드박스 파일 **이름**만 받는다 — 경로·상위 디렉터리·다른 확장자는 없음', () => {
    for (const file of [
      '../secret.jpg',
      '/etc/passwd',
      'file:///cache/x.jpg',
      'bg-1.png',
      'bg-.jpg',
      'photo.jpg',
      'bg-1/../x.jpg',
    ]) {
      const raw = JSON.stringify({v: 1, kind: 'photo', file, width: 10, height: 10});
      expect([file, parseBackground(raw)]).toEqual([file, NO_BACKGROUND]);
    }
    expect(
      parseBackground(JSON.stringify({v: 1, kind: 'photo', file: 'bg-5.jpg', width: 0, height: 10})),
    ).toEqual(NO_BACKGROUND);
  });
});

describe('접근성 설정이 배경을 끈다 (투명도 줄이기·대비 높이기)', () => {
  const solid: BackgroundChoice = {kind: 'solid', id: 'sky'};
  const photo = CHOICES[3];

  it('아무 설정도 없으면 고른 배경이 깔린다', () => {
    expect(effectiveBackground(solid, false, false)).toEqual({active: true, fallback: null});
    expect(effectiveBackground(photo, false, false)).toEqual({active: true, fallback: null});
  });

  it('투명도 줄이기가 켜지면 어느 배경이든 꺼진다', () => {
    for (const choice of CHOICES.slice(1)) {
      expect(effectiveBackground(choice, true, false)).toEqual({
        active: false,
        fallback: 'reduce-transparency',
      });
    }
  });

  it('대비 높이기가 켜지면 꺼진다', () => {
    expect(effectiveBackground(photo, false, true)).toEqual({
      active: false,
      fallback: 'increase-contrast',
    });
  });

  it('둘 다 켜지면 이유는 투명도 줄이기가 먼저다', () => {
    expect(effectiveBackground(photo, true, true).fallback).toBe('reduce-transparency');
  });

  it('고른 것이 없으면 폴백 문구도 없다', () => {
    expect(effectiveBackground(NO_BACKGROUND, true, true)).toEqual({active: false, fallback: null});
  });

  it('폴백 문구는 이유를 사실대로 말하는 한 줄이다', () => {
    for (const copy of [BACKGROUND_FALLBACK_COPY['reduce-transparency'], BACKGROUND_FALLBACK_COPY['increase-contrast']]) {
      expect(copy).not.toMatch(/\n/);
      expect(copy).toMatch(/시스템 설정/);
    }
  });
});

describe('기본 제공 그림은 이 저장소에서 만든 것이다', () => {
  it('단색·그라데이션 id 가 라벨과 값을 모두 든다', () => {
    expect(SOLID_IDS.length).toBeGreaterThanOrEqual(6);
    expect(PRESET_IDS.length).toBeGreaterThanOrEqual(5);
    for (const id of SOLID_IDS) expect(SOLIDS[id].hex).toMatch(/^#[0-9A-F]{6}$/);
    for (const id of PRESET_IDS) {
      expect(PRESETS[id].gradient).toMatch(/^(linear|radial)-gradient\(/);
      expect(PRESETS[id].fallback).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(backgroundLabel({kind: 'solid', id: 'sage'})).toBe(SOLIDS.sage.label);
    expect(backgroundLabel({kind: 'preset', id: 'bam'})).toBe(PRESETS.bam.label);
  });

  it('외부 이미지·바이너리 자산을 참조하지 않는다 (url(...)·http·require 이미지 없음)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/momo-core/src/design/wallpaper.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/url\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/require\(/);
  });
});

describe('내 사진은 서버로 올라가지 않는다', () => {
  const DIR = path.resolve(__dirname, '../src/design/background');
  it('배경 모듈 어디에도 네트워크·업로드 호출이 없다', () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(DIR)) {
      if (!/\.tsx?$/.test(name)) continue;
      const code = fs
        .readFileSync(path.join(DIR, name), 'utf8')
        // 주석은 약속을 설명하느라 이 낱말들을 쓴다 — 코드만 본다.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\bfetch\s*\(|XMLHttpRequest|createUploadTask|uploadAsync|WebSocket|@momo\/core\/lib\/api/.test(code)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
