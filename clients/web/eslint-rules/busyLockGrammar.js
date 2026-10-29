/**
 * 진행·잠금 문법 린트 규칙 (#1486 → #1502 · #1541 · #1543 · #1558 · #1559 → 시험 정리 T5 #4711).
 *
 * 문법의 정본은 이렇다.
 *
 *   진행  aria-busy + 바뀐 낱말. 흐리지 않고, 잠그지 않고, 초점을 놓지 않는다.
 *   잠금  aria-disabled + 흐림(opacity-50) + 사유 + 가드. tab order 는 떠나지 않는다.
 *
 * 이 문법은 한동안 소스 글자를 훑는 시험(`rawControlBusySplit` · `confirmBusySplit` ·
 * `settingsFieldsBusy`)이 지켰다. 시험은 `<Button` 으로 문자열을 쪼개고 정규식으로
 * 속성을 뽑아 비교했는데, 그 방식은 줄바꿈·주석·별칭에 약해서 별칭을 따라가는 그물을
 * 한 겹씩 더 파야 했다(#1595 H1). 여기서는 같은 규칙을 AST 로 건다. 린트는 바뀐 파일이
 * 저장될 때 바로 빨갛고, 주석은 노드가 아니라서 「주석에 반례를 인용했다가 걸리는」 일이
 * 없다(식 안 주석은 판정 전에 공백으로 지운다).
 *
 * ── 규칙 셋 ────────────────────────────────────────────────────────────────
 *
 * 1. `momo/busy-lock-grammar` — 쓰기를 내는 설정·호스티드 표면 열한 파일에만 건다
 *    (범위는 busyLockScope.js 의 BUSY_LOCK_GRAMMAR_FILES). 새 파일은 자동으로 들어오지
 *    않는다: 옛 시험도 이름을 단 파일 목록만 재었고, 범위를 글롭으로 넓히는 것은
 *    다른 워커가 같은 디렉터리에 새 카드를 세우는 동안 하지 않는다.
 *
 *    · nativeDisabled — `<Button disabled=…>`. 잠긴 버튼은 tab order 를 떠나고 사유가
 *      키보드·AT 로 닿을 수 없는 곳에 놓이며, 초점을 쥔 채 잠기면 초점이 <body> 로
 *      떨어진다(#1541). 폼 필드(`<input disabled>`)의 native disabled 는 옳다 — 이 검사는
 *      버튼만 본다. `ConfirmButton` 의 `disabled` 는 DOM 속성이 아니라 컴포넌트 prop 이다.
 *    · selfLock — 진행을 말하는 컨트롤(`<Button aria-busy>` · `<ConfirmButton busy>`)의
 *      잠금 식(`aria-disabled` · 흐림 조건 · `disabled`)이 **자기 진행**을 그대로 들고
 *      있다. 쓰기를 낸 그 버튼이 자기가 켠 busy 로 자기를 잠그면 화면에 하나뿐인 진행
 *      낱말이 흐림 아래에서 죽고 낭독은 「…하는 중, 사용 안 함」이 된다(#1403 H-1).
 *      잠금 식은 `const x = …;` 별칭을 네 겹까지 따라가 편 뒤에 잰다(`Boolean(…)` ·
 *      `as boolean` · `useMemo(() => …)` 로 감싼 별칭도 벗겨서 본다) — 결함은 `busy`
 *      라는 글자가 아니라 접힘 변수 뒤에 숨어 있었다(#1558 · #1595 H1). 재는 방법은 둘이다:
 *      (가) 식에 진행 어휘가 남았는데 자기 진행의 부정(`!자기`)이 없다, (나) 진행 어휘가
 *      아닌 이름 뒤에 숨은 접힘까지 보려고 불리언 식으로 접어 「자기 진행 하나만으로 잠금이
 *      켜지는 맥락」이 있는지 진리표로 확인한다. 자기 진행은 파생값이다: `a || b`·`a && b` 로
 *      펴져도 자기 항 배정을 모두 돌며, 같은 다른-항 환경에서 (자기=꺼짐, 잠금=꺼짐)과
 *      (자기=켜짐, 잠금=켜짐)이 둘 다 나오면 접힌 것이다. 형제 쓰기로 잠기는 것
 *      (`busy && !자기진행`, 자기진행이 `a || b` 든 `a && b` 든)은 갈라내는 문법 그대로라 통과한다.
 *      식이 진리표 상한보다 크면 건너뛰지 않고 lockTooComplex 로 붉힌다.
 *    · opacityFollowsLock / opacityOutsideLock — `aria-disabled={L}` 이 있으면 흐림은
 *      **같은 식 L** 하나가 켠다(`cn(…, L && "opacity-50")`). 흐림 없는 잠금은 회색이 아닌
 *      죽은 버튼이고, 다른 조건·삼항 가지·고정 클래스·템플릿에 선 흐림(`opacity-*`)은 진행을
 *      잠금처럼 그리거나 잠기지 않았는데 늘 흐린 버튼을 만든다(#2923 · review-2909 · #1558).
 *      옛 시험은 모르는 꼴이면 빨갰으므로(전문 정규식·등치), 이 규칙은 흐림 토큰이 잠금 인자
 *      밖에 보이면 붉다. 토큰은 **문자열 리터럴 · 템플릿 조각 · 풀리는 `const` 별칭(네 겹)** 에서
 *      읽는다 — selfLock 이 별칭을 펴는 것과 같은 방식이다.
 *      **알려진 구멍**(조용히 통과): 풀리지 않는 값(prop `triggerClassName`·import·함수 인자),
 *      멤버 읽기(`styles.dim`)·호출 결과(`getDim(x)`)·JSX 스프레드(`{...props}`), 쪼갠 토큰
 *      (`"opaci" + "ty-70"`), 자식 노드의 흐림. 풀리지 않는 값은 `SettingsFields.tsx` 의
 *      `triggerClassName` 처럼 정당하게도 쓰이므로 붉힐 수 없다.
 *    · reasonBreakKeep — id 에 reason·note 가 든 `<p>`·`<span>` 은 한글 줄바꿈 규칙
 *      (`break-keep`)을 든다. 사유는 두세 어절이라 좁은 칸에서 어절 중간이 끊긴다(#1595 M6).
 *    · offlineQueuePromise — 「그대로 보내져요」 문장과 `networkMode`·`onlineManager`.
 *      이 클라이언트에는 오프라인 큐가 없으므로 사유 문장이 큐를 약속하면 거짓이다.
 *      큐가 생기는 날 이 검사가 먼저 붉어지고, 그때 문장을 되돌리는 것이 옳은 순서다(#1595 H4).
 *
 * 2. `momo/in-flight-lock-props` — `src/features/**` 전수(시험 제외). 새 소비처도 자동으로
 *    이 규율 아래 선다. 옛 그물처럼 식의 **글자**를 본다(문자열 상태 낱말 `status !== "saving"`
 *    이나 `save["isPending"]` 도 걸린다). 별칭은 따라가지 않는다 — 따라가면 지금 한 자리가 더
 *    붉다(PR 본문 「후속」).
 *
 *    · `<SaveButton canSave={…진행 어휘…}>` — 진행이 prop 을 타고 잠금으로 되돌아온다(#1558).
 *    · `<SaveButton>` 에 `canSave={식}` 이 없다(생략·축약) — 잠금이 어디서 오는지 볼 수 없다.
 *    · `<ChoiceRadios disabled={…진행 어휘…}>` — `<fieldset disabled>` 는 초점을 쥔 라디오를
 *      끄고 초점을 <body> 로 떨어뜨린다(#1595 H3).
 *
 * 3. `momo/busy-lock-primitives` — `SettingsFields.tsx` 에만. 위 규칙들이 JSX 이름으로
 *    겨누는 컴포넌트(SaveButton · ConfirmButton · ChoiceRadios)가 정의 파일에 아직 있는가.
 *    옛 시험은 소비처가 하나도 안 잡히면 붉어서 이름을 바꿔도 눈먼 초록이 되지 못했다.
 *
 * 양성 fixture: `busyLockGrammar.test.ts` — 위 변조마다 소스 한 조각이 이 규칙으로 실제로
 * 빨간지 잰다(실제 `eslint.config.js` 로 린트해서 범위 연결까지 한 번에 건다).
 */

