import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { displayFailureCopy } from "./displayStream";
import {
  autoReturnFor,
  classifyControlGrantFailure,
  controlAffordance,
  controlFailureCopy,
  controlObservationRestoredNote,
  controlOffersRetry,
  controlSwallowsKey,
  dispositionForKey,
  forwardKey,
  forwardPointer,
  forwardWheel,
  framesGateControl,
  keyInputFrame,
  normalisedPoint,
  pointerInputFrame,
  wheelInputFrame,
  CONTROL_CAPTURE_LIMIT_COPY,
  CONTROL_INPUT_CHANNEL_LABEL,
  CONTROL_INVITE_COPY,
  CONTROL_KEYBOARD_LOST_COPY,
  CONTROL_KEYBOARD_LOST_LABEL,
  CONTROL_LEASE_MS,
  CONTROL_NEGOTIATE_TIMEOUT_MS,
  CONTROL_OVERLAY_MOCKUP,
  CONTROL_PHASE_COPY,
  CONTROL_RETURN_COPY,
  CONTROL_RETURN_FAILED_COPY,
  CONTROL_START_LABEL,
  DISPLAY_CONTROLLER_MODE,
  type ControlInputSink,
  type ControlKeyEvent,
  type ControlLifecycleEvent,
  type ControlReturnReason,
} from "./controlStream";
import { loginHandoffSeeksControl } from "@momo/core/features/timeline/loginHandoffCard";

// =============================================================================
// LIVE-5b / ADR-0004 증보 3. Three kinds of test, proving three different things:
//
//   * the CONTRACT tests read `template.spec.json`'s `signalling.inputChannel`
//     and assert this client encodes exactly what it declares. That block is
//     DECLARED ONLY — no producer has ever parsed one of these frames
//     (`unverified.inputChannelProtocol`) — so what this proves is that the two
//     halves of the contract cannot drift while nobody is looking, never that
//     the wire works.
//   * the auto-return tests hold the mapping from "what this client observed"
//     to "why the window closed". It is total by construction, which is the
//     property that makes "a control window never outlives its holder" testable
//     without a browser.
//   * the NON-OBSERVABILITY red proof is the one this file exists for. It plants
//     a keystroke marker in each of the four places a leak could land — a
//     console call, a value the surface stores, a DOM attribute, an error
//     message — and fails on each. That is what proves the assertion is looking
//     at those four places rather than passing because it looks nowhere.
//
// The browser half (a real React tree, a stubbed producer, four states captured
// light and dark, and the same leak scan run against the live fiber tree) is
// `clients/web/gates/gate-display-control.mjs`.
// =============================================================================

const CONTROL_STREAM_SOURCE = readFileSync(
  fileURLToPath(new URL("./controlStream.ts", import.meta.url)),
  "utf8"
);
const CONTROLLER_COMPONENT_SOURCE = readFileSync(
  fileURLToPath(new URL("./DisplayController.tsx", import.meta.url)),
  "utf8"
);
const TEMPLATE_SPEC = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../infra/cubesandbox/display-template/template.spec.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as {
  signalling: {
    inputChannel: {
      label: string;
      openedBy: string;
      viewerOpensChannel: boolean;
      viewerToProducer: string[];
      keyFrame: string[];
      pointerFrame: {
        always: string[];
        move: string[];
        down: string[];
        up: string[];
      };
      wheelFrame: string[];
      carriesCharacter: boolean;
    };
  };
  producer: { inputDatachannelOnDemand: { trigger: string; revokeOn: string } };
  unverified: Record<string, string>;
};

