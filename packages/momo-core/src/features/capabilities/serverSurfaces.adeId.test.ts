import { describe, expect, it } from "vitest";
import {
  ADE_SURFACE_ID,
  HOST_GATED_SURFACE_IDS,
  serverSurface,
} from "./serverSurfaces";

// #5193: 웹은 관제 표면을 이 상수로 묻는다(낱말을 글자로 적으면 웹의 직접 문구 장부가 늘어난다). 상수가 표의 그 표면을 가리키는지,
// 그리고 「호스트가 있을 때만 서는 표면」이라는 가정(웹이 세션 읽기를 그 판정으로 거는 이유)이 표에 그대로 있는지 못 박는다.
describe("ADE_SURFACE_ID (#5193)", () => {
  it("표의 관제 표면 id와 같은 글자다", () => {
    expect(ADE_SURFACE_ID).toBe("ade");
    expect(serverSurface(ADE_SURFACE_ID).id).toBe(ADE_SURFACE_ID);
  });

  it("호스트가 있을 때만 서는 표면이다: 웹의 세션 읽기 판정이 기대는 전제", () => {
    expect(HOST_GATED_SURFACE_IDS).toContain(ADE_SURFACE_ID);
  });
});