/** 진행을 말하는 낱말. 잠금 식에 맨몸으로 남으면 그 진행이 자기 잠금에 끼어든 것이다. */
const IN_FLIGHT =
  /\b(isPending|busy|rotating|revoking|saving|checking|uploading|creating|toggling|removing|clearing|unlinking|sending|loading)\b/;

/** `canSave` 에 접혀 들어오면 안 되는 진행 어휘(#1558). 옛 그물과 같은 글자 검사, 대소문자 무시. */
const CAN_SAVE_IN_FLIGHT = /\b(busy|isPending|isLoading|isFetching|saving)\b/i;

/** 별칭을 따라가는 깊이. 옛 시험과 같다. */
const ALIAS_DEPTH = 4;

/**
 * 진리표를 다 도는 알갱이 수의 상한(잠금 식의 알갱이와 자기 진행의 알갱이의 합집합).
 * 이보다 크면 건너뛰지 않고 lockTooComplex 로 붉힌다. 비용은 2^(다른 항) × 2^(자기 항) = 2^합집합.
 */
const MAX_ATOMS = 15;

/** 흐림 계열 클래스 토큰(변형 접두 포함): `opacity-50` · `hover:opacity-70`. */
const OPACITY_TOKEN = /(^|:)opacity-/;

/** 잠금이 켜는 흐림. 다른 값은 잠금 인자 안에서도 붉다. */
const LOCK_OPACITY = "opacity-50";