/** Comments quote counter-examples verbatim in this repository; strip them. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

const CONTROL_STREAM_CODE = codeOnly(CONTROL_STREAM_SOURCE);
const CONTROLLER_COMPONENT_CODE = codeOnly(CONTROLLER_COMPONENT_SOURCE);

const OWNER = "019F9AB9-6D8F-7C55-9C3E-6A2B3F5D1A20";

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B77",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "019FA1C4-3B29-7C42-8E10-77B3D5A9E204",
    memberId: OWNER,
    hostId: "019FA1C4-3B31-7E88-B0D2-2F41C6A73E55",
    rootMessageId: "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B78",
    tool: "claude",
    label: "pgbackrest WAL 복구 리허설",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: true,
    startedAtMs: 1_785_180_004_120,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// the client never opens the way in
// -----------------------------------------------------------------------------

describe("the producer opens the input channel, and this client does not", () => {
  // The ordering LIVE-5b's whole surface rests on. A client that could open its
  // own datachannel would make the server's grant decorative: `input_enabled`
  // would still be answered and would no longer decide anything.
  it("never calls createDataChannel, in either file", () => {
    for (const source of [CONTROL_STREAM_CODE, CONTROLLER_COMPONENT_CODE]) {
      expect(source).not.toMatch(/createDataChannel/);
    }
  });

  it("never encodes the viewer word that asks for input", () => {
    // `open_input` exists in the template so a producer can refuse it BY NAME.
    // Sending it would be asking, and the template says in its own field that
    // asking is not authorisation.
    for (const source of [CONTROL_STREAM_CODE, CONTROLLER_COMPONENT_CODE]) {
      expect(source).not.toMatch(/open_input/);
    }
    expect(
      TEMPLATE_SPEC.producer.inputDatachannelOnDemand.trigger
    ).toBe("validate.input_enabled == true");
    expect(TEMPLATE_SPEC.signalling.inputChannel.openedBy).toBe("producer");
    expect(TEMPLATE_SPEC.signalling.inputChannel.viewerOpensChannel).toBe(false);
  });

  it("listens for the channel the template names, and refuses any other", () => {
    expect(CONTROL_INPUT_CHANNEL_LABEL).toBe(
      TEMPLATE_SPEC.signalling.inputChannel.label
    );
    expect(CONTROLLER_COMPONENT_CODE).toMatch(/ondatachannel/);
    // A channel with a label this client has no contract for is closed rather
    // than used: the alternative is sending a vocabulary nobody agreed to down
    // a pipe into somebody's VM.
    expect(CONTROLLER_COMPONENT_CODE).toMatch(
      /channel\.label !== CONTROL_INPUT_CHANNEL_LABEL/
    );
  });

  it("sends no media of its own and keeps no frame", () => {
    // ADR-0165 D5 does not relax for a controller. Taking a keyboard is not
    // permission to record a screen.
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(
      /addTrack|addTransceiver|getUserMedia|getDisplayMedia/
    );
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(
      /MediaRecorder|captureStream|drawImage|toDataURL|toBlob|<canvas/
    );
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(/\bcontrols\b(?!List)/);
  });

  it("never says 인수 (ADR-0004 증보 3 D1) and writes no em-dash into copy", () => {
    for (const text of [
      CONTROL_INVITE_COPY,
      CONTROL_CAPTURE_LIMIT_COPY,
      CONTROL_RETURN_FAILED_COPY,
      CONTROL_START_LABEL,
      ...Object.values(CONTROL_RETURN_COPY),
      ...Object.values(CONTROL_PHASE_COPY),
    ]) {
      expect(text).not.toContain("인수");
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

// -----------------------------------------------------------------------------
// what goes on the wire is what the template declares
// -----------------------------------------------------------------------------

describe("the input frames, against the contract that declares them", () => {
  it("encodes exactly the three words the template gives the viewer", () => {
    const declared = TEMPLATE_SPEC.signalling.inputChannel.viewerToProducer;
    expect(declared).toEqual(["key", "pointer", "wheel"]);
    const sent = [
      JSON.parse(
        keyInputFrame(
          {
            code: "KeyA",
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            metaKey: false,
            repeat: false,
          },
          "down"
        )
      ).type,
      JSON.parse(pointerInputFrame({ x: 0.5, y: 0.5 }, "move")).type,
      JSON.parse(wheelInputFrame(0, 120)).type,
    ];
    expect(sent).toEqual(declared);
  });

  it("puts the physical key on the wire and never the character", () => {
    // A remote keyboard is physical keys plus the FAR side's layout. It is also
    // the reason the character of a password never forms as a value this client
    // owns: there is no `key` field to leak, because there is no `key` field.
    const frame = JSON.parse(
      keyInputFrame(
        {
          code: "KeyA",
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          metaKey: false,
          repeat: true,
        },
        "down"
      )
    );
    expect(Object.keys(frame).sort()).toEqual(
      [...TEMPLATE_SPEC.signalling.inputChannel.keyFrame].sort()
    );
    expect(frame).toEqual({
      type: "key",
      action: "down",
      code: "KeyA",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      repeat: true,
    });
    expect(TEMPLATE_SPEC.signalling.inputChannel.carriesCharacter).toBe(false);
    expect(CONTROL_STREAM_CODE).not.toMatch(/event\.key\b/);
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(/event\.key\b/);
  });

  it("normalises a pointer over the picture rather than the reader's pixels", () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    expect(normalisedPoint(300, 150, box)).toEqual({ x: 0.5, y: 0.5 });
    // A drag that leaves the box is clamped: a coordinate off the screen is not
    // a place the VM can click.
    expect(normalisedPoint(0, 0, box)).toEqual({ x: 0, y: 0 });
    expect(normalisedPoint(9_999, 9_999, box)).toEqual({ x: 1, y: 1 });
    // A box with no area is a video that has not been laid out yet.
    expect(normalisedPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  it("declares the pointer frame PER ACTION, and sends what it declares", () => {
    // grok freeze M-1. The spec used to be one flat field list including
    // `button`, which reads as "always present" — and a producer built from
    // that reading drops every MOVE, so clicks work and the cursor never
    // travels. That failure is invisible on paper and obvious on a screen, so
    // the two shapes are declared and measured apart.
    const declared = TEMPLATE_SPEC.signalling.inputChannel.pointerFrame;
    expect(declared.move).toEqual([]);
    expect(declared.down).toEqual(["button"]);
    expect(declared.up).toEqual(["button"]);

    const shapeOf = (frame: string) => Object.keys(JSON.parse(frame)).sort();
    expect(shapeOf(pointerInputFrame({ x: 0.1, y: 0.1 }, "move"))).toEqual(
      [...declared.always, ...declared.move].sort()
    );
    expect(
      shapeOf(pointerInputFrame({ x: 0.25, y: 0.75, button: 2 }, "down"))
    ).toEqual([...declared.always, ...declared.down].sort());
    expect(
      shapeOf(pointerInputFrame({ x: 0.25, y: 0.75, button: 0 }, "up"))
    ).toEqual([...declared.always, ...declared.up].sort());

    // Button 0 is a real button, not a missing one: a left-button drag and a
    // move must not encode identically.
    expect(
      JSON.parse(pointerInputFrame({ x: 0.5, y: 0.5, button: 0 }, "down")).button
    ).toBe(0);
    expect(
      JSON.parse(pointerInputFrame({ x: 0.5, y: 0.5 }, "move"))
    ).not.toHaveProperty("button");
  });

  it("keeps the wheel frame the shape the template declares", () => {
    const frame = JSON.parse(wheelInputFrame(-12, 120));
    expect(Object.keys(frame).sort()).toEqual(
      [...TEMPLATE_SPEC.signalling.inputChannel.wheelFrame].sort()
    );
    expect(frame).toEqual({ type: "wheel", action: "scroll", dx: -12, dy: 120 });
  });

  it("is labelled as declared-only, because no producer has ever read one", () => {
    // The honesty label is part of the contract, not a footnote to it. Deleting
    // it would turn this client's guess into "the protocol" by default, which
    // is exactly what LIVE-5c has to be free to correct.
    expect(TEMPLATE_SPEC.unverified.inputChannelProtocol).toContain("DECLARED ONLY");
    expect(TEMPLATE_SPEC.unverified.inputDelivery).toBeTruthy();
  });

  it("has a release key, and it is not swallowed and not forwarded", () => {
    // design-review B-1. Taking control puts the keyboard in a box that
    // captures Tab; without a release path a keyboard user could take a
    // keyboard and be unable to give it back, and 화면 돌려주기 would be
    // reachable only with a mouse.
    const esc = (over: Partial<ControlKeyEvent> = {}): ControlKeyEvent => ({
      code: "Escape",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      ...over,
    });
    expect(dispositionForKey(esc())).toEqual({ kind: "release" });

    // Shift+Escape is the send-Escape gesture, and the modifier is the gesture
    // rather than part of the keystroke, so it does not travel.
    const sent = dispositionForKey(esc({ shiftKey: true }));
    expect(sent.kind).toBe("forward");
    if (sent.kind !== "forward") throw new Error("unreachable");
    expect(sent.event.code).toBe("Escape");
    expect(sent.event.shiftKey).toBe(false);
    expect(JSON.parse(keyInputFrame(sent.event, "down")).shift).toBe(false);

    // A chord this surface has no rule for is forwarded whole rather than
    // guessed at.
    expect(dispositionForKey(esc({ ctrlKey: true }))).toEqual({
      kind: "forward",
      event: esc({ ctrlKey: true }),
      preventDefault: false,
    });

    // The release is announced. A reserved key nobody told the reader about is
    // a key that looks broken.
    expect(CONTROL_CAPTURE_LIMIT_COPY).toContain("Esc");
    expect(CONTROL_CAPTURE_LIMIT_COPY).toContain("Shift+Esc");
    expect(CONTROL_CAPTURE_LIMIT_COPY).toContain("화면 돌려주기");
  });

  it("routes every other key through the same forward path it always did", () => {
    const key = dispositionForKey({
      code: "Tab",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    });
    expect(key.kind).toBe("forward");
    if (key.kind !== "forward") throw new Error("unreachable");
    // Still swallowed at the page level — a VM's forms need Tab, and that is
    // honest only because Escape now exists as the way out.
    expect(key.preventDefault).toBe(true);
    expect(key.event.code).toBe("Tab");
  });

  it("says the keyboard left without claiming control ended", () => {
    // design-review H-2. The window is still open; only the caret moved. The
    // sentence has to carry both, plus the way back.
    expect(CONTROL_KEYBOARD_LOST_COPY).toContain("호스트로 가지 않습니다");
    expect(CONTROL_KEYBOARD_LOST_COPY).toContain("Tab");
    expect(CONTROL_KEYBOARD_LOST_COPY).toContain("조작 창은 그대로 열려 있습니다");
    expect(CONTROL_KEYBOARD_LOST_LABEL).not.toContain("인수");
  });

  it("swallows only the keys whose page-level default would be worse", () => {
    const key = (code: string, over: Partial<Record<string, boolean>> = {}) => ({
      code,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      ...over,
    });
    // Backspace navigates, Space and the arrows scroll, Tab moves focus out of
    // the capture surface — which reads as "the keyboard stopped working".
    for (const code of ["Tab", "Backspace", "Space", "ArrowLeft", "ArrowDown"]) {
      expect(controlSwallowsKey(key(code)), code).toBe(true);
    }
    expect(controlSwallowsKey(key("KeyA"))).toBe(false);
    // Browser and OS shortcuts are NOT swallowed, because they cannot be: the
    // chrome takes them first. The surface says so in words instead.
    expect(controlSwallowsKey(key("Tab", { metaKey: true }))).toBe(false);
    expect(controlSwallowsKey(key("Backspace", { ctrlKey: true }))).toBe(false);
    expect(CONTROL_CAPTURE_LIMIT_COPY).toContain("전달되지 않습니다");
  });
});

// -----------------------------------------------------------------------------
// THE RED PROOF: what the person types leaves no trace on this machine
// -----------------------------------------------------------------------------

/**
 * A password typed as physical keys. Nothing here is a real secret; what matters
 * is that the STRING `PASSPHRASE_MARKER` must appear in exactly one place — the
 * frames handed to the datachannel — and nowhere else this test can see.
 */
