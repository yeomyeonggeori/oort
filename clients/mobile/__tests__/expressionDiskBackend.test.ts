// #5455 B-2 — 폰 보관 칸의 **진짜 파일 백엔드**(`disk/fileBackend.ts`)를 `expo-file-system` 의 메모리 구현 위에서 돈다(`fixtures/memoryExpoFs.ts`).
// MA10(원자적 쓰기·읽을 때 길이)·MA11(상한·수명·화면이 쥔 파일)·MA13(저장 위치)·MA7(고아)의 파일 수준과, 저장소를 이 백엔드에 올린 통합 시험(MA1)을 잰다.
// 저장소 수준의 읽기 문·알림 규칙은 `expressionDisk.test.tsx` 가 가짜 포트로 잰다.
import 'react-native-url-polyfill/auto';
import {
  EXPRESSION_VARIANTS,
  expressionDiskKey,
  expressionIdOfDiskKey,
} from '@momo/core/features/expressions/diskCache';
import {Paths} from 'expo-file-system';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';
import {
  compartmentNamesSync,
  createFileDiskBackend,
  destroyCompartmentSync,
  diskFileName,
  diskKeyOfFileName,
  isCompartmentName,
  removeOrphansSync,
} from '../src/features/expressions/disk/fileBackend';
import {openPhoneExpressionDisk} from '../src/features/expressions/disk/open';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {
  diskName,
  makeFiles,
  ME,
  pic,
  uuid,
  World,
  WS,
} from './fixtures/expressionDiskWorld';
import type {MemoryFsState} from './fixtures/memoryExpoFs';

jest.mock('expo-file-system', () =>
  jest.requireActual('./fixtures/memoryExpoFs').createMemoryExpoFs(),
);

const fs = (jest.requireMock('expo-file-system') as {__fs: MemoryFsState}).__fs;
const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const DAY = 86_400_000;
const SHA = 'ab'.repeat(32);
const SHA2 = 'cd'.repeat(32);
const folderUri = (name = diskName()) => `${Paths.cache.uri}${name}/`;

beforeEach(() => {
  fs.reset();
  mmkvStore.clear();
});

const keyFor = (n: number, sha = SHA, size: (typeof EXPRESSION_VARIANTS)[number] = 'large') => expressionDiskKey(uuid(n), size, sha);
const image = (seed: string, length = 100, mime: 'image/png' | 'image/gif' = 'image/png') => {
  const made = pic(seed, length, mime);
  return {bytes: made.bytes.slice().buffer as ArrayBuffer, mime};
};
const open = (options?: Parameters<typeof createFileDiskBackend>[0]) => {
  const backend = createFileDiskBackend({now: () => fs.clock.now, ...options});
  return {backend, compartment: backend.open(diskName())!};
};

describe('파일 이름 ↔ 디스크 키', () => {
  it('`:` 를 `_` 로 바꾼 엄격한 모양이고 키로 되돌릴 수 있다 — id 의 뜻(`expressionIdOfDiskKey`)이 그대로다', () => {
    const key = keyFor(1);
    expect(diskFileName(key, 'image/png')).toBe(`${uuid(1)}_large_${SHA}.png`);
    expect(diskFileName(key, 'image/gif')).toBe(`${uuid(1)}_large_${SHA}.gif`);
    expect(diskKeyOfFileName(`${uuid(1)}_large_${SHA}.png`)).toBe(key);
    expect(expressionIdOfDiskKey(diskKeyOfFileName(`${uuid(1)}_thumb_${SHA}.gif`)!)).toBe(uuid(1));
  });

  it('코어의 세 크기 이름이 모두 파일 이름이 된다(크기가 늘면 이 시험이 붉어진다)', () => {
    for (const size of EXPRESSION_VARIANTS) {
      expect(diskFileName(keyFor(1, SHA, size), 'image/png')).not.toBeNull();
    }
  });

  it('경로를 벗어나는 id·모르는 크기·짧거나 대문자인 해시·`:` 가 더 낀 키는 이름이 되지 못한다', () => {
    const bad = [
      `../x:large:${SHA}`,
      `${uuid(1)}/../../x:large:${SHA}`,
      `${uuid(1)}:huge:${SHA}`,
      `${uuid(1)}:large:${SHA.slice(1)}`,
      `${uuid(1)}:large:${SHA.toUpperCase()}`,
      `${uuid(1)}:large:${SHA}:extra`,
      `${uuid(1)}:large`,
      '',
    ];
    for (const key of bad) expect(diskFileName(key, 'image/png')).toBeNull();
    for (const name of ['ledger.json', '.t123-abc', `${uuid(1)}_large_${SHA}.jpg`, `${uuid(1)}_large_${SHA}`, 'x.png']) {
      expect(diskKeyOfFileName(name)).toBeNull();
    }
  });

  it('칸 폴더 이름은 접두어 + uuid 둘일 때만 칸이다', () => {
    expect(isCompartmentName(diskName())).toBe(true);
    for (const name of ['oort-expr-img-v1.', 'oort-expr-img-v1.x.y', `oort-expr-img-v1.${WS}`, `oort-expr-img-v1.${WS}.${ME}/..`, 'oort-member-avatars', 'oort-expressions-1-a']) {
      expect(isCompartmentName(name)).toBe(false);
    }
  });
});