/** 위 규칙들이 JSX 이름으로 겨누는 컴포넌트. 정의 파일이 이 셋을 export 해야 한다. */
const REQUIRED_PRIMITIVES = ["SaveButton", "ConfirmButton", "ChoiceRadios"];

/** 공백과 괄호를 걷어낸 꼴. `!(create.isPending)` 과 `!create.isPending` 은 같다. */
const flat = (text) => text.replace(/[\s()]/g, "");

function tagName(opening) {
  return opening.name.type === "JSXIdentifier" ? opening.name.name : null;
}

function attrOf(opening, name) {
  return opening.attributes.find(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === name
  );
}

function exprOf(attr) {
  return attr && attr.value && attr.value.type === "JSXExpressionContainer"
    ? attr.value.expression
    : null;
}

/** className 속성의 값 노드: `{식}` 이면 그 식, `"문자열"` 이면 그 리터럴. */
function classValueOf(attr) {
  if (!attr || !attr.value) return null;
  return attr.value.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
}

/** `X || undefined` 꼬리는 잠금·진행의 사실이 아니라 속성을 비우는 표기다. */
function withoutUndefinedTail(expr) {
  return expr.type === "LogicalExpression" &&
    expr.operator === "||" &&
    expr.right.type === "Identifier" &&
    expr.right.name === "undefined"
    ? expr.left
    : expr;
}

function* childNodes(node, visitorKeys) {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child) yield child;
    } else if (value) {
      yield value;
    }
  }
}

function walk(node, visitorKeys, visit) {
  visit(node);
  for (const child of childNodes(node, visitorKeys)) walk(child, visitorKeys, visit);
}

/**
 * 노드의 원문. 노드 안 주석은 같은 길이의 공백으로 지운다 — 식 안에 「saving 중에는 …」 같은 설명
 * 주석이 있다고 어휘 검사가 붉어지면 안 된다(주석은 노드가 아니다). 길이를 보존하므로 노드 시작을
 * 기준으로 한 위치 계산은 그대로 맞는다.
 */
function textOf(sourceCode, node) {
  let text = sourceCode.getText(node);
  const base = node.range[0];
  for (const comment of sourceCode.getCommentsInside(node)) {
    const from = comment.range[0] - base;
    const to = comment.range[1] - base;
    text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);
  }
  return text;
}

const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function isUseMemoCallee(callee) {
  return (
    (callee.type === "Identifier" && callee.name === "useMemo") ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "useMemo")
  );
}

/**
 * 값을 감싸기만 하는 꺼풀을 벗긴다: `x as boolean` · `x!` · `Boolean(x)` ·
 * `useMemo(() => x, deps)`(식 몸통 또는 return 하나뿐인 블록). 벗기지 않으면 별칭을
 * 이 꺼풀로 감싸는 것만으로 접힘 검사를 피해 간다.
 */
function unwrapValue(node) {
  let current = node;
  for (let guard = 0; guard < 8; guard += 1) {
    if (TS_WRAPPERS.has(current.type)) {
      current = current.expression;
      continue;
    }
    if (current.type === "CallExpression") {
      const { callee, arguments: args } = current;
      if (callee.type === "Identifier" && callee.name === "Boolean" && args.length === 1) {
        current = args[0];
        continue;
      }
      const fn = args[0];
      if (
        isUseMemoCallee(callee) &&
        fn &&
        (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression")
      ) {
        if (fn.body.type !== "BlockStatement") {
          current = fn.body;
          continue;
        }
        const statements = fn.body.body;
        if (statements.length === 1 && statements[0].type === "ReturnStatement" && statements[0].argument) {
          current = statements[0].argument;
          continue;
        }
      }
    }
    break;
  }
  return current;
}

/** 별칭 본문이 될 수 있는 모양. 호출·객체·함수는 값이 아니라 계산이라 펴지 않는다. */
const ALIAS_INIT_TYPES = new Set([
  "LogicalExpression",
  "UnaryExpression",
  "BinaryExpression",
  "ConditionalExpression",
  "MemberExpression",
  "ChainExpression",
  "Identifier",
]);

function lookupVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const found = current.set.get(name);
    if (found) return found;
  }
  return null;
}