const PASSPHRASE = [
  "KeyH",
  "KeyU",
  "KeyN",
  "KeyT",
  "Digit3",
  "Digit9",
  "Minus",
  "KeyZ",
] as const;
const PASSPHRASE_MARKER = "Digit9";

/**
 * The four places a keystroke could land on this machine, as a recorder.
 *
 * Each one stands for something real: `console` for a log line and a devtools
 * transcript, `stored` for React state (and therefore the devtools component
 * tree), `attributes` for the DOM, `errors` for a thrown message that quotes
 * what it failed to send. The browser gate runs the same scan against the real
 * versions of all four.
 */
interface LeakSurfaces {
  console: string[];
  stored: unknown[];
  attributes: Record<string, string>;
  errors: string[];
}

/**
 * The RED SEAM. It changes the DRIVER, never the product.
 *
 * With `CONTROL_PROVE_RED_OBSERVED=1` the harness below writes what it typed
 * into all four surfaces. The product path is untouched — `forwardKey` still
 * cannot return a keystroke — and the assertion must go red anyway. That is
 * what proves the scan reaches those four places rather than passing because it
 * reaches none of them.
 *
 *   CONTROL_PROVE_RED_OBSERVED=1 npm --prefix clients/web run test -- controlStream
 *     expected failure: "a keystroke reached a surface this machine keeps"
 */
