import { describe, expect, it } from "vitest";
import { FIXTURE_WORKSPACE_ID, fixtureGeneratedDraft } from "./fixtures";
import {
  AI_SETTINGS_PATH,
  PHOTO_BRANCHES,
  PHOTO_REQUEST_TIMEOUT_MS,
  buildPhotoMetadata,
  errorCodeOf,
  expressionActivateRequest,
  isPhotoMetadata,
  photoDraftRequest,
  photoModelRequest,
  photoFailureOf,
  photoFailureRetryable,
  readPhotoDraftResult,
  readPhotoModel,
  type PhotoFailure,
} from "./photo";

const model = { available: true, provider: "openai", branches: ["cutout", "caricature"], canManage: false };

describe("photo-model 응답 검사", () => {
  it("모양이 맞는 답만 받는다", () => {
    expect(readPhotoModel(model)).toEqual(model);
    expect(readPhotoModel({ ...model, available: false, provider: null })).toMatchObject({ available: false, provider: null });
    for (const bad of [
      null, [], "x",
      { ...model, available: "yes" },
      { ...model, canManage: undefined },
      { ...model, provider: "anthropic" },
      { ...model, branches: [] },
      { ...model, branches: ["cutout", "watercolour"] },
    ]) expect(readPhotoModel(bad)).toBeNull();
  });

  it("모델이 있는데 회사가 없거나, 모델이 없는데 회사가 있는 답은 믿지 않는다", () => {
    expect(readPhotoModel({ ...model, provider: null })).toBeNull();
    expect(readPhotoModel({ ...model, available: false })).toBeNull();
  });
});

describe("photo-drafts 응답 검사", () => {
  const draft = fixtureGeneratedDraft(0);
  it("초안 계약과 이 워크스페이스를 모두 맞는 답만 받는다", () => {
    for (const cutout of ["model", "erased", "unchanged", null] as const) {
      expect(readPhotoDraftResult({ draft, cutout }, FIXTURE_WORKSPACE_ID)?.cutout).toBe(cutout);
    }
    expect(readPhotoDraftResult({ draft, cutout: "kept" }, FIXTURE_WORKSPACE_ID)).toBeNull();
    expect(readPhotoDraftResult({ draft, cutout: "model" }, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(readPhotoDraftResult({ draft: { ...draft, state: "nope" }, cutout: null }, FIXTURE_WORKSPACE_ID)).toBeNull();
    expect(readPhotoDraftResult(draft, FIXTURE_WORKSPACE_ID)).toBeNull();
  });
});

describe("요청 본문", () => {
  it("동의한 회사와 갈래를 싣고 자유 글 칸은 없다", () => {
    const body = buildPhotoMetadata({
      branch: "cutout",
      provider: "gemini",
      metadata: { name: "my_face", displayName: "내 얼굴", tags: ["사진"], subjectMemberId: null },
    });
    expect(body).toEqual({
      branch: "cutout",
      acknowledgedProvider: "gemini",
      name: "my_face",
      displayName: "내 얼굴",
      tags: ["사진"],
      subjectMemberId: null,
    });
    expect(Object.keys(body).sort()).toEqual(["acknowledgedProvider", "branch", "displayName", "name", "subjectMemberId", "tags"]);
    expect([...PHOTO_BRANCHES]).toEqual(["cutout", "caricature"]);
  });
});

describe("실패 코드 → 화면이 말할 상황", () => {
  const table: [number | undefined, string | undefined, PhotoFailure][] = [
    [409, "image_model_unavailable", "unavailable"],
    [409, "image_model_changed", "changed"],
    [422, "image_model_refused", "refused"],
    [502, "image_model_failed", "failed"],
    [504, "image_model_timeout", "timeout"],
    [503, undefined, "busy"],
    [409, "expression_quota", "quota"],
    [403, "expression_role_required", "role"],
    [409, "expression_name_reserved", "name"],
    [400, "expression_invalid", "name"],
    [415, "expression_media_invalid", "media"],
    [413, "expression_media_invalid", "too_large"],
    [404, "not_found", "generic"],
    [500, undefined, "generic"],
    [undefined, undefined, "offline"],
  ];
  it.each(table)("%s %s → %s", (status, code, want) => {
    expect(photoFailureOf(status, code)).toBe(want);
  });

  it("같은 요청을 되풀이해도 되는 실패와 사람이 고쳐야 하는 실패를 가른다", () => {
    for (const retry of ["failed", "timeout", "busy", "offline", "generic"] as const) expect(photoFailureRetryable(retry)).toBe(true);
    for (const fix of ["unavailable", "changed", "refused", "quota", "role", "name", "media", "too_large"] as const) expect(photoFailureRetryable(fix)).toBe(false);
  });
});

describe("요청 생성기와 오류 코드 읽기", () => {
  const base = "/v1/workspaces/w1";
  it("세 요청의 길·방법·시간이 고정돼 있다", () => {
    expect(photoModelRequest(base)).toEqual({ method: "GET", path: `${base}/expressions/photo-model` });
    const file = { name: "photo.png" };
    const body = buildPhotoMetadata({ branch: "caricature", provider: "openai", metadata: { name: "ab", displayName: "x", tags: [], subjectMemberId: null } });
    expect(photoDraftRequest(base, body, file)).toEqual({ method: "POST", path: `${base}/expressions/photo-drafts`, body, file, timeoutMs: PHOTO_REQUEST_TIMEOUT_MS });
    expect(PHOTO_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(expressionActivateRequest(base, { draftId: "d" })).toEqual({ method: "POST", path: `${base}/expressions`, body: { draftId: "d" } });
    expect(AI_SETTINGS_PATH).toBe("/settings?section=ai");
  });

  it("이름·표시 이름·태그·당사자가 계약 모양인지 잰다", () => {
    expect(isPhotoMetadata({ name: "my_face", displayName: "내 얼굴", tags: ["사진"], subjectMemberId: null })).toBe(true);
    for (const bad of [
      { name: "A", displayName: "x", tags: [], subjectMemberId: null },
      { name: "my_face", displayName: "", tags: [], subjectMemberId: null },
      { name: "my_face", displayName: "x", tags: new Array(9).fill("t").map((tag, i) => `${tag}${i}`), subjectMemberId: null },
      { name: "my_face", displayName: "x", tags: [] },
    ]) expect(isPhotoMetadata(bad)).toBe(false);
  });

  it("오류 본문에서는 닫힌 code 모양만 꺼내고 다른 글은 돌려주지 않는다", () => {
    expect(errorCodeOf('{"error":{"code":"image_model_unavailable","message":"x"}}')).toBe("image_model_unavailable");
    for (const body of [
      "", "not json", "null", "[]", "{}", '{"error":null}', '{"error":{}}',
      '{"error":{"code":42}}',
      '{"error":{"code":"Has Spaces <b>"}}',
      `{"error":{"code":"${"a".repeat(65)}"}}`,
      '{"error":{"message":"bad key sk-live-0001","code":"BAD-CASE"}}',
    ]) expect(errorCodeOf(body)).toBeUndefined();
  });
});
