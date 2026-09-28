#!/usr/bin/env node
// Regenerates docs/api/human-control-signing.vectors.json (#3021, ADR-0146 개정
// 2026-09-28 D-5). One command, run on a Mac from anywhere:
//
//   node server-rust/crates/momo-wire/tests/human_control_vectors/generate.mjs
//
// What it does, per case (inputs = each case's `schema`/`fields`/`content`):
//   1. builds content bytes + the signed payload in TypeScript-flavoured JS
//      (this file) and signs them with WebCrypto ECDSA P-256/SHA-256;
//   2. runs cryptokit.swift, which builds the same bytes independently in Swift
//      and signs with CryptoKit (a fixed software key, plus an ephemeral Secure
//      Enclave key — so this needs a Mac with a Secure Enclave);
//   3. refuses to write unless the Swift bytes equal the JS bytes exactly;
//   4. writes the derived fields + every signature back into the file.
// The Rust side (tests/human_control_vectors.rs) rebuilds the bytes a third
// time from the same inputs and verifies every signature.
//
// Keys: the WebCrypto and CryptoKit software keys are derived from fixed labels
// (SHA-256 of the label = the private scalar), so they are test-only keys that
// anyone can recompute — never real keys. ECDSA is randomized, so signatures
// differ on every run; that is expected.