const PROVE_RED = process.env.CONTROL_PROVE_RED_OBSERVED === "1";

function typePassphrase(): {
  surfaces: LeakSurfaces;
  wire: string[];
  outcomes: string[];
} {
  const surfaces: LeakSurfaces = {
    console: [],
    stored: [],
    attributes: {},
    errors: [],
  };
  const wire: string[] = [];
  const sink: ControlInputSink = {
    readyState: "open",
    send(frame) {
      wire.push(frame);
    },
  };
  const outcomes: string[] = [];
  for (const code of PASSPHRASE) {
    const descriptor = {
      code,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      repeat: false,
    };
    // THE PRODUCT PATH, exactly as the component calls it.
    const down = forwardKey(sink, descriptor, "down");
    const up = forwardKey(sink, descriptor, "up");
    outcomes.push(down, up);

    if (PROVE_RED) {
      // The seam: a surface that remembered. Each line is a leak somebody could
      // plausibly write while "just adding a debug log" or "showing the last
      // key for the tooltip".
      surfaces.console.push(`forwarded ${code}`);
      surfaces.stored.push({ lastKey: code });
      surfaces.attributes["data-last-key"] = code;
      surfaces.errors.push(`could not send ${code}`);
    }
  }
  return { surfaces, wire, outcomes };
}

