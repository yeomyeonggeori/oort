// oort 내려받기 페이지: 칩 고르기 · 펼침 메뉴 · 언어 기억 (#5562). 라이브러리 없음.
(function () {
  "use strict";
  var KEY = "oort.site.lang";

  // 칩: Chromium 이 알려 주는 architecture 만 믿는다. 모르면 Apple Silicon 그대로다.
  var get = document.querySelector("[data-get]");
  var main = get && get.querySelector(".get-main");
  var more = get && get.querySelector(".get-more");
  var menu = get && get.querySelector(".chip-menu");
  var items = menu ? menu.querySelectorAll("[role=menuitemradio]") : [];
  var label = get && get.querySelector("[data-chip-label]");

  function setChip(chip) {
    if (!get) return;
    get.setAttribute("data-chip", chip);
    main.setAttribute("href", main.getAttribute(chip === "x64" ? "data-x64" : "data-arm"));
    label.textContent = chip === "x64" ? "Intel" : "Apple Silicon";
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute("aria-checked", items[i].getAttribute("data-chip") === chip ? "true" : "false");
    }
  }

  try {
    var uad = navigator.userAgentData;
    if (get && uad && uad.getHighEntropyValues) {
      uad.getHighEntropyValues(["architecture"]).then(function (v) {
        if (v && v.architecture === "x86") setChip("x64");
        else if (v && v.architecture === "arm") setChip("arm");
      }, function () {});
    }
  } catch (e) { /* 칩을 모르면 기본값 그대로 */ }

  // 펼침 하나만 열린다. 바깥을 누르거나 Escape 면 닫힌다.
  var open = null;
  function close(focusBack) {
    if (!open) return;
    var o = open;
    open = null;
    o.panel.hidden = true;
    o.button.setAttribute("aria-expanded", "false");
    if (focusBack) o.button.focus();
  }
  function show(button, panel) {
    close(false);
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    open = { button: button, panel: panel };
  }
  document.addEventListener("click", function (e) {
    if (open && !open.panel.contains(e.target) && !open.button.contains(e.target)) close(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open) { e.preventDefault(); close(true); }
  });

  // 칩 메뉴: 화살표로 옮기고 Enter·Space 로 고른다(메뉴 버튼 패턴).
  function focusItem(i) {
    var n = items.length;
    items[((i % n) + n) % n].focus();
  }
  function checkedIndex() {
    for (var i = 0; i < items.length; i++) if (items[i].getAttribute("aria-checked") === "true") return i;
    return 0;
  }
  // 아래로 펼치면 앱 화면 틀(첫 화면보다 위에 그려진다)에 가릴 때는 위로 펼친다.
  function place() {
    menu.classList.remove("up");
    var frame = document.querySelector(".frame");
    if (frame && menu.getBoundingClientRect().bottom > frame.getBoundingClientRect().top - 8) menu.classList.add("up");
  }
  if (more && menu) {
    more.addEventListener("click", function () {
      if (open && open.panel === menu) close(false);
      else { show(more, menu); place(); focusItem(checkedIndex()); }
    });
    more.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show(more, menu);
        place();
        focusItem(e.key === "ArrowUp" ? items.length - 1 : checkedIndex());
      }
    });
    menu.addEventListener("keydown", function (e) {
      var at = Array.prototype.indexOf.call(items, document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); focusItem(at + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(at - 1); }
      else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
      else if (e.key === "End") { e.preventDefault(); focusItem(items.length - 1); }
      else if (e.key === "Tab") { close(false); }
    });
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function (e) {
        setChip(e.currentTarget.getAttribute("data-chip"));
        close(false);
        main.focus();
      });
    }
  }

  // 언어 메뉴: 링크 목록을 펼친다. 고른 언어는 기억한다(저장소가 막혀도 링크는 그대로 간다).
  var pops = document.querySelectorAll("[data-pop]");
  for (var k = 0; k < pops.length; k++) {
    (function (pop) {
      var button = pop.querySelector("button");
      var panel = pop.querySelector(".menu");
      button.addEventListener("click", function () {
        if (open && open.panel === panel) close(false);
        else show(button, panel);
      });
    })(pops[k]);
  }
  var langLinks = document.querySelectorAll("a[data-lang]");
  for (var m = 0; m < langLinks.length; m++) {
    langLinks[m].addEventListener("click", function (e) {
      try { localStorage.setItem(KEY, e.currentTarget.getAttribute("data-lang")); } catch (err) { /* 기억 못 해도 이동은 한다 */ }
    });
  }
})();