/** `const NAME = <식>;` 한 줄 별칭의 우변(꺼풀을 벗긴 것). 구조분해·let·함수 인자는 별칭이 아니다. */
function aliasInit(variable) {
  if (!variable || variable.defs.length !== 1) return null;
  const def = variable.defs[0];
  if (def.type !== "Variable" || def.parent.kind !== "const") return null;
  if (def.node.id.type !== "Identifier" || !def.node.init) return null;
  const init = unwrapValue(def.node.init);
  return ALIAS_INIT_TYPES.has(init.type) ? init : null;
}

/**
 * 식의 원문에서 별칭 식별자를 (펼친 본문)으로 바꾼 문자열.
 * `submitBlocked` → `(offline || busy || …)` → …, 최대 ALIAS_DEPTH 겹.
 */
function createExpander(sourceCode) {
  const { visitorKeys } = sourceCode;
  function expand(node, depth) {
    const base = node.range[0];
    const replacements = [];
    if (depth > 0) {
      walk(node, visitorKeys, (inner) => {
        if (inner.type !== "Identifier") return;
        const parent = inner.parent;
        // `create.isPending` 의 isPending 이나 객체 키는 변수 참조가 아니다.
        if (parent?.type === "MemberExpression" && parent.property === inner && !parent.computed) return;
        if (parent?.type === "Property" && parent.key === inner && !parent.computed) return;
        const init = aliasInit(lookupVariable(sourceCode.getScope(inner), inner.name));
        if (!init) return;
        replacements.push([inner.range[0] - base, inner.range[1] - base, `(${expand(init, depth - 1)})`]);
      });
    }
    let text = textOf(sourceCode, node);
    for (const [from, to, replacement] of replacements.sort((a, b) => b[0] - a[0])) {
      text = text.slice(0, from) + replacement + text.slice(to);
    }
    return text;
  }
  return (node) => expand(node, ALIAS_DEPTH);
}

/**
 * 잠금 식을 불리언 식 트리로 접는다 — 별칭을 따라가며, 비교·호출·멤버 읽기는 한 알갱이(atom)다.
 * 알갱이의 열쇠는 공백·괄호를 걷은 원문이라 `create.isPending` 이 별칭 안팎에서 같은 알갱이가 된다.
 */
function toBoolTree(sourceCode, rawNode, depth) {
  const node = unwrapValue(rawNode);
  const atom = () => ({ op: "atom", key: flat(textOf(sourceCode, node)) });
  switch (node.type) {
    case "Literal":
      return { op: "const", value: Boolean(node.value) };
    case "Identifier": {
      if (node.name === "undefined") return { op: "const", value: false };
      const init = depth > 0 ? aliasInit(lookupVariable(sourceCode.getScope(node), node.name)) : null;
      return init ? toBoolTree(sourceCode, init, depth - 1) : atom();
    }
    case "LogicalExpression": {
      const left = toBoolTree(sourceCode, node.left, depth);
      const right = toBoolTree(sourceCode, node.right, depth);
      return { op: node.operator === "&&" ? "and" : "or", left, right };
    }
    case "UnaryExpression":
      return node.operator === "!"
        ? { op: "not", arg: toBoolTree(sourceCode, node.argument, depth) }
        : atom();
    case "ConditionalExpression":
      return {
        op: "cond",
        test: toBoolTree(sourceCode, node.test, depth),
        yes: toBoolTree(sourceCode, node.consequent, depth),
        no: toBoolTree(sourceCode, node.alternate, depth),
      };
    default:
      return atom();
  }
}

function atomKeys(tree, out = new Set()) {
  switch (tree.op) {
    case "atom":
      out.add(tree.key);
      break;
    case "and":
    case "or":
      atomKeys(tree.left, out);
      atomKeys(tree.right, out);
      break;
    case "not":
      atomKeys(tree.arg, out);
      break;
    case "cond":
      atomKeys(tree.test, out);
      atomKeys(tree.yes, out);
      atomKeys(tree.no, out);
      break;
    default:
  }
  return out;
}

function evalTree(tree, env) {
  switch (tree.op) {
    case "const":
      return tree.value;
    case "atom":
      return env.get(tree.key) === true;
    case "and":
      return evalTree(tree.left, env) && evalTree(tree.right, env);
    case "or":
      return evalTree(tree.left, env) || evalTree(tree.right, env);
    case "not":
      return !evalTree(tree.arg, env);
    default:
      return evalTree(tree.test, env) ? evalTree(tree.yes, env) : evalTree(tree.no, env);
  }
}