describe("what the person types leaves no trace on this machine", () => {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
  ];
  afterEach(() => {
    for (const spy of spies) spy.mockClear();
  });

  it("puts the keystroke on the datachannel and in no surface this machine keeps", () => {
    const { surfaces, wire } = typePassphrase();

    // It DID go somewhere: a test that proved only absence would pass on a
    // client that had quietly stopped forwarding anything at all.
    expect(wire.length).toBe(PASSPHRASE.length * 2);
    expect(wire.join("\n")).toContain(PASSPHRASE_MARKER);

    // And nowhere else. Each of the four is named in the failure message so a
    // red run says which surface leaked.
    const observed: string[] = [
      ...surfaces.console,
      ...surfaces.stored.map((value) => JSON.stringify(value)),
      ...Object.entries(surfaces.attributes).map(([k, v]) => `${k}=${v}`),
      ...surfaces.errors,
    ];
    for (const trace of observed) {
      expect(
        trace.includes(PASSPHRASE_MARKER),
        `a keystroke reached a surface this machine keeps: ${trace}`
      ).toBe(false);
    }

    // The module itself said nothing to any console while doing it.
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(PASSPHRASE_MARKER);
      }
    }
  });

  it("cannot tell its caller what was typed, because the type has no room", () => {
    // THE STRUCTURAL HALF, and the stronger one. Everything above is a scan of
    // places; this is the reason those places stay clean: the only thing the
    // component can learn from forwarding a key is one of three words, so a
    // component that stored the outcome of every keystroke would be storing
    // three possible words.
    const { outcomes } = typePassphrase();
    for (const outcome of outcomes) {
      expect(["sent", "dropped", "no_channel"]).toContain(outcome);
    }
    expect(new Set(outcomes)).toEqual(new Set(["sent"]));
  });

  it("swallows a channel that throws rather than quoting what it failed to send", () => {
    // The one place a payload could reach a stack trace. `dropped` is
    // undifferentiated on purpose: "closed" and "threw" are the same fact to a
    // person holding a keyboard, and splitting them invites a message that
    // quotes the frame.
    const thrower: ControlInputSink = {
      readyState: "open",
      send() {
        throw new Error("datachannel is closing");
      },
    };
    expect(
      forwardKey(
        thrower,
        {
          code: PASSPHRASE_MARKER,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          repeat: false,
        },
        "down"
      )
    ).toBe("dropped");
    expect(forwardPointer(thrower, { x: 0, y: 0 }, "move")).toBe("dropped");
    expect(forwardWheel(thrower, 0, 1)).toBe("dropped");
  });

  it("sends nothing at all when there is no channel to send on", () => {
    const closed: ControlInputSink = { readyState: "closed", send: () => {} };
    const descriptor = {
      code: PASSPHRASE_MARKER,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    };
    expect(forwardKey(null, descriptor, "down")).toBe("no_channel");
    expect(forwardKey(closed, descriptor, "down")).toBe("no_channel");
    expect(forwardPointer(closed, { x: 0, y: 0 }, "move")).toBe("no_channel");
    expect(forwardWheel(closed, 0, 1)).toBe("no_channel");
  });

  it("holds the same absence in the component's own source", () => {
    // Two shapes a leak would take that the runtime scan above cannot see,
    // because they would be written in the component rather than the module.
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(
      /console\.(log|warn|error|info|debug)/
    );
    // No state, ref or attribute named after a key. The channel itself is a ref
    // for the same reason: state is what React devtools walks.
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(
      /useState[^\n]*\b(key|code|keystroke|input)\b/i
    );
    expect(CONTROLLER_COMPONENT_CODE).not.toMatch(/data-(last-)?key=/);
    expect(CONTROLLER_COMPONENT_CODE).toMatch(/channelRef = useRef/);
  });
});

