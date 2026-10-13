import { describe, expect, it } from "vitest";
import {
  CONNECT_PROMPT_CONNECTOR_HEAD,
  CONNECT_PROMPT_ROUTINE_HEAD,
  CONNECT_PROMPT_SECRET_MASK,
  buildConnectPrompt,
  buildSwapPrompt,
  connectPromptSection,
} from "./connectPrompt";
import { HOSTED_ROUTINE_TEMPLATE } from "./presets";

const PAIRING = "pair_SECRET_0123456789abcdef";
const ACTIVE = "act_SECRET_fedcba9876543210";
const input = {
  endpoint: "https://oort.example.test/v1/mcp/agent-port",
  pairingCredential: PAIRING,
  routineLabel: "Oort Inbox: acme / grokbot",
};

describe("연결 프롬프트 한 덩어리", () => {
  it("연결 값은 커넥터 구획에 정확히 한 번 나오고 routine 구획에는 없다 (ADR-0162 D4)", () => {
    const prompt = buildConnectPrompt(input);
    expect(prompt.split(PAIRING).length - 1).toBe(1);
    expect(connectPromptSection(prompt, CONNECT_PROMPT_CONNECTOR_HEAD)).toContain(PAIRING);
    const routine = connectPromptSection(prompt, CONNECT_PROMPT_ROUTINE_HEAD);
    expect(routine).not.toBe("");
    expect(routine).not.toContain(PAIRING);
    expect(routine).not.toMatch(/Bearer|Authorization/);
  });

  it("주소와 routine 이름·지시문이 한 덩어리에 모두 있다", () => {
    const prompt = buildConnectPrompt(input);
    expect(prompt).toContain(input.endpoint);
    expect(prompt).toContain(input.routineLabel);
    expect(prompt).toContain(HOSTED_ROUTINE_TEMPLATE);
  });

  it("비밀을 URL 질의로 싣지 않는다", () => {
    const prompt = buildConnectPrompt(input);
    expect(prompt).not.toMatch(/\?[^\s]*=/);
    expect(prompt).not.toContain(`${input.endpoint}?`);
  });

  it("미리보기는 비밀을 마스크로 대신하고 구조는 같다", () => {
    const preview = buildConnectPrompt(input, { reveal: false });
    expect(preview).not.toContain(PAIRING);
    expect(preview).toContain(CONNECT_PROMPT_SECRET_MASK);
    expect(preview.replace(CONNECT_PROMPT_SECRET_MASK, PAIRING)).toBe(buildConnectPrompt(input));
  });

  it("교체 덩어리는 새 자격증명만 담고 처음 연결 값을 되풀이하지 않는다", () => {
    const swap = buildSwapPrompt({
      endpoint: input.endpoint,
      activeCredential: ACTIVE,
      routineLabel: input.routineLabel,
    });
    expect(swap.split(ACTIVE).length - 1).toBe(1);
    expect(swap).not.toContain(PAIRING);
    expect(connectPromptSection(swap, CONNECT_PROMPT_ROUTINE_HEAD)).not.toContain(ACTIVE);
  });

  it("두 덩어리에 em-dash가 없다", () => {
    expect(buildConnectPrompt(input)).not.toMatch(/[—–]/);
    expect(buildSwapPrompt({ endpoint: input.endpoint, activeCredential: ACTIVE, routineLabel: "x" })).not.toMatch(/[—–]/);
  });
});