/**
 * 자기 진행(own)이 잠금을 켜는가. 자기 진행은 **파생값**이다: `creating`(알갱이 하나)일 수도,
 * `creating || rotating`·`pending && variables === id`(여러 알갱이의 식)일 수도 있다.
 * 잠금에 나오지 않는 다른 항의 환경마다 자기 항의 모든 배정을 돌아, (자기=꺼짐, 잠금=꺼짐)과
 * (자기=켜짐, 잠금=켜짐)이 둘 다 나오면 접힌 것이다 — 그 환경에서 자기 진행이 잠금을 쥔다.
 * `offline || (busy && !creating)` 는 busy 가 creating 을 품은 별칭이어도 그런 환경이 없고,
 * 자기 진행이 `a || b`·`a && b` 로 펴진 올바른 꼴(`busy && !자기`)도 마찬가지다.
 */
function ownBusyFlipsLock(lockTree, ownTree) {
  const ownKeys = [...atomKeys(ownTree)];
  const lockKeys = [...atomKeys(lockTree)];
  if (!ownKeys.some((key) => lockKeys.includes(key))) return false;
  const others = lockKeys.filter((key) => !ownKeys.includes(key));
  for (let mask = 0; mask < 2 ** others.length; mask += 1) {
    const base = new Map(others.map((key, index) => [key, Boolean(mask & (1 << index))]));
    const seen = new Set();
    for (let own = 0; own < 2 ** ownKeys.length; own += 1) {
      const env = new Map(base);
      ownKeys.forEach((key, index) => env.set(key, Boolean(own & (1 << index))));
      seen.add(`${evalTree(ownTree, env)}/${evalTree(lockTree, env)}`);
    }
    if (seen.has("false/false") && seen.has("true/true")) return true;
  }
  return false;
}

/** `const NAME = <무엇이든>;` 의 우변. 클래스 문자열을 담은 변수를 따라가는 데 쓴다(불리언 꼴로 한정하지 않는다). */
function constInit(variable) {
  if (!variable || variable.defs.length !== 1) return null;
  const def = variable.defs[0];
  if (def.type !== "Variable" || def.parent.kind !== "const") return null;
  if (def.node.id.type !== "Identifier" || !def.node.init) return null;
  return def.node.init;
}

/**
 * 문자열 리터럴·템플릿 조각 안의 흐림 계열 토큰. 논리식·삼항 가지·중첩 호출 속 문자열까지 훑고,
 * 풀리는 `const` 별칭(`const dimClass = toggling ? "opacity-60" : ""`)은 우변까지 따라간다.
 * 풀리지 않는 식별자(prop·import·함수 인자)는 속을 모르므로 건너뛴다.
 */
function opacityTokensIn(node, sourceCode, depth = ALIAS_DEPTH) {
  const tokens = [];
  walk(node, sourceCode.visitorKeys, (inner) => {
    if (inner.type === "Literal" && typeof inner.value === "string") {
      for (const token of inner.value.split(/\s+/)) if (OPACITY_TOKEN.test(token)) tokens.push(token);
    } else if (inner.type === "TemplateElement") {
      for (const token of (inner.value.cooked ?? inner.value.raw).split(/\s+/)) {
        if (OPACITY_TOKEN.test(token)) tokens.push(token);
      }
    } else if (inner.type === "Identifier" && depth > 0) {
      const parent = inner.parent;
      if (parent?.type === "MemberExpression" && parent.property === inner && !parent.computed) return;
      if (parent?.type === "Property" && parent.key === inner && !parent.computed) return;
      const init = constInit(lookupVariable(sourceCode.getScope(inner), inner.name));
      if (init) tokens.push(...opacityTokensIn(init, sourceCode, depth - 1));
    }
  });
  return tokens;
}

/** 잠금 인자(`L && 오른쪽`)의 오른쪽이 될 수 있는 모양: 문자열 · 템플릿 · 풀리는 별칭. */
const LOCK_ARG_RIGHT = new Set(["Literal", "TemplateLiteral", "Identifier"]);

/**
 * className 식을 흐림 관점으로 가른다.
 *  - dimming: `L && "…"` 꼴 인자 중 문자열에 흐림 토큰이 든 것({ condition: L, tokens }).
 *  - strays:  그 밖의 자리(고정 문자열 · 삼항 가지 · 템플릿 · 중첩 호출 · 다른 꼴의 인자)에 선 흐림 토큰.
 * `cn(…)` 호출이 아닌 className 식은 통째로 strays 다.
 */
