import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  installationReceiveUrl,
  parseInstallations,
  parseRevealedCredential,
  parseRevokedInstallation,
  resolveReceiveUrl,
  revealDetailRows,
  revokeConfirmQuestion,
  rotateConfirmQuestion,
  UNRESOLVABLE_RECEIVE_URL_NOTICE,
  webhookCreatedLabel,
  WEBHOOK_DELIVERY_RECORD_NOTE,
  webhookFailureMessage,
  webhookIngressNotes,
  webhookLabelIssue,
  webhookRevokedLabel,
  WEBHOOK_LABEL_MAX,
  type WebhookInstallation,
} from "./model";

// A value shaped like a real credential, so a leak in any direction is visible
// in an assertion rather than inferred.
const SECRET = "whsec_9f2c4a71b0e84d6fa3c1d5e7b28f0a46";
const SLACK_URL_TOKEN = "/hooks/T0AB1CD2EF3GH4IJ5KL6MN7OP";

const BASE = "https://oort.momo.team";
const WORKSPACE = "019f9b10-0000-7000-8000-000000000001";

function installationWire(overrides: Record<string, unknown> = {}) {
  return {
    id: "019f9b10-0000-7000-8000-0000000009a1",
    channelId: "019f9b10-0000-7000-8000-000000000201",
    authorMemberId: "019f9b10-0000-7000-8000-000000000101",
    mode: "native",
    label: "배포 알림 (GitHub Actions)",
    status: "active",
    createdAtMs: 1_754_700_000_000,
    updatedAtMs: 1_754_700_000_000,
    ...overrides,
  };
}

function installation(
  overrides: Partial<WebhookInstallation> = {}
): WebhookInstallation {
  return parseInstallations({
    installations: [installationWire(overrides as Record<string, unknown>)],
  })[0];
}