describe('쓰기·읽기 (MA10, MA13)', () => {
  it('쓰면 `Paths.cache/<칸 이름>/<id>_<size>_<sha>.png` 파일이 되고, `uriOf`·`locate`·`read`·`keys` 가 그 파일을 가리킨다 (MA13: 저장 위치)', async () => {
    const {compartment} = open();
    const entry = image('a', 120);
    await compartment.write(keyFor(1), entry);
    const expected = `${folderUri()}${uuid(1)}_large_${SHA}.png`;
    expect(fs.files.has(expected)).toBe(true);
    expect(compartment.uriOf(keyFor(1), 'image/png')).toBe(expected);
    expect(await compartment.locate(keyFor(1), 'image/png')).toEqual({uri: expected, bytes: 120});
    expect(await compartment.keys()).toEqual([keyFor(1)]);
    const read = await compartment.read(keyFor(1));
    expect(read?.mime).toBe('image/png');
    expect(new Uint8Array(read!.bytes)).toEqual(new Uint8Array(entry.bytes));
    // 모든 파일이 `Paths.cache` 아래 보관 칸 폴더 안에 있다(다른 디렉터리·백업되는 곳에는 없다).
    for (const uri of fs.files.keys()) expect(uri.startsWith(`${Paths.cache.uri}oort-expr-img-v1.`)).toBe(true);
    expect([...fs.files.keys()].filter(uri => uri.includes('document'))).toEqual([]);
  });

  it('GIF 는 `.gif` 로 쓰이고, 형식이 다르게 물으면 찾지 못한다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(2), image('g', 90, 'image/gif'));
    expect([...fs.files.keys()].some(uri => uri.endsWith('.gif'))).toBe(true);
    expect(await compartment.locate(keyFor(2), 'image/gif')).not.toBeNull();
    expect(await compartment.locate(keyFor(2), 'image/png')).toBeNull();
    expect((await compartment.read(keyFor(2)))?.mime).toBe('image/gif');
  });

  it('원자적 쓰기: 이름 바꾸기가 실패하면 항목 파일도 임시 파일도 남지 않고 쓰기는 던진다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('first'));
    fs.failMoveOnce = new Error('rename failed');
    await expect(compartment.write(keyFor(3), image('second'))).rejects.toThrow('rename failed');
    expect(await compartment.keys()).toEqual([keyFor(1)]);
    expect([...fs.files.keys()].filter(uri => uri.includes('/.t'))).toEqual([]);
  });

  it('원자적 쓰기: 짧게 쓰인 파일(디스크 가득 참)은 이름이 붙기 전에 버려진다', async () => {
    const {compartment} = open();
    fs.shortWriteOnce = 10;
    await expect(compartment.write(keyFor(1), image('x', 100))).rejects.toThrow();
    expect(await compartment.keys()).toEqual([]);
    expect([...fs.files.keys()].filter(uri => uri.includes('/.t'))).toEqual([]);
    fs.failWriteMatching = '/.t';
    await expect(compartment.write(keyFor(1), image('x', 100))).rejects.toThrow('no space');
    expect(await compartment.keys()).toEqual([]);
  });

  it('같은 키는 덮어쓴다. 모양이 틀린 키는 쓰기에서 던지고, 찾기·읽기에서는 null 이다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('v1', 100));
    await compartment.write(keyFor(1), image('v2', 140));
    expect((await compartment.locate(keyFor(1), 'image/png'))?.bytes).toBe(140);
    await expect(compartment.write('../evil:large:x', image('e'))).rejects.toThrow();
    expect(await compartment.locate('../evil:large:x', 'image/png')).toBeNull();
    expect(await compartment.read('../evil:large:x')).toBeNull();
    expect(() => compartment.uriOf('../evil:large:x', 'image/png')).toThrow();
  });

  it('읽을 때 길이는 부르는 쪽이 본다: 저장된 파일 길이를 그대로 돌려준다(오염된 길이도 숨기지 않는다)', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('v1', 100));
    const uri = compartment.uriOf(keyFor(1), 'image/png');
    fs.files.set(uri, {bytes: new Uint8Array(37), modified: fs.clock.now});
    expect((await compartment.locate(keyFor(1), 'image/png'))?.bytes).toBe(37);
  });

  it('색인(keys)은 항목 파일만 센다 — 임시 파일·장부·모르는 파일·하위 폴더는 키가 아니다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('v1'));
    fs.files.set(`${folderUri()}.t999-zz`, {bytes: new Uint8Array(3), modified: 0});
    fs.files.set(`${folderUri()}note.txt`, {bytes: new Uint8Array(3), modified: 0});
    fs.dirs.add(`${folderUri()}sub/`);
    expect(await compartment.keys()).toEqual([keyFor(1)]);
  });

  it('칸이 없으면 색인은 빈 목록이고 찾기·읽기는 null 이며, 읽기가 칸을 만들지 않는다', async () => {
    const {compartment} = open();
    expect(await compartment.keys()).toEqual([]);
    expect(await compartment.locate(keyFor(1), 'image/png')).toBeNull();
    expect(await compartment.read(keyFor(1))).toBeNull();
    await compartment.remove([keyFor(1)]);
    await compartment.removeIds([uuid(1)]);
    await compartment.trim();
    expect(fs.dirs.has(folderUri())).toBe(false); // 쓰기만 칸을 만든다
  });
});

