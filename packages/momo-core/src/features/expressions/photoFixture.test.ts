import { describe, expect, it } from "vitest";
import { assertExpressionContract } from "./contracts";
import { PHOTO_FIXTURE_PROMPTS, createExpressionFixtureServer } from "./fixtureServer";
import { FIXTURE_WORKSPACE_ID } from "./fixtures";
import { PHOTO_FAILURE_STATUS, photoFixtureFromQuery, readPhotoDraftResult, readPhotoModel } from "./photo";

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const metadata = { name: "my_face", displayName: "내 얼굴", tags: ["사진"], subjectMemberId: null };
const photo = (branch: string, provider: string, extra: object = {}) => ({ method: "POST" as const, path: `${base}/expressions/photo-drafts`, body: { ...metadata, branch, acknowledgedProvider: provider, ...extra } });

describe("가짜 서버의 사진 길 (스위치를 켠 쪽에서만 있다)", () => {
  it("스위치가 없으면 이 길은 없다: 지금까지의 모든 가짜 서버 사용처가 그대로다", () => {
    const server = createExpressionFixtureServer();
    expect(server.request({ method: "GET", path: `${base}/expressions/photo-model` }).status).toBe(404);
    expect(server.request(photo("cutout", "openai")).status).toBe(404);
  });

  it("모델이 없으면 없다고 말하고, 있으면 회사를 말한다", () => {
    for (const [model, provider] of [["none", null], ["openai", "openai"], ["gemini", "gemini"]] as const) {
      const answer = createExpressionFixtureServer({ photoModel: model }).request({ method: "GET", path: `${base}/expressions/photo-model` });
      expect(answer.status).toBe(200);
      expect(readPhotoModel(answer.json)).toMatchObject({ available: provider !== null, provider });
    }
  });

  it("두 갈래는 서버의 고정 문장을 출처로 가진 초안을 주고, 그 초안은 등록까지 이어진다", () => {
    const server = createExpressionFixtureServer({ photoModel: "openai" });
    for (const [branch, cutout] of [["cutout", "erased"], ["caricature", null]] as const) {
      const answer = server.request(photo(branch, "openai", { name: `face_${branch}` }));
      expect(answer.status).toBe(201);
      const result = readPhotoDraftResult(answer.json, FIXTURE_WORKSPACE_ID);
      expect(result?.cutout).toBe(cutout);
      assertExpressionContract("Draft", result?.draft);
      expect(result?.draft.origin).toEqual({ kind: "generated", sourceUrl: null, prompt: PHOTO_FIXTURE_PROMPTS[branch], sourceAttachmentId: null });
      const choice = { draftId: result!.draft.draftId, revision: result!.draft.revision, sha256: result!.draft.media!.large.sha256 };
      expect(server.request({ method: "POST", path: `${base}/expressions`, body: choice }).status).toBe(201);
    }
  });

  it("배경을 지우지 못한 그림은 「배경을 지운」이라고 말하지 않는다: 문장은 갈래가 아니라 결과를 따른다 (#5133)", () => {
    const made = (photoCutout: "model" | "erased" | "unchanged", branch: "cutout" | "caricature" = "cutout") => {
      const answer = createExpressionFixtureServer({ photoModel: "openai", photoCutout }).request(photo(branch, "openai"));
      expect(answer.status).toBe(201);
      const result = readPhotoDraftResult(answer.json, FIXTURE_WORKSPACE_ID);
      return { cutout: result?.cutout, prompt: result?.draft.origin.prompt };
    };
    // 배경이 없어진 그림(모델이 투명하게 그렸거나 서버가 지웠다)은 지금까지의 그 문장이다.
    expect(made("erased")).toEqual({ cutout: "erased", prompt: PHOTO_FIXTURE_PROMPTS.cutout });
    expect(made("model")).toEqual({ cutout: "model", prompt: PHOTO_FIXTURE_PROMPTS.cutout });
    // 못 지운 그림은 따로 쓴 문장이고, 이슈가 잡은 거짓(「배경을 지운 그림」)을 말하지 않는다.
    const kept = made("unchanged");
    expect(kept).toEqual({ cutout: "unchanged", prompt: PHOTO_FIXTURE_PROMPTS.cutout_unchanged });
    expect(kept.prompt).not.toContain("배경을 지운");
    expect(kept.prompt).toContain("지우지 못한");
    // 캐리커처에는 배경 단계가 없다: 스위치가 무엇이든 자기 문장이다.
    expect(made("unchanged", "caricature")).toEqual({ cutout: null, prompt: PHOTO_FIXTURE_PROMPTS.caricature });
    // 스위치를 안 켜면 지금까지와 같다: 지웠다고 답한다.
    const plain = readPhotoDraftResult(createExpressionFixtureServer({ photoModel: "openai" }).request(photo("cutout", "openai")).json, FIXTURE_WORKSPACE_ID);
    expect(plain?.cutout).toBe("erased");
    expect(plain?.draft.origin.prompt).toBe(PHOTO_FIXTURE_PROMPTS.cutout);
  });

  it("모델이 없거나 동의한 회사가 다르거나 입력이 틀리면 닫힌 코드로 거절한다", () => {
    const code = (response: { json?: unknown }) => (response.json as { error: { code: string } }).error.code;
    expect(code(createExpressionFixtureServer({ photoModel: "none" }).request(photo("cutout", "openai")))).toBe("image_model_unavailable");
    expect(code(createExpressionFixtureServer({ photoModel: "gemini" }).request(photo("cutout", "openai")))).toBe("image_model_changed");
    const server = createExpressionFixtureServer({ photoModel: "openai" });
    for (const bad of [photo("watercolour", "openai"), photo("cutout", "anthropic"), photo("cutout", "openai", { name: "A" }), photo("cutout", "openai", { tags: "x" })]) {
      expect(server.request(bad).status).toBe(400);
    }
  });

  it("고른 실패는 그 코드와 상태로 답한다", () => {
    for (const [failure, status] of Object.entries(PHOTO_FAILURE_STATUS)) {
      const answer = createExpressionFixtureServer({ photoModel: "openai", photoFailure: failure as keyof typeof PHOTO_FAILURE_STATUS }).request(photo("cutout", "openai"));
      expect(answer.status).toBe(status);
      expect((answer.json as { error: { code: string } }).error.code).toBe(failure);
    }
  });
});

describe("개발용 스위치 읽기", () => {
  const read = (query: string) => photoFixtureFromQuery(new URLSearchParams(query));
  it("아는 값만 읽고 모르는 값은 없는 것으로 읽는다", () => {
    expect(read("photoModel=none")).toEqual({ model: "none", failure: undefined });
    expect(read("photoModel=gemini&photoFailure=image_model_refused")).toEqual({ model: "gemini", failure: "image_model_refused" });
    expect(read("photoModel=anthropic&photoFailure=toString")).toEqual({ model: undefined, failure: undefined });
    expect(read("")).toEqual({ model: undefined, failure: undefined });
  });
});
