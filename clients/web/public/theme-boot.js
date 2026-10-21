// =============================================================================
// 첫 페인트보다 먼저 외양을 못 박는다 (U2 + ADR-0174 + ADR-0189 증보 3, AP-1a #4186).
//
// 이 파일이 번들 안이 아니라 public/의 **고전 스크립트**인 이유는 순서 하나다.
// 앱 진입점은 `type="module"`이고 모듈 스크립트는 언제나 defer이므로, 그것이
// 실행될 때 문서는 이미 한 번 그려졌을 수 있다. 저장된 선택이 다크인데 이 기기의
// OS가 라이트면 그 프레임에서 밝은 종이가 한 번 번쩍이고 나서 밤이 된다. defer가
// 아닌 스크립트는 파서를 세우고 자기 차례에 실행되므로, 스탬프가 스타일시트보다
// 먼저 문서에 붙는다.
//
// 인라인 <script>로 적을 수 없다: 배포 CSP(infra/prod/Caddyfile)도 Tauri CSP도
// script-src 'self'이고 'unsafe-inline'이 없다. 같은 오리진의 파일 하나는 두 정책
// 모두가 허용하는 유일한 형태다.
//
// 이 파일은 런타임 정본의 **거울**이다. 읽는 순서(v2 → v1 → 옛 스킴 키)와 값 정리는 core
// `appearance.ts`, 무엇을 어느 속성에 찍는지는 core `rootStamp.ts`의 표, 캐시 문법은 core
// `themeCache.ts`를 그대로 옮겼다. 어긋나면 src/design/theme.test.ts가 이 파일을 **실제로
// 실행해서** 같은 입력 표로 런타임과 비교해 잡는다.
//
// 찍는 속성(`data-glass`는 일부러 없다: 켜는 것은 네이티브 효과가 선 뒤의 AP-3다)
//   data-theme · data-palette · data-theme-ref · data-signal · data-accent(옛) · data-density ·
//   data-font-size · data-thread-layout · data-prominent-active · data-wallpaper
//
// 부트 캐시(momo.web.theme.cache.v1)가 있고 키가 지금 레코드의 테마·신호와 맞으면 파생 변수를
// 첫 렌더 전에 setProperty로 되꽂는다. 없거나 계약을 어기면 아무것도 하지 않는다(기본 테마).
// =============================================================================
(function () {
  var V2_ENTRY = "momo.web.appearance.v2";
  var V1_ENTRY = "momo.web.appearance.v1";
  var LEGACY_ENTRY = "momo.web.theme.v1";
  var CACHE_ENTRY = "momo.web.theme.cache.v1";

  var ATTR = "data-theme";
  var PALETTE_ATTR = "data-palette";
  var REF_ATTR = "data-theme-ref";
  var SIGNAL_ATTR = "data-signal";
  var ACCENT_ATTR = "data-accent";
  var DENSITY_ATTR = "data-density";
  var FONT_SIZE_ATTR = "data-font-size";
  var THREAD_LAYOUT_ATTR = "data-thread-layout";
  var PROMINENT_ATTR = "data-prominent-active";
  var WALLPAPER_ATTR = "data-wallpaper";
  // 시스템을 따를 때 브라우저 크롬이 쓰던 색. 고정을 풀 때 되돌릴 자리다.
  var SYSTEM_COLOR_ATTR = "data-theme-color-system";

  // 목록은 core의 거울이다: THEME_IDS · SIGNAL_PRESET_IDS · DENSITY_IDS · FONT_SIZE_IDS ·
  // THREAD_LAYOUT_IDS · WALLPAPER_KINDS. 목록에 값이 늘면 여기도 늘려야 하고, theme.test.ts가
  // core 목록의 모든 id를 이 파일에 먹여 보고 빠진 것을 잡는다.
  var THEME_IDS = ["dawnsky", "graphite", "noeul"];
  var DEFAULT_THEME = "dawnsky";
  var DERIVED_PALETTE = "derived";
  var SIGNAL_PRESETS = ["seongun", "hongyeom", "hyeseong", "gamram"];
  var DENSITIES = ["comfortable", "compact"];
  var FONT_SIZES = ["smaller", "default", "larger"];
  var THREAD_LAYOUTS = ["split", "focus"];
  var WALLPAPER_KINDS = ["solid", "preset", "image"];
  var REF_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var REF_ID_MAX = 40;
  var WALLPAPER_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var WALLPAPER_ID_MAX = 32;
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;

  // 사용자 글꼴 (#3774). 이름 허용 목록·상한·변수 이름은 core fontName.ts · src/design/userFont.ts의 거울이다.
  var FONT_NAME_PATTERN = "^[\\p{L}\\p{M}\\p{N} ._+&-]+$";
  var FONT_NAME_MAX = 64;
  var FONT_SANS_VAR = "--font-user-sans";
  var FONT_MONO_VAR = "--font-user-mono";
  var FONT_SANS_ATTR = "data-font-sans";
  var FONT_MONO_ATTR = "data-font-mono";

  // 부트 캐시 문법: core themeCache.ts의 거울(색 하나 또는 light-dark(색, 색)만 값이 된다).
  var CACHE_MAX_BYTES = 12288;
  var CACHE_MAX_VARS = 64;
  var CACHE_MAX_KEY = 160;
  var CACHE_NAME_RE = new RegExp("^--[a-z][a-z0-9-]{0,47}$");
  var CACHE_KEY_RE = new RegExp("^[A-Za-z0-9.:#|_-]+$");
  var CACHE_COLOR =
    "(?:#[0-9a-fA-F]{3,8}|rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*(?:0|1|0?\\.\\d{1,3}|1\\.0{1,3})\\s*)?\\))";
  var CACHE_VALUE_RE = new RegExp(
    "^(?:" + CACHE_COLOR + "|light-dark\\(\\s*" + CACHE_COLOR + "\\s*,\\s*" + CACHE_COLOR + "\\s*\\))$"
  );

  function fontName(value) {
    if (typeof value !== "string") return null;
    var name = value.replace(/\s+/g, " ").trim();
    if (name === "" || name.length > FONT_NAME_MAX) return null;
    try {
      return new RegExp(FONT_NAME_PATTERN, "u").test(name) ? name : null;
    } catch (error) {
      return null;
    }
  }

  function parseObject(raw) {
    if (typeof raw !== "string" || raw === "") return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function oneOf(list, value, fallback) {
    return typeof value === "string" && list.indexOf(value) >= 0 ? value : fallback;
  }

  function schemeOf(value) {
    return oneOf(["light", "dark", "system"], value, "system");
  }

  function themeRefOf(value) {
    if (typeof value !== "string") return DEFAULT_THEME;
    if (THEME_IDS.indexOf(value) >= 0) return value;
    var colon = value.indexOf(":");
    if (colon > 0) {
      var namespace = value.slice(0, colon);
      var id = value.slice(colon + 1);
      if (
        (namespace === "catalog" || namespace === "user") &&
        id.length > 0 &&
        id.length <= REF_ID_MAX &&
        REF_ID_RE.test(id)
      ) {
        return value;
      }
    }
    return DEFAULT_THEME;
  }

  // {kind: "none"} | {kind: "preset", id} | {kind: "custom", id: "#RRGGBB"} — 부트는 스탬프와 캐시 키에 필요한 것만 든다.
  function signalOf(value) {
    if (value !== null && typeof value === "object") {
      if (typeof value.preset === "string" && SIGNAL_PRESETS.indexOf(value.preset) >= 0) {
        return { stamp: value.preset, accent: value.preset, key: value.preset };
      }
      if (typeof value.custom === "string" && HEX_RE.test(value.custom.trim())) {
        return { stamp: "custom", accent: "dawn", key: value.custom.trim().toUpperCase() };
      }
    }
    return { stamp: null, accent: "dawn", key: "-" };
  }

  function wallpaperOf(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    var kind = typeof value.kind === "string" && WALLPAPER_KINDS.indexOf(value.kind) >= 0 ? value.kind : null;
    if (kind === null) return null;
    if (kind === "image") return kind;
    var id = value.id;
    return typeof id === "string" && id.length > 0 && id.length <= WALLPAPER_ID_MAX && WALLPAPER_ID_RE.test(id)
      ? kind
      : null;
  }

  function defaults() {
    return {
      scheme: "system",
      theme: DEFAULT_THEME,
      signal: signalOf(null),
      density: DENSITIES[0],
      fontSize: "default",
      threadLayout: "split",
      prominentActive: false,
      wallpaper: null,
      fontSans: null,
      fontMono: null,
    };
  }

  function fromV2(record) {
    var state = defaults();
    state.scheme = schemeOf(record.scheme);
    state.theme = themeRefOf(record.theme);
    state.signal = signalOf(record.signal);
    state.density = oneOf(DENSITIES, record.density, DENSITIES[0]);
    state.fontSize = oneOf(FONT_SIZES, record.fontSize, "default");
    state.threadLayout = oneOf(THREAD_LAYOUTS, record.threadLayout, "split");
    state.prominentActive = record.prominentActive === true;
    state.wallpaper = wallpaperOf(record.wallpaper);
    state.fontSans = fontName(record.fontSans);
    state.fontMono = fontName(record.fontMono);
    return state;
  }

  // v1 `{scheme, accent, fontSans, fontMono}`: 액센트 id의 문자 집합 핀(ACCENT_ID_CHAR_CLASS)을 먼저 통과한다.
  function fromV1(record) {
    var state = defaults();
    state.scheme = schemeOf(record.scheme);
    var accent = typeof record.accent === "string" && /^[a-z]+$/.test(record.accent) ? record.accent : null;
    state.signal = signalOf(accent !== null && SIGNAL_PRESETS.indexOf(accent) >= 0 ? { preset: accent } : null);
    state.density = oneOf(DENSITIES, record.density, DENSITIES[0]);
    state.fontSans = fontName(record.fontSans);
    state.fontMono = fontName(record.fontMono);
    return state;
  }

  // 읽는 순서: v2 → v1 → 옛 스킴 키(스킴만). 세 항목을 모두 읽은 뒤에 판정한다(저장소가 막혔으면 전부 기본).
  var state = defaults();
  try {
    var rawV2 = localStorage.getItem(V2_ENTRY);
    var rawV1 = localStorage.getItem(V1_ENTRY);
    var rawLegacy = localStorage.getItem(LEGACY_ENTRY);
    var recordV2 = parseObject(rawV2);
    if (recordV2 !== null && recordV2.v === 2) {
      state = fromV2(recordV2);
    } else {
      var recordV1 = parseObject(rawV1);
      if (recordV1 !== null) {
        state = fromV1(recordV1);
      } else if (typeof rawLegacy === "string" && rawLegacy !== "") {
        state.scheme = schemeOf(rawLegacy);
      }
    }
  } catch (error) {
    // 프라이빗 모드 · 임베디드 웹뷰의 저장 금지. 읽을 선택이 없으면 시스템+새벽이고,
    // 그것이 이 앱의 기본값이다.
    state = defaults();
  }

  var root = document.documentElement;

  // ---- 부트 캐시: 키가 지금 레코드와 맞고 계약을 전부 지킬 때만 ----------------------
  function cacheMatches(key) {
    var first = key.indexOf("|");
    if (first <= 0) return false;
    var rest = key.slice(first + 1);
    var look = state.theme + "|" + state.signal.key;
    return rest === look || rest.indexOf(look + "|") === 0;
  }

  // 단일 모드 테마의 캐시는 그 모드를 함께 들고 있다(core themeResolve.effectiveScheme과 같은 규칙).
  var cachedMode = null;
  try {
    var rawCache = localStorage.getItem(CACHE_ENTRY);
    var cache = parseObject(typeof rawCache === "string" && rawCache.length <= CACHE_MAX_BYTES ? rawCache : null);
    if (
      cache !== null &&
      typeof cache.key === "string" &&
      cache.key.length > 0 &&
      cache.key.length <= CACHE_MAX_KEY &&
      CACHE_KEY_RE.test(cache.key) &&
      cache.vars !== null &&
      typeof cache.vars === "object" &&
      !Array.isArray(cache.vars) &&
      (cache.mode === undefined || cache.mode === "light" || cache.mode === "dark")
    ) {
      var names = Object.keys(cache.vars);
      var sound = names.length > 0 && names.length <= CACHE_MAX_VARS;
      for (var n = 0; sound && n < names.length; n++) {
        var value = cache.vars[names[n]];
        sound = CACHE_NAME_RE.test(names[n]) && typeof value === "string" && CACHE_VALUE_RE.test(value);
      }
      // 하나라도 계약을 어기면 일부만 꽂지 않고 통째로 버린다.
      if (sound && cacheMatches(cache.key)) {
        for (var m = 0; m < names.length; m++) {
          // 값은 위 문법(색 또는 light-dark 쌍)을 통과한 것뿐이고, 인라인 style 속성이 아니라 CSSOM 변수다.
          root.style.setProperty(names[m], cache.vars[names[m]]);
        }
        cachedMode = cache.mode === undefined ? null : cache.mode;
      }
    }
  } catch (error) {
    // 캐시가 없거나 읽을 수 없으면 기본 테마로 선다.
  }

  // ---- 스탬프 표: core rootStamp.ts의 거울. 값 null은 속성을 지운다 -------------------
  function stamp(name, value) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }

  var themeIsFirstParty = THEME_IDS.indexOf(state.theme) >= 0;
  stamp(PALETTE_ATTR, themeIsFirstParty ? state.theme : DERIVED_PALETTE);
  stamp(REF_ATTR, state.theme);
  stamp(SIGNAL_ATTR, state.signal.stamp);
  stamp(ACCENT_ATTR, state.signal.accent);
  stamp(DENSITY_ATTR, state.density);
  stamp(FONT_SIZE_ATTR, state.fontSize);
  stamp(THREAD_LAYOUT_ATTR, state.threadLayout);
  stamp(PROMINENT_ATTR, state.prominentActive ? "" : null);
  stamp(WALLPAPER_ATTR, state.wallpaper);

  // 값은 허용 목록을 통과한 이름과 var() 폴백뿐이고, 인라인 style 속성이 아니라 CSSOM 변수다.
  if (state.fontSans) {
    root.style.setProperty(FONT_SANS_VAR, '"' + state.fontSans + '", var(--font-sans)');
    root.setAttribute(FONT_SANS_ATTR, "");
  }
  if (state.fontMono) {
    root.style.setProperty(FONT_MONO_VAR, '"' + state.fontMono + '", var(--font-mono)');
    root.setAttribute(FONT_MONO_ATTR, "");
  }

  // 유효 스킴: 단일 모드 테마는 그 모드, 아니면 고른 스킴. "system"과 미지의 값은 같은 답을
  // 받는다: 스킴 스탬프를 붙이지 않는 것. tokens.css의 `:root { color-scheme: light dark }`가
  // 그때 OS를 따른다.
  var scheme = cachedMode !== null ? cachedMode : state.scheme;
  if (scheme !== "light" && scheme !== "dark") return;

  root.setAttribute(ATTR, scheme);

  // 주소창·상태바도 같이 못 박는다. index.html의 theme-color 두 줄은
  // prefers-color-scheme으로 갈리므로, 앱만 고정하면 다크 앱 위에 라이트 주소창이
  // 남는다(홈 화면 앱에서 특히 크게 보인다). 색을 여기 다시 적지 않고 **고른 쪽
  // 줄의 값을 두 줄 모두에 복사**한다: 팔레트는 계속 index.html 한 곳에만 있다.
  var metas = document.querySelectorAll("meta[name='theme-color'][media]");
  var pinned = null;
  var i;
  for (i = 0; i < metas.length; i++) {
    if ((metas[i].getAttribute("media") || "").indexOf(scheme) >= 0) {
      pinned = metas[i].getAttribute("content");
    }
  }
  if (!pinned) return;
  for (i = 0; i < metas.length; i++) {
    if (!metas[i].hasAttribute(SYSTEM_COLOR_ATTR)) {
      metas[i].setAttribute(SYSTEM_COLOR_ATTR, metas[i].getAttribute("content"));
    }
    metas[i].setAttribute("content", pinned);
  }
})();