import { createECDH, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const vectorsPath = resolve(repo, "docs/api/human-control-signing.vectors.json");
const subtle = globalThis.crypto.subtle;

const ABSENT = "-";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const utf8 = (s) => Buffer.from(s, "utf8");
const nfc = (s) => s.normalize("NFC");

// RFC 8785 restricted to integers — must equal momo_wire::human_control::canonical_json.
function canonicalJson(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`non-integer or unsafe number ${v}`);
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  // Default sort compares UTF-16 code units — the order the Rust side reproduces.
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

function contentBytes(c) {
  switch (c.kind) {
    case "input":
      return utf8(nfc(c.text));
    case "spawn":
      return utf8(`${c.agent_member_id}\n${c.folder_id}\n${nfc(c.first_prompt)}`);
    case "permission":
      return utf8(`${c.request_event_id}\n${c.option_id}\n${c.option_kind}\n${c.scope}`);
    case "bundle_manifest":
      return utf8(canonicalJson(c.manifest));
    case "host_register":
      return utf8(`${c.host_public_key_b64}\n${c.host_id}\n${nfc(c.label)}`);
    default:
      throw new Error(`unknown kind ${c.kind}`);
  }
}

function payloadBytes(tc) {
  const f = tc.fields;
  switch (tc.schema) {
    case "momo.human.control.v1": {
      const c = tc.content;
      const mode = c.kind === "input" ? c.mode : ABSENT;
      return utf8(
        [
          tc.schema,
          f.instance_id,
          f.workspace_id,
          f.member_id,
          f.device_key_id,
          f.host_id,
          f.session_id ?? ABSENT,
          c.kind,
          mode,
          f.nonce,
          String(f.issued_at_ms),
          String(f.expires_at_ms),
          sha256(contentBytes(c)).toString("hex"),
        ].join("\n"),
      );
    }
    case "momo.human.device_endorse.v1":
      return utf8(
        [
          tc.schema,
          f.workspace_id,
          f.member_id,
          f.root_key_id,
          f.target_alg,
          f.target_public_key_b64,
          nfc(f.label),
        ].join("\n"),
      );
    case "momo.human.device_revoke.v1":
      return utf8(
        [tc.schema, f.workspace_id, f.member_id, f.root_key_id, f.target_key_id, String(f.revoked_at_ms)].join(
          "\n",
        ),
      );
    default:
      throw new Error(`unknown schema ${tc.schema}`);
  }
}

// Fixed WebCrypto key: scalar = SHA-256(label). Imported as JWK so the signer
// is the real WebCrypto `subtle.sign`, not node's OpenSSL wrapper.
async function webcryptoKey(label) {
  const d = sha256(utf8(label));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(); // 65-byte uncompressed
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const jwk = { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
  const key = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pubJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const verifyKey = await subtle.importKey("jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const raw = Buffer.from(await subtle.exportKey("raw", verifyKey)); // 0x04 || x || y
  // WebCrypto exports uncompressed; the wire form is compressed SEC1.
  const compressed = Buffer.concat([Buffer.from([raw[64] & 1 ? 0x03 : 0x02]), raw.subarray(1, 33)]);
  return { key, publicKey: compressed.toString("base64") };
}

// Escape every non-ASCII UTF-16 unit so an editor or tool that NFC-normalizes
// files cannot silently rewrite the deliberately decomposed test text.
const asciiJson = (obj) =>
  JSON.stringify(obj, null, 2).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`) +
  "\n";

const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));
const wc = await webcryptoKey("momo.human.signing.vectors/webcrypto");

const swiftOut = JSON.parse(
  execFileSync("swift", [resolve(here, "cryptokit.swift"), vectorsPath], { encoding: "utf8", maxBuffer: 1 << 24 }),
);

for (const tc of doc.cases) {
  const payload = payloadBytes(tc);
  const swift = swiftOut.cases.find((s) => s.name === tc.name);
  if (!swift) throw new Error(`swift produced no case ${tc.name}`);
  if (Buffer.from(swift.payload_b64, "base64").compare(payload) !== 0) {
    throw new Error(`payload mismatch between Swift and JS for ${tc.name}`);
  }
  if (tc.content) {
    const cb = contentBytes(tc.content);
    tc.content_canonical = cb.toString("utf8");
    tc.content_sha256 = sha256(cb).toString("hex");
  }
  tc.payload = payload.toString("utf8");
  tc.payload_sha256 = sha256(payload).toString("hex");
  const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, wc.key, payload));
  tc.signatures = [
    { signer: "webcrypto", public_key: wc.publicKey, signature: sig.toString("base64") },
    ...swift.signatures.map((s) => ({ signer: s.signer, public_key: s.public_key, signature: s.signature })),
  ];
}

const out = {
  _comment:
    "#3021 — ADR-0146 개정 2026-09-28 D-5 공유 테스트 벡터. 사람 기기 키 서명 바이트 3종(momo.human.control.v1 · device_endorse.v1 · device_revoke.v1)의 입력(schema·fields·content)과 파생값(content_canonical·content_sha256·payload·payload_sha256), 그리고 WebCrypto(node)·CryptoKit(Swift 소프트웨어 키 + Secure Enclave 임시 키, 생성에는 SE가 있는 맥이 필요)가 실제로 만든 서명. Rust(momo-wire tests/human_control_vectors.rs)가 입력에서 바이트를 다시 만들어 같음을 확인하고 모든 서명을 검증한다. 재생성: node server-rust/crates/momo-wire/tests/human_control_vectors/generate.mjs (Swift와 JS 바이트가 다르면 쓰지 않는다). 비ASCII는 모두 \\u 이스케이프로 적어 편집기의 NFC 정규화가 분해형 시험 문자열을 망가뜨리지 못하게 한다. 키는 고정 라벨의 SHA-256에서 만든 시험 전용 키다.",
  format: "momo.human.signing.vectors/v1",
  algorithm: "ECDSA P-256 / SHA-256 over the payload bytes",
  public_key_encoding: "base64 STANDARD of the 33-byte compressed SEC1 point",
  signature_encoding: "base64 STANDARD of raw r||s (64 bytes); signers may emit high-s",
  high_s_rule:
    "normalize-then-verify: s > n/2 is replaced by n - s before verification and the low-s 64 bytes are the canonical stored form; one-time use comes from the nonce (ADR-0146 D-1, D-9), not from signature bytes",
  cases: doc.cases,
};
writeFileSync(vectorsPath, asciiJson(out));
console.log(`wrote ${doc.cases.length} cases, ${doc.cases[0].signatures.length} signatures each -> ${vectorsPath}`);