function opacityShape(classNameExpr, sourceCode) {
  const shape = { dimming: [], strays: [] };
  if (!classNameExpr) return shape;
  const isCn =
    classNameExpr.type === "CallExpression" &&
    classNameExpr.callee.type === "Identifier" &&
    classNameExpr.callee.name === "cn";
  if (!isCn) {
    shape.strays.push(...opacityTokensIn(classNameExpr, sourceCode));
    return shape;
  }
  for (const arg of classNameExpr.arguments) {
    if (arg.type === "LogicalExpression" && arg.operator === "&&" && LOCK_ARG_RIGHT.has(arg.right.type)) {
      const tokens = opacityTokensIn(arg.right, sourceCode);
      // 조건(arg.left) 안의 문자열은 클래스가 아니다 — 훑지 않는다.
      if (tokens.length > 0) shape.dimming.push({ condition: arg.left, tokens });
    } else {
      shape.strays.push(...opacityTokensIn(arg, sourceCode));
    }
  }
  return shape;
}

/** 진행을 말하는 컨트롤이면 { busy, locks } 를, 아니면 null. */
function busyControl(opening, sourceCode) {
  const name = tagName(opening);
  if (name !== null && /^Button/.test(name)) {
    const busy = exprOf(attrOf(opening, "aria-busy"));
    if (!busy) return null;
    const locks = [];
    const disabled = exprOf(attrOf(opening, "aria-disabled"));
    if (disabled) locks.push(withoutUndefinedTail(disabled));
    // 흐림도 잠금이다. `cn(x && "opacity-…")` 의 x 가 그 식이다.
    locks.push(
      ...opacityShape(classValueOf(attrOf(opening, "className")), sourceCode).dimming.map(
        (dim) => dim.condition
      )
    );
    return { busy: withoutUndefinedTail(busy), locks };
  }
  if (name === "ConfirmButton") {
    const busy = exprOf(attrOf(opening, "busy"));
    if (!busy) return null;
    const disabled = exprOf(attrOf(opening, "disabled"));
    return { busy, locks: disabled ? [disabled] : [] };
  }
  return null;
}

/** 주석 자리를 같은 길이의 공백으로 지운 소스. 옛 `copyOnly` 는 정규식으로, 여기는 주석 토큰으로 지운다. */
function sourceWithoutComments(sourceCode) {
  let text = sourceCode.getText();
  for (const comment of sourceCode.getAllComments()) {
    text =
      text.slice(0, comment.range[0]) +
      text.slice(comment.range[0], comment.range[1]).replace(/[^\n]/g, " ") +
      text.slice(comment.range[1]);
  }
  return text;
}

