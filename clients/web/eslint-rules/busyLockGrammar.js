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
 * 없다.
 *
 * ── 규칙 둘 ────────────────────────────────────────────────────────────────
 *
 * 1. `momo/busy-lock-grammar` — 쓰기를 내는 설정·호스티드 표면 열한 파일에만 건다
 *    (범위는 eslint.config.js 의 BUSY_LOCK_GRAMMAR_FILES). 새 파일은 자동으로 들어오지
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
 *      잠금 식은 `const x = …;` 별칭을 네 겹까지 따라가 편 뒤에 잰다 — 결함은 `busy`
 *      라는 글자가 아니라 접힘 변수 뒤에 숨어 있었다(#1558 · #1595 H1). 형제 쓰기로
 *      잠기는 것(`busy && !자기진행`)은 갈라내는 문법 그대로라 통과한다.
 *    · opacityFollowsLock — `aria-disabled={L}` 이 있으면 흐림은 **같은 식 L** 이 켠다
 *      (`cn(…, L && "opacity-50")`), 고정 클래스에는 흐림 계열이 없다. 흐림 없는 잠금은
 *      회색이 아닌 죽은 버튼이고, 늘 흐린 버튼은 잠기지 않았는데 잠긴 것처럼 읽힌다
 *      (#2923 · review-2909).
 *    · reasonBreakKeep — id 에 reason·note 가 든 `<p>`·`<span>` 은 한글 줄바꿈 규칙
 *      (`break-keep`)을 든다. 사유는 두세 어절이라 좁은 칸에서 어절 중간이 끊긴다(#1595 M6).
 *    · offlineQueuePromise — 「그대로 보내져요」 문장과 `networkMode`·`onlineManager`.
 *      이 클라이언트에는 오프라인 큐가 없으므로 사유 문장이 큐를 약속하면 거짓이다.
 *      큐가 생기는 날 이 검사가 먼저 붉어지고, 그때 문장을 되돌리는 것이 옳은 순서다(#1595 H4).
 *
 * 2. `momo/in-flight-lock-props` — `src/features/**` 전수. 새 소비처도 자동으로 이 규율
 *    아래 선다.
 *
 *    · `<SaveButton canSave={…진행 어휘…}>` — 진행이 prop 을 타고 잠금으로 되돌아온다(#1558).
 *    · `<ChoiceRadios disabled={…진행 어휘…}>` — `<fieldset disabled>` 는 초점을 쥔 라디오를
 *      끄고 초점을 <body> 로 떨어뜨린다(#1595 H3).
 *    범위는 옛 시험과 같게 식에 **직접** 적힌 낱말만 본다(별칭은 따라가지 않는다).
 *    별칭을 따라가면 지금 한 자리가 더 붉다(PR 본문 「후속」).
 *
 * 양성 fixture: `busyLockGrammar.test.ts` — 위 변조마다 소스 한 조각이 이 규칙으로 실제로
 * 빨간지 잰다.
 */

/** 진행을 말하는 낱말. 잠금 식에 맨몸으로 남으면 그 진행이 자기 잠금에 끼어든 것이다. */
const IN_FLIGHT =
  /\b(isPending|busy|rotating|revoking|saving|checking|uploading|creating|toggling|removing|clearing|unlinking|sending|loading)\b/;

/** `canSave` 에 접혀 들어오면 안 되는 진행 어휘(#1558). 대소문자 무시. */
const CAN_SAVE_IN_FLIGHT = /^(busy|isPending|isLoading|isFetching|saving)$/i;

/** 별칭을 따라가는 깊이. 옛 시험과 같다. */
const ALIAS_DEPTH = 4;

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

/** `const NAME = <식>;` 한 줄 별칭의 우변. 구조분해·let·함수 인자는 별칭이 아니다. */
function aliasInit(variable) {
  if (!variable || variable.defs.length !== 1) return null;
  const def = variable.defs[0];
  if (def.type !== "Variable" || def.parent.kind !== "const") return null;
  if (def.node.id.type !== "Identifier" || !def.node.init) return null;
  return ALIAS_INIT_TYPES.has(def.node.init.type) ? def.node.init : null;
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
    let text = sourceCode.getText(node);
    for (const [from, to, replacement] of replacements.sort((a, b) => b[0] - a[0])) {
      text = text.slice(0, from) + replacement + text.slice(to);
    }
    return text;
  }
  return (node) => expand(node, ALIAS_DEPTH);
}

/** 식 안의 모든 Identifier 이름(멤버 접근의 속성 이름 포함). */
function identifierNames(node, visitorKeys) {
  const names = [];
  walk(node, visitorKeys, (inner) => {
    if (inner.type === "Identifier") names.push(inner.name);
  });
  return names;
}

/**
 * 잠금 식을 불리언 식 트리로 접는다 — 별칭을 따라가며, 비교·호출·멤버 읽기는 한 알갱이(atom)다.
 * 알갱이의 열쇠는 공백·괄호를 걷은 원문이라 `create.isPending` 이 별칭 안팎에서 같은 알갱이가 된다.
 */
function toBoolTree(sourceCode, node, depth) {
  const atom = () => ({ op: "atom", key: flat(sourceCode.getText(node)) });
  switch (node.type) {
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return toBoolTree(sourceCode, node.expression, depth);
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

/** 진리표를 다 도는 알갱이 수의 상한. 넘으면 이 검사는 건너뛰고 어휘 검사(inFlightWithoutOwnNegation)만 남는다. */
const MAX_OTHER_ATOMS = 14;

/**
 * 자기 진행(own) 하나만 켜져도 잠금이 켜지는 맥락이 있는가.
 * 같은 맥락에서 own=꺼짐이면 꺼져 있고 own=켜짐이면 켜지는 환경이 하나라도 있으면 접힌 것이다.
 * `offline || (busy && !creating)` 는 busy 가 creating 을 품은 별칭이어도 그런 환경이 없다.
 */
function ownBusyFlipsLock(lockTree, ownKey) {
  const keys = [...atomKeys(lockTree)];
  if (!keys.includes(ownKey)) return false;
  const others = keys.filter((key) => key !== ownKey);
  if (others.length > MAX_OTHER_ATOMS) return false;
  for (let mask = 0; mask < 2 ** others.length; mask += 1) {
    const env = new Map(others.map((key, index) => [key, Boolean(mask & (1 << index))]));
    env.set(ownKey, false);
    const off = evalTree(lockTree, env);
    env.set(ownKey, true);
    if (!off && evalTree(lockTree, env)) return true;
  }
  return false;
}

/** `cn(…, L && "opacity-50")` 의 L 들과 고정 문자열 인자들. */
function opacityParts(classNameExpr) {
  const out = { conditions: [], fixed: [] };
  if (
    !classNameExpr ||
    classNameExpr.type !== "CallExpression" ||
    classNameExpr.callee.type !== "Identifier" ||
    classNameExpr.callee.name !== "cn"
  ) {
    return out;
  }
  for (const arg of classNameExpr.arguments) {
    if (
      arg.type === "LogicalExpression" &&
      arg.operator === "&&" &&
      arg.right.type === "Literal" &&
      arg.right.value === "opacity-50"
    ) {
      out.conditions.push(arg.left);
    } else if (arg.type === "Literal" && typeof arg.value === "string") {
      out.fixed.push(arg.value);
    }
  }
  return out;
}

/** 진행을 말하는 컨트롤이면 { busy, locks } 를, 아니면 null. */
function busyControl(opening) {
  const name = tagName(opening);
  if (name !== null && /^Button/.test(name)) {
    const busy = exprOf(attrOf(opening, "aria-busy"));
    if (!busy) return null;
    const locks = [];
    const disabled = exprOf(attrOf(opening, "aria-disabled"));
    if (disabled) locks.push(withoutUndefinedTail(disabled));
    // 흐림도 잠금이다. `cn(x && "opacity-50")` 의 x 가 그 식이다.
    locks.push(...opacityParts(exprOf(attrOf(opening, "className"))).conditions);
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
      opacityFollowsLock:
        "흐림(`cn(…, L && \"opacity-50\")`)의 조건이 aria-disabled 의 잠금 식과 같지 않다. 잠금과 흐림은 한 식에서 나온다 (#2923).",
      opacityFixed:
        "고정 클래스에 흐림 계열(opacity-*)이 있다. 잠기지 않은 버튼이 늘 흐려진다 (#2923 · review-2909).",
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
        const control = busyControl(node);
        if (control) {
          const own = flat(expand(control.busy));
          const negated = `!${own}`;
          const ownTree = toBoolTree(sourceCode, control.busy, ALIAS_DEPTH);
          const ownKey = ownTree.op === "atom" ? ownTree.key : null;
          for (const lock of control.locks) {
            const opened = flat(expand(lock));
            // (가) 옛 별칭 스캔: 진행 어휘가 남아 있으면 자기 진행의 부정이 함께 서 있어야 한다.
            const inFlightWithoutOwnNegation = IN_FLIGHT.test(opened) && !opened.includes(negated);
            // (나) 옛 ConfirmButton 검사를 의미로 올린 것: 자기 진행 하나만으로 잠금이 켜지는 맥락이 없다.
            const selfFolded =
              ownKey !== null && ownBusyFlipsLock(toBoolTree(sourceCode, lock, ALIAS_DEPTH), ownKey);
            if (selfFolded || inFlightWithoutOwnNegation) {
              context.report({
                node: lock,
                messageId: "selfLock",
                data: { busy: own, opened },
              });
            }
          }
        }

        // 3) 흐림은 aria-disabled 의 같은 식이 켠다
        if (name === "Button") {
          const ariaDisabled = exprOf(attrOf(node, "aria-disabled"));
          if (ariaDisabled) {
            const lock = flat(sourceCode.getText(withoutUndefinedTail(ariaDisabled)));
            const { conditions, fixed } = opacityParts(exprOf(attrOf(node, "className")));
            if (!conditions.some((condition) => flat(sourceCode.getText(condition)) === lock)) {
              context.report({ node: attrOf(node, "className") ?? node, messageId: "opacityFollowsLock" });
            }
            for (const classes of fixed) {
              if (classes.split(/\s+/).some((cls) => /(^|:)opacity-/.test(cls))) {
                context.report({ node: attrOf(node, "className") ?? node, messageId: "opacityFixed" });
              }
            }
          }
        }

        // 4) 사유·안내 노드는 한글 줄바꿈 규칙을 든다
        if (name === "p" || name === "span") {
          const idExpr = exprOf(attrOf(node, "id"));
          if (
            idExpr &&
            /reason|note/i.test(sourceCode.getText(idExpr)) &&
            !sourceCode.getText(node).includes("break-keep")
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
      choiceRadiosDisabled:
        "<ChoiceRadios disabled> 에 진행 어휘({{word}})가 있다. `<fieldset disabled>` 는 초점을 쥔 라디오를 끄고 초점을 <body> 로 떨어뜨린다. 진행은 ChoiceRadios 의 busy 로 말한다 (#1595 H3).",
    },
  },
  create(context) {
    const { visitorKeys } = context.sourceCode;
    return {
      JSXOpeningElement(node) {
        const name = tagName(node);
        if (name === "SaveButton") {
          const expr = exprOf(attrOf(node, "canSave"));
          const word = expr && identifierNames(expr, visitorKeys).find((id) => CAN_SAVE_IN_FLIGHT.test(id));
          if (word) context.report({ node: attrOf(node, "canSave"), messageId: "saveButtonCanSave", data: { word } });
        }
        if (name === "ChoiceRadios") {
          const expr = exprOf(attrOf(node, "disabled"));
          const word = expr && identifierNames(expr, visitorKeys).find((id) => IN_FLIGHT.test(id));
          if (word) context.report({ node: attrOf(node, "disabled"), messageId: "choiceRadiosDisabled", data: { word } });
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
  },
};