describe('지우기', () => {
  it('remove 는 그 키만, removeIds 는 그 id 의 모든 크기·모든 sha 를 지운다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1, SHA, 'large'), image('a'));
    await compartment.write(keyFor(1, SHA2, 'small'), image('b'));
    await compartment.write(keyFor(2, SHA, 'large'), image('c'));
    await compartment.remove([keyFor(1, SHA, 'large')]);
    expect((await compartment.keys())!.sort()).toEqual([keyFor(1, SHA2, 'small'), keyFor(2, SHA, 'large')].sort());
    await compartment.removeIds([uuid(1)]);
    expect(await compartment.keys()).toEqual([keyFor(2, SHA, 'large')]);
  });

  it('destroy 는 칸 폴더를 장부까지 통째로 지우고, 지운 칸은 다음 쓰기가 다시 만든다', async () => {
    const {backend, compartment} = open();
    await compartment.write(keyFor(1), image('a'));
    expect(fs.dirs.has(folderUri())).toBe(true);
    await compartment.destroy();
    expect(fs.dirs.has(folderUri())).toBe(false);
    expect([...fs.files.keys()].filter(uri => uri.startsWith(folderUri()))).toEqual([]);
    expect(await backend.list()).toEqual([]);
    await compartment.write(keyFor(1), image('a'));
    expect(await backend.list()).toEqual([diskName()]);
  });

  it('읽은 시각을 모으던 장부 쓰기는 지워진 칸을 되살리지 않는다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('a'));
    fs.clock.now += 3 * 60_000; // 1분 단위 갱신이 걸리는 시각
    const locating = compartment.locate(keyFor(1), 'image/png'); // 장부 쓰기를 한 틱 뒤로 예약한다
    void compartment.destroy(); // 같은 틱에 칸이 지워진다
    await locating;
    await Promise.resolve();
    expect(fs.dirs.has(folderUri())).toBe(false);
  });
});