/** @type {import("eslint").Rule.RuleModule} */
export const busyLockGrammar = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      nativeDisabled:
        "<Button disabled> 는 잠긴 버튼을 tab order 에서 빼고 사유를 닿을 수 없는 곳에 둔다. aria-disabled={잠금 || undefined} + 흐림 + 사유 + 클릭 가드로 잠근다 (진행·잠금 문법 #1486 · #1541).",
      selfLock:
        "진행을 말하는 컨트롤의 잠금 식이 자기 진행({{busy}})을 그대로 든다. 쓰기를 낸 버튼이 자기 busy 로 자기를 잠그면 진행 낱말이 흐림 아래서 죽는다. 잠금은 `형제진행 && !{{busy}}` 로 갈라낸다 (#1403 H-1 · #1558 · #1595 H1). 펼친 식: {{opened}}",
      lockTooComplex:
        "잠금 식이 너무 커서 진행이 자기 잠금에 끼는지 확인할 수 없다(서로 다른 항 {{count}}개). 별칭 하나로 나눠 이름을 붙인다.",
      opacityFollowsLock:
        "흐림(`cn(…, L && \"opacity-50\")`)의 조건이 aria-disabled 의 잠금 식과 같지 않다. 잠금과 흐림은 한 식에서 나온다 (#2923).",
      opacityOutsideLock:
        "흐림({{tokens}})이 잠금 식과 같은 조건 하나(`cn(…, L && \"opacity-50\")`) 밖에 선다. 다른 조건·삼항·고정 클래스·템플릿의 흐림은 진행을 잠금처럼 그리거나 잠기지 않았는데 늘 흐린 버튼을 만든다 (#2923 · review-2909 · #1558).",
      reasonBreakKeep:
        "사유·안내 문장 노드(id 에 reason·note)는 `break-keep` 을 든다. 좁은 칸에서 어절 중간이 끊긴다 (#1595 M6).",
      offlineQueuePromise:
        "이 클라이언트에는 오프라인 큐가 없다(「그대로 보내져요」 약속·networkMode·onlineManager). 큐가 생겼다면 사유 문장을 먼저 되돌린다 (#1595 H4).",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const expand = createExpander(sourceCode);
    return {
      JSXOpeningElement(node) {
        const name = tagName(node);

        // 1) 버튼의 native disabled
        if (name !== null && /^Button/.test(name)) {
          const disabled = attrOf(node, "disabled");
          if (disabled) context.report({ node: disabled, messageId: "nativeDisabled" });
        }

        // 2) 자기 진행을 잠금 식에 다시 끼우지 않는다
        const control = busyControl(node, sourceCode);
        if (control) {
          const own = flat(expand(control.busy));
          const ownTree = toBoolTree(sourceCode, control.busy, ALIAS_DEPTH);
          // 자기 진행이 별칭으로 `a || b`·`a && b` 로 펴져도 구성 알갱이 하나하나의 부정, 또는 식 전체의 부정이면 된다.
          const ownKeys = [...atomKeys(ownTree)];
          for (const lock of control.locks) {
            const opened = flat(expand(lock));
            // (가) 옛 별칭 스캔: 진행 어휘가 남아 있으면 자기 진행의 부정이 함께 서 있어야 한다.
            const ownNegated = opened.includes(`!${own}`) || ownKeys.every((key) => opened.includes(`!${key}`));
            const inFlightWithoutOwnNegation = IN_FLIGHT.test(opened) && !ownNegated;
            // (나) 옛 ConfirmButton 검사를 의미로 올린 것: 자기 진행이 잠금을 쥐는 맥락이 없다.
            const lockTree = toBoolTree(sourceCode, lock, ALIAS_DEPTH);
            const atomCount = new Set([...atomKeys(lockTree), ...ownKeys]).size;
            // 건너뛰면 큰 식일수록 조용히 통과한다. 못 재면 붉힌다.
            const tooComplex = atomCount > MAX_ATOMS;
            if (tooComplex) {
              context.report({ node: lock, messageId: "lockTooComplex", data: { count: String(atomCount) } });
            }
            const selfFolded = !tooComplex && ownBusyFlipsLock(lockTree, ownTree);
            if (selfFolded || inFlightWithoutOwnNegation) {
              context.report({
                node: lock,
                messageId: "selfLock",
                data: { busy: own, opened },
              });
            }
          }
        }

        // 3) 흐림은 aria-disabled 의 같은 식 하나가 켠다
        if (name === "Button") {
          const ariaDisabled = exprOf(attrOf(node, "aria-disabled"));
          if (ariaDisabled || attrOf(node, "aria-busy")) {
            const classAttr = attrOf(node, "className");
            const shape = opacityShape(classValueOf(classAttr), sourceCode);
            const lock = ariaDisabled ? flat(textOf(sourceCode, withoutUndefinedTail(ariaDisabled))) : null;
            const sameAsLock = (dim) => lock !== null && flat(textOf(sourceCode, dim.condition)) === lock;
            const reportNode = classAttr ?? node;
            const conditionBroken = Boolean(ariaDisabled) && !shape.dimming.some(sameAsLock);
            if (conditionBroken) {
              context.report({ node: reportNode, messageId: "opacityFollowsLock" });
            }
            const strays = [...shape.strays];
            for (const dim of shape.dimming) {
              // 조건이 틀렸다는 말은 위 메시지가 이미 했다 — 같은 원인을 두 번 말하지 않는다.
              if (conditionBroken) continue;
              strays.push(...(sameAsLock(dim) ? dim.tokens.filter((token) => token !== LOCK_OPACITY) : dim.tokens));
            }
            if (strays.length > 0) {
              context.report({
                node: reportNode,
                messageId: "opacityOutsideLock",
                data: { tokens: [...new Set(strays)].join(", ") },
              });
            }
          }
        }

        // 4) 사유·안내 노드는 한글 줄바꿈 규칙을 든다
        if (name === "p" || name === "span") {
          const idExpr = exprOf(attrOf(node, "id"));
          if (
            idExpr &&
            /reason|note/i.test(textOf(sourceCode, idExpr)) &&
            !textOf(sourceCode, node).includes("break-keep")
          ) {
            context.report({ node, messageId: "reasonBreakKeep" });
          }
        }
      },

      "Program:exit"() {
        // 5) 오프라인 큐를 약속하지 않는다. 주석은 노드가 아니라서 반례 인용은 걸리지 않는다.
        const text = sourceWithoutComments(sourceCode);
        for (const pattern of [/그대로 보내져요/g, /\bnetworkMode\b|\bonlineManager\b/g]) {
          for (const match of text.matchAll(pattern)) {
            context.report({
              loc: {
                start: sourceCode.getLocFromIndex(match.index),
                end: sourceCode.getLocFromIndex(match.index + match[0].length),
              },
              messageId: "offlineQueuePromise",
            });
          }
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
export const inFlightLockProps = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      saveButtonCanSave:
        "<SaveButton canSave> 에 진행 어휘({{word}})가 접혀 들어왔다. 잠금은 !canSave 하나에서만 오고 진행은 낱말과 aria-busy 로만 말한다 (#1558).",
      saveButtonCanSaveMissing:
        "<SaveButton> 에는 canSave={식} 이 있어야 한다. 잠금이 어디서 오는지 식으로 적혀 있지 않으면(생략·축약) 린트도 사람도 진행이 접혔는지 볼 수 없다 (#1558).",
      choiceRadiosDisabled:
        "<ChoiceRadios disabled> 에 진행 어휘({{word}})가 있다. `<fieldset disabled>` 는 초점을 쥔 라디오를 끄고 초점을 <body> 로 떨어뜨린다. 진행은 ChoiceRadios 의 busy 로 말한다 (#1595 H3).",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      JSXOpeningElement(node) {
        const name = tagName(node);
        if (name === "SaveButton") {
          const attr = attrOf(node, "canSave");
          const expr = exprOf(attr);
          if (!expr) {
            // 옛 소비처 그물은 모든 <SaveButton> 에 canSave={…} 가 있을 것을 요구했다(없으면 붉다).
            context.report({ node: attr ?? node, messageId: "saveButtonCanSaveMissing" });
          } else {
            const word = CAN_SAVE_IN_FLIGHT.exec(textOf(sourceCode, expr))?.[1];
            if (word) context.report({ node: attr, messageId: "saveButtonCanSave", data: { word } });
          }
        }
        if (name === "ChoiceRadios") {
          const attr = attrOf(node, "disabled");
          const expr = exprOf(attr);
          const word = expr && IN_FLIGHT.exec(textOf(sourceCode, expr))?.[1];
          if (word) context.report({ node: attr, messageId: "choiceRadiosDisabled", data: { word } });
        }
      },
    };
  },
};

