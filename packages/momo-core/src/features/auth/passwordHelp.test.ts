import { describe, expect, it } from "vitest";
import { createMessageService, loadMessageCatalog } from "../../i18n";
import { passwordHelpRequestText, serverHost } from "./passwordHelp";

// ADR-0215 D5 (#4601): the request message carries the typed email and the server host, and nothing else.

describe("serverHost", () => {
  it("keeps the host and port, and drops scheme, path prefix, query and credentials", () => {
    expect(serverHost("https://team.example.com")).toBe("team.example.com");
    expect(serverHost("https://team.example.com:8443/momo")).toBe("team.example.com:8443");
    expect(serverHost("http://10.0.0.5:8080/")).toBe("10.0.0.5:8080");
    expect(serverHost("https://user:secret@team.example.com/x?y=1#z")).toBe("team.example.com");
  });

  it("falls back to the bare address when it is not a URL", () => {
    expect(serverHost("team.example.com/momo")).toBe("team.example.com");
    expect(serverHost("")).toBe("");
  });
});

describe("passwordHelpRequestText", () => {
  const en = createMessageService({ messageLocale: "en-US" });
  const text = (serverBase: string, email: string) =>
    passwordHelpRequestText({ serverBase, email }, en.formatMessage);

  it("names the server and the typed email", () => {
    expect(text("https://team.example.com", "ada@team.example.com")).toBe(
      "I forgot my oort password and need a reset link. Server: team.example.com, email: ada@team.example.com"
    );
  });

  it("names only the server while the email is still empty", () => {
    for (const blank of ["", "   ", "\n\t"]) {
      expect(text("https://team.example.com", blank)).toBe(
        "I forgot my oort password and need a reset link. Server: team.example.com"
      );
    }
  });

  it("puts the email on one line, trimmed and capped", () => {
    expect(text("https://team.example.com", "  ada@team.example.com \n second ")).toContain(
      "email: ada@team.example.com second"
    );
    const long = `${"a".repeat(400)}@team.example.com`;
    expect(text("https://team.example.com", long).length).toBeLessThan(400);
  });

  it("reads the Korean dictionary when the language is Korean", async () => {
    const ko = createMessageService({
      messageLocale: "ko-KR",
      catalog: await loadMessageCatalog("ko-KR"),
    });
    expect(
      passwordHelpRequestText(
        { serverBase: "https://team.example.com/momo", email: "ada@team.example.com" },
        ko.formatMessage
      )
    ).toBe("oort 비밀번호를 잊어서 재설정 링크가 필요해요. 서버: team.example.com, 이메일: ada@team.example.com");
  });
});