describe('청소: 수명·바이트 상한·화면이 쥔 파일 (MA11)', () => {
  it('수명은 「마지막으로 읽거나 쓴 뒤」 7일이다: 오래전에 썼어도 최근에 읽은 항목은 남고, 읽지 않은 항목은 지워진다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('read-me'));
    await compartment.write(keyFor(2), image('forgotten'));
    fs.clock.now += 6 * DAY;
    await compartment.locate(keyFor(1), 'image/png'); // 6일째에 읽었다
    await Promise.resolve();
    fs.clock.now += 2 * DAY; // 쓴 지 8일, 마지막으로 읽은 지 2일
    await compartment.trim();
    expect(await compartment.keys()).toEqual([keyFor(1)]);
  });

  it('바이트 상한을 넘으면 오래 읽지 않은 것부터 버린다(개수가 아니라 바이트): 방금 읽은 것은 남는다', async () => {
    const {compartment} = open({budgetBytes: 250});
    for (let n = 1; n <= 4; n += 1) {
      fs.clock.now += 60_000 * 5;
      await compartment.write(keyFor(n), image(`e${n}`, 100));
    }
    fs.clock.now += 60_000 * 5;
    await compartment.locate(keyFor(1), 'image/png'); // 1번이 가장 최근에 읽혔다
    await Promise.resolve();
    await compartment.trim();
    // 400 바이트 → 상한 250 이하가 될 때까지 가장 오래 읽지 않은 2번·3번을 버린다.
    expect((await compartment.keys())!.sort()).toEqual([keyFor(1), keyFor(4)].sort());
  });

  it('바이트로 센다: 큰 항목 하나가 작은 항목 여러 개의 자리를 차지한다', async () => {
    const {compartment} = open({budgetBytes: 300});
    fs.clock.now += 60_000;
    await compartment.write(keyFor(1), image('small-1', 50));
    fs.clock.now += 60_000;
    await compartment.write(keyFor(2), image('small-2', 50));
    fs.clock.now += 60_000;
    await compartment.write(keyFor(3), image('big', 250));
    await compartment.trim();
    // 합계 350 > 300: 가장 오래 읽지 않은 작은 것 하나(1번)만 버리면 300 이하다. 개수(3개)로 셌다면 아무것도 버리지 않는다.
    expect((await compartment.keys())!.sort()).toEqual([keyFor(2), keyFor(3)].sort());
  });

  it('화면이 쥔 파일(pinned)은 수명·상한이 지났어도 지우지 않는다', async () => {
    const {compartment} = open({budgetBytes: 250});
    for (let n = 1; n <= 4; n += 1) {
      fs.clock.now += 60_000 * 5;
      await compartment.write(keyFor(n), image(`e${n}`, 100));
    }
    fs.clock.now += 9 * DAY; // 모두 수명이 지났다
    await compartment.trim(new Set([keyFor(2)]));
    expect(await compartment.keys()).toEqual([keyFor(2)]);
  });

  it('쓰다 죽어 남은 임시 파일은 지우고 장부·모르는 파일은 건드리지 않는다. 장부에서 사라진 파일의 줄도 정리한다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('a'));
    fs.files.set(`${folderUri()}.t111-aa`, {bytes: new Uint8Array(5), modified: fs.clock.now});
    fs.files.set(`${folderUri()}note.txt`, {bytes: new Uint8Array(5), modified: fs.clock.now});
    await compartment.trim();
    expect(fs.files.has(`${folderUri()}.t111-aa`)).toBe(false);
    expect(fs.files.has(`${folderUri()}note.txt`)).toBe(true);
    expect(fs.files.has(`${folderUri()}ledger.json`)).toBe(true);
    await compartment.remove([keyFor(1)]);
    await compartment.trim();
    const ledger = JSON.parse(new TextDecoder().decode(fs.files.get(`${folderUri()}ledger.json`)!.bytes));
    expect(ledger).toEqual({});
  });

  it('장부를 잃어도(앱이 죽었다) 파일의 수정 시각을 쓴 시각으로 보고 수명을 센다', async () => {
    const first = open();
    await first.compartment.write(keyFor(1), image('a'));
    fs.files.delete(`${folderUri()}ledger.json`);
    fs.clock.now += 8 * DAY;
    const second = open(); // 다시 켠 앱: 장부 없이 시작한다
    await second.compartment.trim();
    expect(await second.compartment.keys()).toEqual([]);
  });

  it('깨진 장부는 비어 있는 것으로 읽는다(청소가 던지지 않는다)', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('a'));
    fs.files.set(`${folderUri()}ledger.json`, {bytes: new TextEncoder().encode('{not json'), modified: fs.clock.now});
    const reopened = open().compartment;
    await expect(reopened.trim()).resolves.toBeUndefined();
    expect(await reopened.keys()).toEqual([keyFor(1)]);
  });

  it('읽은 시각은 1분 단위로만 장부에 오른다', async () => {
    const {compartment} = open();
    await compartment.write(keyFor(1), image('a'));
    const ledgerAt = () => JSON.parse(new TextDecoder().decode(fs.files.get(`${folderUri()}ledger.json`)!.bytes))[`${uuid(1)}_large_${SHA}.png`] as [number, number];
    const [written, read] = ledgerAt();
    expect(read).toBe(written);
    fs.clock.now += 30_000;
    await compartment.locate(keyFor(1), 'image/png');
    await Promise.resolve();
    expect(ledgerAt()[1]).toBe(written); // 30초: 갱신하지 않는다
    fs.clock.now += 40_000;
    await compartment.locate(keyFor(1), 'image/png');
    await Promise.resolve();
    expect(ledgerAt()[1]).toBe(fs.clock.now); // 70초: 갱신한다
  });
});