/**
 * 규칙이 이름으로 겨누는 컴포넌트가 정의 파일에 아직 있는가.
 *
 * `in-flight-lock-props` 는 `<SaveButton>`·`<ChoiceRadios>` 를, `busy-lock-grammar` 는 `<ConfirmButton>` 을
 * JSX 이름으로 찾는다. 옛 시험은 소비처가 하나도 안 잡히면(`seen >= 5`) 붉어서 이름을 바꿔도 눈먼 초록이
 * 되지 못했다. 린트 규칙에는 그 장치가 없으므로 정의 파일이 세 이름을 export 하는지를 한 번 더 잰다.
 * 이름을 바꿨다면 이 파일의 대상 이름도 함께 바꾼다.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const busyLockPrimitives = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missingPrimitive:
        "진행·잠금 규칙이 이름으로 겨누는 컴포넌트({{names}})가 이 파일에서 export 되지 않는다. 이름을 바꿨거나 옮겼다면 eslint-rules/busyLockGrammar.js 의 대상 이름과 범위를 함께 바꾼다(규칙이 조용히 눈먼 채 초록이 되지 않게).",
    },
  },
  create(context) {
    return {
      "Program:exit"(program) {
        const exported = new Set();
        for (const statement of program.body) {
          if (statement.type !== "ExportNamedDeclaration") continue;
          const declaration = statement.declaration;
          if (declaration?.type === "FunctionDeclaration" && declaration.id) exported.add(declaration.id.name);
          if (declaration?.type === "VariableDeclaration") {
            for (const item of declaration.declarations) {
              if (item.id.type === "Identifier") exported.add(item.id.name);
            }
          }
        }
        const missing = REQUIRED_PRIMITIVES.filter((name) => !exported.has(name));
        if (missing.length > 0) {
          context.report({ node: program, messageId: "missingPrimitive", data: { names: missing.join(", ") } });
        }
      },
    };
  },
};

export const busyLockPlugin = {
  meta: { name: "momo-busy-lock" },
  rules: {
    "busy-lock-grammar": busyLockGrammar,
    "in-flight-lock-props": inFlightLockProps,
    "busy-lock-primitives": busyLockPrimitives,
  },
};
