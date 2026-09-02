// =============================================================================
// 첫 페인트보다 먼저 스킴과 액센트를 못 박는다 (U2 + ADR-0174).
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
// 이 파일은 런타임 정본(src/design/theme.ts)의 **거울**이다. 저장 키와 스탬프
// 문법이 둘 사이에서 어긋나면 src/design/theme.test.ts가 이 파일을 읽어서 잡는다.
// =============================================================================
(function () {
  var KEY = "momo.web.appearance.v1";
  var LEGACY_KEY = "momo.web.theme.v1";
  var ATTR = "data-theme";
  var ACCENT_ATTR = "data-accent";
  // 시스템을 따를 때 브라우저 크롬이 쓰던 색. 고정을 풀 때 되돌릴 자리다.
  var SYSTEM_COLOR_ATTR = "data-theme-color-system";

  var scheme = "system";
  var accent = "dawn";
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.scheme === "light" || parsed.scheme === "dark" || parsed.scheme === "system") {
          scheme = parsed.scheme;
        }
        if (typeof parsed.accent === "string" && /^[a-z]+$/.test(parsed.accent)) {
          accent = parsed.accent;
        }
      }
    } else {
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy === "light" || legacy === "dark") scheme = legacy;
    }
  } catch (error) {
    // 프라이빗 모드 · 임베디드 웹뷰의 저장 금지, 또는 JSON이 아닌 값.
    // 읽을 선택이 없으면 시스템+새벽이고, 그것이 이 앱의 기본값이다.
  }

  document.documentElement.setAttribute(ACCENT_ATTR, accent);

  // "system"과 미지의 값은 같은 답을 받는다: 스킴 스탬프를 붙이지 않는 것.
  // tokens.css의 `:root { color-scheme: light dark }`가 그때 OS를 따른다.
  if (scheme !== "light" && scheme !== "dark") return;

  document.documentElement.setAttribute(ATTR, scheme);

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