describe('백엔드: 칸 목록·고아 (MA7의 파일 수준)', () => {
  it('list 는 모양이 맞는 칸 폴더만 돌려주고, 모양이 틀린 이름은 열지도 못한다', async () => {
    const {backend} = open();
    fs.dirs.add(`${Paths.cache.uri}oort-expr-img-v1.garbage/`);
    fs.dirs.add(`${Paths.cache.uri}oort-expressions-1-abc/`);
    fs.dirs.add(`${folderUri()}`);
    fs.dirs.add(`${Paths.cache.uri}oort-member-avatars/`);
    expect(await backend.list()).toEqual([diskName()]);
    expect(backend.open('oort-expr-img-v1.garbage')).toBeNull();
    expect(backend.open(`oort-expr-img-v1.${WS}.${ME}/..`)).toBeNull();
    expect(backend.open('oort-member-avatars')).toBeNull();
    expect(backend.open(diskName())).not.toBeNull();
  });

  it('removeOrphansSync 는 옛 판의 세션 폴더(oort-expressions-*)와 받기 임시 파일(oort-expression-transfer-*)만 지운다', () => {
    const cache = Paths.cache.uri;
    fs.dirs.add(`${cache}oort-expressions-1700000000-abc/`);
    fs.files.set(`${cache}oort-expressions-1700000000-abc/1.png`, {bytes: new Uint8Array(4), modified: 0});
    fs.files.set(`${cache}oort-expression-transfer-1700000000-xyz`, {bytes: new Uint8Array(4), modified: 0});
    fs.dirs.add(`${cache}oort-member-avatars/`);
    fs.files.set(`${cache}oort-member-avatars/a.img`, {bytes: new Uint8Array(4), modified: 0});
    fs.dirs.add(folderUri());
    fs.files.set(`${folderUri()}${uuid(1)}_large_${SHA}.png`, {bytes: new Uint8Array(4), modified: 0});
    expect(removeOrphansSync()).toBe(2);
    expect(fs.dirs.has(`${cache}oort-expressions-1700000000-abc/`)).toBe(false);
    expect(fs.files.has(`${cache}oort-expressions-1700000000-abc/1.png`)).toBe(false);
    expect(fs.files.has(`${cache}oort-expression-transfer-1700000000-xyz`)).toBe(false);
    expect(fs.files.has(`${cache}oort-member-avatars/a.img`)).toBe(true); // 다른 캐시는 건드리지 않는다
    expect(fs.files.has(`${folderUri()}${uuid(1)}_large_${SHA}.png`)).toBe(true); // 보관 칸도 고아가 아니다
  });

  it('compartmentNamesSync·destroyCompartmentSync: 모양이 틀린 이름은 지우지 않는다', () => {
    fs.dirs.add(folderUri());
    fs.dirs.add(`${Paths.cache.uri}oort-expr-img-v1.garbage/`);
    expect(compartmentNamesSync()).toEqual([diskName()]);
    destroyCompartmentSync('oort-expr-img-v1.garbage');
    expect(fs.dirs.has(`${Paths.cache.uri}oort-expr-img-v1.garbage/`)).toBe(true);
    destroyCompartmentSync(diskName());
    expect(fs.dirs.has(folderUri())).toBe(false);
  });
});

