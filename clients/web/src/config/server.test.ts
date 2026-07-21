import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "./server";

describe("server URL policy", () => {
  it("accepts and normalizes HTTPS origins", () => {
    expect(normalizeServerUrl("https://momo.example.com/")).toBe(
      "https://momo.example.com"
    );
  });

  it("allows HTTP localhost for development", () => {
    expect(normalizeServerUrl("http://localhost:8080")).toBe(
      "http://localhost:8080"
    );
  });

  it("allows the loopback IPv4 exception", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080"
    );
  });

  it("rejects insecure remote servers", () => {
    expect(() => normalizeServerUrl("http://momo.example.com")).toThrow(
      "HTTPS"
    );
  });

  it("rejects paths that could redirect API requests", () => {
    expect(() => normalizeServerUrl("https://momo.example.com/team")).toThrow(
      "경로"
    );
  });
});