// -----------------------------------------------------------------------------
// the window always closes
// -----------------------------------------------------------------------------

describe("auto-return: every way this client can lose a keyboard", () => {
  // The three paths §4.3 asks for, plus the ones that share their machinery.
  const cases: Array<[ControlLifecycleEvent, ControlReturnReason]> = [
    [{ kind: "person_returned" }, "requested"],
    [{ kind: "negotiate_deadline" }, "negotiate_timeout"],
    [{ kind: "peer_failed" }, "producer_lost"],
    [{ kind: "channel_closed" }, "producer_lost"],
    [{ kind: "producer_error" }, "producer_lost"],
    [{ kind: "no_input_channel" }, "input_unavailable"],
    [{ kind: "ledger_revoked" }, "session_ended"],
    [
      { kind: "socket_closed", offered: true, sessionGone: false },
      "producer_lost",
    ],
    // A socket that died before the producer ever offered is the SAME failure
    // as the deadline: nothing ever came up. Two sentences here would be a
    // distinction made out of which timer fired first.
    [
      { kind: "socket_closed", offered: false, sessionGone: false },
      "negotiate_timeout",
    ],
    [
      { kind: "socket_closed", offered: true, sessionGone: true },
      "session_ended",
    ],
  ];

  it.each(cases)("%o closes the window as %s", (event, reason) => {
    expect(autoReturnFor(event)).toBe(reason);
  });

  it("has a sentence for every reason, and every one says what the agent does", () => {
    const reasons = new Set(cases.map(([, reason]) => reason));
    for (const reason of reasons) {
      const copy = CONTROL_RETURN_COPY[reason];
      expect(copy, reason).toBeTruthy();
      // The reader's real question. A sentence that only said "control ended"
      // would leave a person wondering whether their run is coming back.
      expect(copy, reason).toMatch(/에이전트|세션이 끝나면서/);
    }
  });

  it("gives up before the server's lease does, not after", () => {
    // The relation that makes the deadline honest: a client that gave up LATER
    // than the lease would be reporting a failure about a window the server had
    // already closed by itself.
    expect(CONTROL_NEGOTIATE_TIMEOUT_MS).toBeLessThan(CONTROL_LEASE_MS);
  });

  it("mirrors the lease from the ledger that owns it, not from memory", () => {
    // design-review M4. `CONTROL_LEASE_MS` is a COPY of a server constant, and
    // the whole reason it exists is to put a number in front of a person
    // ("최대 90초 뒤에 저절로 닫히고"). A copy checked against a literal in its
    // own test is a copy that can go stale in lockstep with the assertion that
    // was supposed to catch it, so the expected value is read from the source
    // of truth: `display_control.rs`'s own declaration.
    const rust = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../../server-rust/crates/momo-t3/src/display_control.rs",
          import.meta.url
        )
      ),
      "utf8"
    );
    const declared = rust.match(
      /pub const CONTROL_WINDOW_LEASE_SECONDS:\s*i64\s*=\s*(\d+)\s*;/
    );
    expect(declared, "the ledger no longer declares a lease by that name").not.toBeNull();
    expect(CONTROL_LEASE_MS).toBe(Number(declared![1]) * 1000);
    // And the sentence a reader sees carries that same number.
    expect(CONTROL_RETURN_FAILED_COPY).toContain(`${declared![1]}초`);
  });

  it("names the lease as the backstop when the return itself failed", () => {
    // The one path where the client has already failed. Claiming success would
    // be false, and an error with no next step would leave a person unsure
    // whether their agent is stopped forever.
    expect(CONTROL_RETURN_FAILED_COPY).toContain("저절로 닫히고");
    // It names no control, because pressing one again is exactly what just
    // failed.
    expect(CONTROL_RETURN_FAILED_COPY).not.toMatch(/다시 시도|다시 누르|재시도/);
  });

  it("says observation reopened only when it actually did", () => {
    // The server restores the OWNER's own setting, which is not always 열림.
    // An unconditional "관전이 다시 열렸습니다" is wrong for exactly the owner
    // most likely to be taking control.
    expect(controlObservationRestoredNote("open")).toContain("다시 팀원에게");
    expect(controlObservationRestoredNote("owner_only")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// who is offered a keyboard at all
// -----------------------------------------------------------------------------

describe("the affordance, and the silences around it", () => {
  it("offers control to the owner of a live session with a screen", () => {
    expect(controlAffordance(session(), true)).toEqual({
      offered: true,
      note: null,
    });
    expect(controlAffordance(session({ status: "idle" }), true).offered).toBe(true);
  });

  it("says NOTHING to a teammate, rather than saying no", () => {
    // 어포던스 부재 (LIVE-4 문법). Telling a teammate they may not take a
    // keyboard answers a question they did not ask, on a screen where nothing
    // they can do changes the answer. They still see the live screen.
    expect(controlAffordance(session(), false)).toEqual({
      offered: false,
      note: null,
    });
    expect(controlAffordance(session({ status: "ended" }), false).note).toBeNull();
  });

  it("states a reason the owner can act on, and never a dead button", () => {
    const noScreen = controlAffordance(
      session({ remoteDisplayAvailable: false }),
      true
    );
    expect(noScreen.offered).toBe(false);
    expect(noScreen.note).toContain("호스트 화면을 열어 두지 않아");

    const orphaned = controlAffordance(session({ status: "orphaned" }), true);
    expect(orphaned.note).toContain("호스트 연결이 끊겨");
    const ended = controlAffordance(session({ status: "ended" }), true);
    expect(ended.note).toContain("끝난 세션은");
    // The two are different sentences because the two futures are different:
    // an orphaned session can come back, an ended one cannot.
    expect(orphaned.note).not.toBe(ended.note);
  });

  it("does not gate the affordance on decoded frames", () => {
    // An IDLE desktop decodes no new frames, so a `framesDecoded > 0` gate
    // would remove the control from exactly the sessions most likely to need a
    // person, and say nothing about why.
    expect(framesGateControl()).toBe(false);
  });

  it("makes the invitation carry what taking control costs", () => {
    // The surprising part is not that the screen becomes clickable; it is that
    // an agent stops and a team loses the view. Both are reversible, which is
    // why this is an invitation and not a warning.
    expect(CONTROL_INVITE_COPY).toContain("에이전트가 이 세션에서 멈추고");
    expect(CONTROL_INVITE_COPY).toContain("소유자만 보기");
    expect(CONTROL_INVITE_COPY).toContain("원래대로");
  });

  it("gives the overlay mockup the product's own words", () => {
    // A mockup that invents its own copy reviews a screen the product will
    // never show.
    expect(CONTROL_OVERLAY_MOCKUP.label).toBe(CONTROL_START_LABEL);
    expect(CONTROL_OVERLAY_MOCKUP.confirm).toBe(CONTROL_INVITE_COPY);
  });
});

// -----------------------------------------------------------------------------
// the server's refusals
// -----------------------------------------------------------------------------

describe("why a controller grant was refused", () => {
  it("keeps 409 apart from the observer route's 409", () => {
    // On the observer route 409 means "this session has no screen". On a
    // controller request it ALSO means "one window per session, and it is not
    // yours" — the unique index, not a race. Folding them would tell an owner
    // whose teammate is mid-login that their session has no screen.
    expect(
      classifyControlGrantFailure(new ApiError(409, "control window is taken"))
    ).toBe("control_taken");
    expect(
      classifyControlGrantFailure(new ApiError(403, "not the session owner"))
    ).toBe("control_denied");
    expect(classifyControlGrantFailure(new ApiError(401, "unauthorized"))).toBe(
      "capability_denied"
    );
    expect(classifyControlGrantFailure(new ApiError(404, "no session"))).toBe(
      "session_unavailable"
    );
    expect(
      classifyControlGrantFailure(new NetworkError("timeout", 15_000))
    ).toBe("server_unreachable");
  });

  it("offers a retry only where one could change the answer", () => {
    const offered = controlAffordance(session(), true);
    expect(controlOffersRetry("control_taken", offered)).toBe(true);
    // Being the owner is not a thing a button changes, and a producer that
    // opened no channel would do the same thing again.
    expect(controlOffersRetry("control_denied", offered)).toBe(false);
    expect(controlOffersRetry("input_unavailable", offered)).toBe(false);
    // And nothing is retryable once the affordance itself is gone.
    const shut = controlAffordance(session({ status: "ended" }), true);
    expect(controlOffersRetry("control_taken", shut)).toBe(false);
  });

  it("borrows the display sentences for everything the two surfaces share", () => {
    // A refused connect-src is the same event whatever the bearer was, and the
    // OWNER form is always chosen: this module only ever runs for the owner.
    expect(controlFailureCopy("host_blocked_by_policy", displayFailureCopy)).toBe(
      displayFailureCopy("host_blocked_by_policy", true)
    );
    expect(controlFailureCopy("control_denied", displayFailureCopy)).toContain(
      "세션을 시작한 사람만"
    );
  });

  it("names the grade the server has to have sent", () => {
    expect(DISPLAY_CONTROLLER_MODE).toBe("controller");
  });
});

// -----------------------------------------------------------------------------
// the deep link that brings a person here
// -----------------------------------------------------------------------------

describe("the login handoff card's link carries an intent, not a promise", () => {
  it("seeks control while a person is still needed", () => {
    expect(
      loginHandoffSeeksControl({ phase: "waiting", control: null })
    ).toBe(true);
    expect(
      loginHandoffSeeksControl({
        phase: "resolved",
        control: { startedAtMs: 1, endedAtMs: null, endReason: null },
      })
    ).toBe(true);
  });

  it("does not, once the intervention is over", () => {
    expect(
      loginHandoffSeeksControl({
        phase: "resolved",
        control: { startedAtMs: 1, endedAtMs: 2, endReason: "returned" },
      })
    ).toBe(false);
    expect(loginHandoffSeeksControl({ phase: "stopped", control: null })).toBe(
      false
    );
  });
});