describe('저장소를 진짜 파일 백엔드에 올린 통합 (MA1·MA13)', () => {
  const stores: PhoneExpressionStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
  });
  const startOn = (world: World) => {
    const backend = createFileDiskBackend({now: () => fs.clock.now});
    const disk = openPhoneExpressionDisk(WS, ME, backend);
    const files = makeFiles();
    const store = createPhoneExpressionStore(
      WS,
      ME,
      world.transport(),
      files,
      undefined,
      {
        read: () => {
          const raw = nonSecretStore().getString(NON_SECRET_KEYS.expressionShelf);
          return raw === undefined ? null : JSON.parse(raw);
        },
        write: value => nonSecretStore().set(NON_SECRET_KEYS.expressionShelf, JSON.stringify(value)),
        clear: () => nonSecretStore().remove(NON_SECRET_KEYS.expressionShelf),
      },
      disk,
    );
    store.start();
    stores.push(store);
    return {store, files};
  };

  it('큰 이모티콘 12개: 처음은 요청 24, 다시 켜면 0 — 그림은 보관 칸의 파일 주소이고 MMKV 에는 그림 바이트가 없다', async () => {
    const world = new World();
    for (let n = 1; n <= 12; n += 1) world.add(n, n % 4 === 0 ? 'image/gif' : 'image/png');
    const all = Array.from({length: 12}, (_, index) => index + 1);
    const first = startOn(world);
    await first.store.refresh(true);
    const firstPass = await Promise.all(all.flatMap(n => (['thumb', 'large'] as const).map(size => first.store.image(world.item(n), size))));
    await first.store.settleDisk();
    expect(world.imageCalls).toHaveLength(24);
    expect(first.files.write).not.toHaveBeenCalled();
    for (const uri of firstPass) expect(uri).toMatch(new RegExp(`^${Paths.cache.uri}oort-expr-img-v1\\.`));

    world.resetCounts();
    const second = startOn(world);
    await second.store.refresh(true);
    const secondPass = await Promise.all(all.flatMap(n => (['thumb', 'large'] as const).map(size => second.store.image(world.item(n), size))));
    expect(world.imageCalls).toHaveLength(0);
    expect(secondPass).toEqual(firstPass);

    // MMKV(백업되는 저장소)에는 그림 바이트가 한 장도 없다. 남는 것은 보관함(shelf)의 목록 정보뿐이다.
    const values = [...mmkvStore.values()].join('\n');
    for (const n of all) {
      for (const size of EXPRESSION_VARIANTS) {
        expect(values.includes(Buffer.from(world.bytesOf(n, size)).toString('base64'))).toBe(false);
      }
    }
    // 그림 파일은 모두 `Paths.cache` 아래 보관 칸에만 있다.
    for (const uri of fs.files.keys()) expect(uri.startsWith(`${Paths.cache.uri}oort-expr-img-v1.`)).toBe(true);
  });

  it('로그아웃(모든 칸 삭제) 뒤 Paths.cache 에 칸이 0이다', async () => {
    const world = new World();
    world.add(1);
    const first = startOn(world);
    await first.store.refresh(true);
    await first.store.image(world.item(1), 'large');
    await first.store.settleDisk();
    expect(compartmentNamesSync()).toEqual([diskName()]);
    for (const name of compartmentNamesSync()) destroyCompartmentSync(name);
    expect(compartmentNamesSync()).toEqual([]);
    expect([...fs.files.keys()].filter(uri => uri.includes('oort-expr-img-v1.'))).toEqual([]);
  });
});