describe("parseInstallations", () => {
  it("keeps a well-formed row", () => {
    const rows = parseInstallations({ installations: [installationWire()] });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("배포 알림 (GitHub Actions)");
    expect(rows[0].mode).toBe("native");
    expect(rows[0].status).toBe("active");
  });

  // RED PROOF 1 — the secret non-exposure assertion for the LIST.
  //
  // The server promises the list carries no secret and no URL token ("Secrets
  // and Slack URL tokens are never returned"). This asserts the client does not
  // DEPEND on that promise: a row is rebuilt from eight named fields, so a
  // server that regressed, a proxy that merged bodies, or a fixture written by
  // someone in a hurry still cannot put a credential on the list surface.
  //
  // A spread or a cast passes every other test in this file and fails this one.
  it("cannot carry a secret out of the list response", () => {
    const rows = parseInstallations({
      installations: [
        installationWire({
          secret: SECRET,
          url: SLACK_URL_TOKEN,
          signingKey: SECRET,
          rawResponse: { secret: SECRET },
        }),
      ],
    });

    expect(Object.keys(rows[0]).sort()).toEqual([
      "authorMemberId",
      "channelId",
      "createdAtMs",
      "id",
      "label",
      "mode",
      "status",
      "updatedAtMs",
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(SLACK_URL_TOKEN);
  });

  it("drops a row missing a required field instead of half-rendering it", () => {
    const rows = parseInstallations({
      installations: [
        installationWire(),
        installationWire({ id: undefined }),
        installationWire({ mode: "carrier_pigeon" }),
        installationWire({ createdAtMs: "yesterday" }),
        "not an object",
      ],
    });
    expect(rows).toHaveLength(1);
  });

  it("orders newest first and breaks ties by id", () => {
    const rows = parseInstallations({
      installations: [
        installationWire({ id: "aaa", createdAtMs: 1_000 }),
        installationWire({ id: "ccc", createdAtMs: 3_000 }),
        installationWire({ id: "bbb", createdAtMs: 3_000 }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["bbb", "ccc", "aaa"]);
  });

  it("answers empty for a body that is not a list", () => {
    expect(parseInstallations(null)).toEqual([]);
    expect(parseInstallations({ installations: "none" })).toEqual([]);
  });
});

describe("parseRevealedCredential", () => {
  const wire = {
    installation: installationWire(),
    keyId: "019f9b10-0000-7000-8000-0000000009b1",
    secret: SECRET,
    url: "/v1/webhooks/019f9b10-0000-7000-8000-000000000001/019f9b10-0000-7000-8000-0000000009a1",
    signatureVersion: "v1",
    algorithm: "HMAC-SHA256",
  };

  it("reads the one-time response", () => {
    const credential = parseRevealedCredential(wire);
    expect(credential.secret).toBe(SECRET);
    expect(credential.keyId).toBe("019f9b10-0000-7000-8000-0000000009b1");
    expect(credential.installation.mode).toBe("native");
  });

  it("refuses a response describing a different installation than was asked for", () => {
    expect(() =>
      parseRevealedCredential(wire, { channelId: "some-other-channel" })
    ).toThrow(WireShapeError);
    expect(() =>
      parseRevealedCredential(wire, { mode: "slack_compatible" })
    ).toThrow(WireShapeError);
    expect(() =>
      parseRevealedCredential(wire, { installationId: "some-other-id" })
    ).toThrow(WireShapeError);
  });

  it("refuses a body with no usable credential in it", () => {
    expect(() => parseRevealedCredential({ ...wire, keyId: undefined })).toThrow(
      WireShapeError
    );
    expect(() => parseRevealedCredential({ ...wire, url: undefined })).toThrow(
      WireShapeError
    );
    expect(() =>
      parseRevealedCredential({
        ...wire,
        installation: installationWire({ status: "revoked" }),
      })
    ).toThrow(WireShapeError);
  });

  it("leaves the secret absent in Slack-compatible mode", () => {
    const credential = parseRevealedCredential({
      installation: installationWire({ mode: "slack_compatible" }),
      keyId: "019f9b10-0000-7000-8000-0000000009b2",
      url: SLACK_URL_TOKEN,
    });
    expect(credential.secret).toBeUndefined();
    expect(credential.url).toBe(SLACK_URL_TOKEN);
  });
});

describe("parseRevokedInstallation", () => {
  const id = "019f9b10-0000-7000-8000-0000000009a1";

  it("accepts the revoked row", () => {
    const row = parseRevokedInstallation(
      { installation: installationWire({ status: "revoked" }), revoked: true },
      id
    );
    expect(row.status).toBe("revoked");
  });

  it("refuses a 200 that says it did not revoke", () => {
    expect(() =>
      parseRevokedInstallation(
        {
          installation: installationWire({ status: "revoked" }),
          revoked: false,
        },
        id
      )
    ).toThrow(WireShapeError);
  });

  it("refuses a row that is still active or is a different installation", () => {
    expect(() =>
      parseRevokedInstallation(
        { installation: installationWire(), revoked: true },
        id
      )
    ).toThrow(WireShapeError);
    expect(() =>
      parseRevokedInstallation(
        { installation: installationWire({ status: "revoked" }), revoked: true },
        "another-id"
      )
    ).toThrow(WireShapeError);
  });
});

describe("webhookFailureMessage", () => {
  // RED PROOF 2 — the secret non-exposure assertion for FAILURES.
  //
  // A settings panel that renders `error.message` paints whatever the server
  // put in the body. That is the one path by which a value the operator just
  // submitted (or a credential the server echoed while failing) reaches the
  // screen after the reveal panel is gone. Copy is keyed by status instead, so
  // the wire string has no route to a pixel.
  it("never echoes the wire message", () => {
    const leaky = new ApiError(500, `store failed for secret ${SECRET}`);
    for (const action of ["list", "create", "rotate", "revoke"] as const) {
      const message = webhookFailureMessage(action, leaky);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("store failed");
    }
  });

  it("says who can act on a 403 rather than blaming the reader", () => {
    const message = webhookFailureMessage("create", new ApiError(403, "forbidden"));
    expect(message).toContain("오너나 관리자");
    expect(message).not.toContain("forbidden");
  });

  it("distinguishes the 404 a create means from the one a revoke means", () => {
    expect(webhookFailureMessage("create", new ApiError(404, ""))).toContain(
      "채널"
    );
    expect(webhookFailureMessage("revoke", new ApiError(404, ""))).toContain(
      "목록을 다시 불러오세요"
    );
  });

  it("carries the network copy this package wrote, which holds no wire text", () => {
    const offline = new NetworkError("unreachable", 15_000);
    const message = webhookFailureMessage("list", offline);
    expect(message).toContain("웹훅 목록을 불러오지 못했습니다");
    expect(message).toContain(offline.message);
  });

  it("names the action in every branch", () => {
    expect(webhookFailureMessage("rotate", new WireShapeError())).toContain(
      "비밀값을 회전하지 못했습니다"
    );
    expect(webhookFailureMessage("revoke", new Error("boom"))).toContain(
      "웹훅을 폐기하지 못했습니다"
    );
    expect(webhookFailureMessage("revoke", new Error("boom"))).not.toContain(
      "boom"
    );
  });
});

describe("resolveReceiveUrl", () => {
  it("resolves a bare same-origin path", () => {
    expect(resolveReceiveUrl("/hooks/abc", BASE)).toBe(`${BASE}/hooks/abc`);
  });

  // RED PROOF 3 — the credential cannot be addressed at another origin.
  //
  // Slack-compatible mode puts the secret IN the URL, so "which host does this
  // copy button hand it to" is a security question, not a formatting one. A
  // protocol-relative value looks like a path and is not one: `new URL()`
  // resolves "//evil.example/hooks/tok" to that host, and the operator would
  // paste their own secret into someone else's ingress.
  it("refuses a value that is really another origin", () => {
    expect(resolveReceiveUrl(SLACK_URL_TOKEN, BASE)).toBe(
      `${BASE}${SLACK_URL_TOKEN}`
    );
    expect(resolveReceiveUrl("//evil.example.com/hooks/tok", BASE)).toBeNull();
    expect(resolveReceiveUrl("https://evil.example.com/hooks/tok", BASE)).toBeNull();
    expect(resolveReceiveUrl("hooks/tok", BASE)).toBeNull();
    expect(resolveReceiveUrl("/hooks/tok", "https://oort.momo.team:8443")).toBe(
      "https://oort.momo.team:8443/hooks/tok"
    );
    expect(resolveReceiveUrl("/hooks/tok", "")).toBeNull();
    expect(resolveReceiveUrl("/hooks/tok", "not a url")).toBeNull();
  });

  it("refuses userinfo, query and fragment", () => {
    expect(resolveReceiveUrl("/hooks/tok", "https://user:pw@oort.momo.team")).toBeNull();
    expect(resolveReceiveUrl("/hooks/tok?token=x", BASE)).toBeNull();
    expect(resolveReceiveUrl("/hooks/tok#x", BASE)).toBeNull();
  });
});

describe("installationReceiveUrl", () => {
  it("gives a native row its recoverable receive URL", () => {
    const row = installation();
    expect(installationReceiveUrl(row, WORKSPACE, BASE)).toBe(
      `${BASE}/v1/webhooks/${WORKSPACE}/${row.id}`
    );
  });

  it("has nothing to offer for a Slack-compatible row", () => {
    const row = installation({ mode: "slack_compatible" });
    expect(installationReceiveUrl(row, WORKSPACE, BASE)).toBeNull();
  });

  it("has nothing to offer for a revoked row", () => {
    const row = installation({ status: "revoked" });
    expect(installationReceiveUrl(row, WORKSPACE, BASE)).toBeNull();
  });
});

describe("revealDetailRows", () => {
  // RED PROOF 4 — the reveal panel's generic rows hold no credential.
  //
  // The signature metadata is the part of a reveal that is safe to read aloud,
  // screenshot into a bug report, or put behind a raw disclosure later. The
  // secret and the secret-bearing URL each get their own labelled block with
  // their own warning instead, so nothing can be added to this list by habit.
  it("carries neither the secret nor the URL", () => {
    const rows = revealDetailRows({
      installation: installation(),
      keyId: "019f9b10-0000-7000-8000-0000000009b1",
      secret: SECRET,
      url: SLACK_URL_TOKEN,
      signatureVersion: "v1",
      algorithm: "HMAC-SHA256",
      overlapSeconds: 86_400,
    });
    const flat = JSON.stringify(rows);
    expect(flat).not.toContain(SECRET);
    expect(flat).not.toContain(SLACK_URL_TOKEN);
    expect(rows.map((row) => row.key)).toEqual([
      "키 ID",
      "알고리즘",
      "서명 버전",
      "이전 비밀값",
    ]);
    expect(rows[3].value).toBe("24시간 뒤 만료");
  });

  it("omits the fields a create response does not carry", () => {
    const rows = revealDetailRows({
      installation: installation({ mode: "slack_compatible" }),
      keyId: "019f9b10-0000-7000-8000-0000000009b2",
      url: SLACK_URL_TOKEN,
    });
    expect(rows.map((row) => row.key)).toEqual(["키 ID"]);
  });
});

describe("webhookLabelIssue", () => {
  it("accepts a normal label", () => {
    expect(webhookLabelIssue("  배포 알림  ")).toBeNull();
  });

  it("rejects empty, over-long and control-character labels", () => {
    expect(webhookLabelIssue("   ")).toBe("empty");
    expect(webhookLabelIssue("가".repeat(WEBHOOK_LABEL_MAX + 1))).toBe("tooLong");
    expect(webhookLabelIssue("배포\u0000알림")).toBe("controlCharacter");
    expect(webhookLabelIssue("배포\u001b알림")).toBe("controlCharacter");
    expect(webhookLabelIssue("배포\u007f알림")).toBe("controlCharacter");
    expect(webhookLabelIssue("배포\n알림")).toBe("controlCharacter");
  });

  it("accepts exactly the documented maximum", () => {
    expect(webhookLabelIssue("가".repeat(WEBHOOK_LABEL_MAX))).toBeNull();
  });
});

describe("confirmation copy", () => {
  it("names the webhook and says the effect cannot be undone", () => {
    const question = revokeConfirmQuestion("배포 알림");
    expect(question).toContain("배포 알림");
    expect(question).toContain("되돌릴 수 없습니다");
  });

  // #1205 리뷰 M1: 이름 없는 질문은 두 행이 동시에 물을 때 서로 구별되지 않는다.
  it("names the webhook in the rotate question too", () => {
    const question = rotateConfirmQuestion("Sentry 이슈 알림");
    expect(question).toContain("Sentry 이슈 알림");
    expect(question).toContain("24시간 뒤 만료");
  });
});

describe("row date", () => {
  // #1205 리뷰 N3: 폐기된 줄이 답해야 하는 것은 언제 죽었는가다.
  it("dates a revoked row by when it was revoked", () => {
    expect(webhookCreatedLabel(1_754_700_000_000)).toContain("생성");
    expect(webhookRevokedLabel(1_754_700_000_000)).toContain("폐기");
  });
});

describe("honesty copy", () => {
  // #1205 리뷰 H4: 이 표면에 전송 기록이 없다는 사실은 접힌 자리에 두지 않는다.
  it("says plainly that no delivery record lives here, with a next step for a dead URL", () => {
    expect(WEBHOOK_DELIVERY_RECORD_NOTE).toContain("기록이 남지 않습니다");
    expect(UNRESOLVABLE_RECEIVE_URL_NOTICE).toContain("폐기하고 다시 만드세요");
  });
});

describe("webhookIngressNotes", () => {
  it("states the rejection codes a sender will have seen, per mode", () => {
    expect(webhookIngressNotes("native").join(" ")).toContain("401");
    expect(webhookIngressNotes("native").join(" ")).toContain("413");
    expect(webhookIngressNotes("slack_compatible").join(" ")).toContain("blocks");
    expect(webhookIngressNotes("slack_compatible").join(" ")).toContain("429");
  });
});
