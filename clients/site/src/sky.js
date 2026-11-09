// 첫 화면의 하늘 (#5562): WebGL1 프래그먼트 하나, 라이브러리 없음.
// 새벽(라이트)·밤(다크) 하늘에 기울어진 「오르트 구름」 껍질이 천천히 돌고, 작은 천체가 궤도를 따라 흐르고,
// 혜성 하나가 가끔 지나간다. 먼지는 거친 점묘(디더)로 그린다.
// 지키는 것: DPR 상한 1.5(크면 절반 해상도로 그리고 늘림) · 화면 밖·숨긴 탭에서 멈춤 ·
// prefers-reduced-motion 이면 한 장만 그림 · WebGL 이 없거나 잃으면 CSS 하늘(data-webgl="off").
(function () {
  "use strict";
  var hero = document.querySelector(".hero");
  var cv = hero && hero.querySelector("canvas.sky");
  if (!cv) return;
  function off() {
    hero.setAttribute("data-webgl", "off");
    hero.setAttribute("data-running", "0");
  }
  var gl = null;
  try {
    var o = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" };
    gl = cv.getContext("webgl", o) || cv.getContext("experimental-webgl", o);
  } catch (e) { gl = null; }
  if (!gl) { off(); return; }

  var VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "uniform vec2 R;uniform float T,S;uniform vec3 A,B,C,D,E;",
    "float h(vec2 p){p=fract(p*vec2(.1031,.103));p+=dot(p,p.yx+33.33);return fract((p.x+p.y)*p.x);}",
    "float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
    " return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}",
    "float fb(vec2 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*n(p);p=p*2.03+7.1;a*=.5;}return s;}",
    "mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}",
    "void main(){",
    " vec2 f=gl_FragCoord.xy,u=f/R,p=(f-.5*R)/R.y;float ar=R.x/R.y;",
    // 하늘: 위(A) → 가운데(B) → 지평선(C), 왼쪽 아래 지평선이 조금 더 밝다(해가 오기 전)
    " vec3 c=mix(C,B,smoothstep(0.,.55,u.y));c=mix(c,A,smoothstep(.42,1.,u.y));",
    " c=mix(c,C,.35*exp(-pow(length((p-vec2(-.35*ar,-.62))*vec2(.55,1.25)),2.)*2.2));",
    // 궤도면: 기울이고 눌러 본 타원 껍질
    " vec2 q=rot(.3)*(p-vec2(.06*ar,-.04));q.y*=2.5;",
    " float r=length(q);",
    " float sh=exp(-pow((r-.78)/.3,2.));",
    " vec2 qd=rot(T*.011)*q;",
    " float cl=fb(qd*2.6+vec2(0.,T*.004));",
    " float dn=sh*smoothstep(.36,.82,cl);",
    " dn+=.5*sh*pow(n(qd*vec2(9.,26.)),4.);",
    // 글자 자리는 비운다
    " float ve=smoothstep(.16,.62,length(p*vec2(.82,1.7)));",
    " dn*=mix(.08,1.,ve);",
    // 작은 천체: 극좌표 칸마다 점 하나, 안쪽이 더 빨리 돈다
    " float a=atan(q.y,q.x)+T*.06/(.3+r);",
    " float N=120.,M=34.;",
    " vec2 g=vec2(mod(a,6.2832)*N/6.2832,r*M),gi=floor(g),gf=fract(g);",
    " float rn=h(gi+11.);vec2 of=.2+.6*vec2(h(gi+3.7),h(gi+9.1));",
    " vec2 dd=(gf-of)*vec2(6.2832*r/N,1./M)*R.y/S;",
    " float st=step(.62,rn)*(1.-smoothstep(.5,1.7,length(dd)))*smoothstep(.02,.4,sh)*ve;",
    // 혜성: 26초마다 한 번, 12초 동안 왼쪽 위에서 오른쪽으로 호를 그린다
    " float ct=mod(T,26.)/12.;",
    " vec2 P0=vec2(-.75*ar,.46),P1=vec2(.72*ar,.02);",
    " vec2 hd=mix(P0,P1,ct)+vec2(0.,.16*sin(3.1416*ct));",
    " vec2 dv=normalize(P1-P0+vec2(0.,.5*cos(3.1416*ct)));",
    " vec2 d=p-hd;float al=dot(d,-dv),pe=dot(d,vec2(-dv.y,dv.x));",
    " float sg=.003+al*.1;",
    " float tl=step(0.,al)*exp(-al*4.2)*exp(-pe*pe/(sg*sg));",
    " float co=(tl*.85+exp(-dot(d,d)*26000.))*step(ct,1.)*smoothstep(0.,.06,ct)*(1.-smoothstep(.86,1.,ct));",
    // 점묘: 고정 그레인을 문턱으로 써서 먼지·꼬리를 거친 입자로
    " float gr=h(floor(f)+.5);",
    " dn=clamp(dn,0.,1.);",
    " c=mix(c,D,dn*.16+step(gr,dn*.85)*dn*.42);",
    " c=mix(c,D,st*.9);",
    " co=clamp(co,0.,1.);",
    " c=mix(c,E,co*(.3+.7*step(gr,co)));",
    " c+=(gr-.5)*.018;",
    " gl_FragColor=vec4(c,1.);",
    "}"
  ].join("\n");

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  var vs = compile(gl.VERTEX_SHADER, VS);
  var fs = compile(gl.FRAGMENT_SHADER, FS);
  var pr = vs && fs && gl.createProgram();
  if (pr) {
    gl.attachShader(pr, vs);
    gl.attachShader(pr, fs);
    gl.linkProgram(pr);
  }
  if (!pr || !gl.getProgramParameter(pr, gl.LINK_STATUS)) { off(); return; }
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ["R", "T", "S", "A", "B", "C", "D", "E"].forEach(function (k) { U[k] = gl.getUniformLocation(pr, k); });

  var css = getComputedStyle(document.documentElement);
  function rgb(name) {
    var m = /#([0-9a-f]{6})/i.exec(css.getPropertyValue(name));
    var x = m ? parseInt(m[1], 16) : 0;
    return [(x >> 16 & 255) / 255, (x >> 8 & 255) / 255, (x & 255) / 255];
  }
  function palette() {
    css = getComputedStyle(document.documentElement);
    gl.uniform3fv(U.A, rgb("--sky-top"));
    gl.uniform3fv(U.B, rgb("--sky-mid"));
    gl.uniform3fv(U.C, rgb("--sky-low"));
    gl.uniform3fv(U.D, rgb("--dust"));
    gl.uniform3fv(U.E, rgb("--comet"));
  }
  function size() {
    var box = cv.getBoundingClientRect();
    var scale = Math.min(window.devicePixelRatio || 1, 1.5);
    if (box.width * box.height * scale * scale > 1.3e6) scale *= 0.5;
    var w = Math.max(1, Math.round(box.width * scale));
    var h = Math.max(1, Math.round(box.height * scale));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(U.R, w, h);
    gl.uniform1f(U.S, scale);
  }

  // 움직이는 하늘은 혜성이 하늘 가운데쯤에 있는 순간(START)부터 돈다.
  // 움직임을 줄이면 STILL 한 장에서 멈춘다: 26초 주기 가운데 혜성이 없는 구간(ct > 1)이다(#5568).
  // 폰 폭에서는 글 덩어리가 하늘을 거의 다 차지해서, 혜성이 보이는 어느 순간이든 머리글·제목 아니면 머리 로고를 지난다.
  var START = 7.5, STILL = 20;
  var still = false, inView = true, shown = !document.hidden, raf = 0, last = 0;
  var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var dark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  still = !!(reduce && reduce.matches);
  var t = still ? STILL : START;

  function draw() {
    gl.uniform1f(U.T, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function running() { return inView && shown && !still; }
  function frame(now) {
    raf = 0;
    if (!running()) return;
    if (last === 0) last = now;
    var dt = now - last;
    if (dt >= 33) {
      t += Math.min(dt, 100) / 1000;
      last = now;
      draw();
    }
    raf = requestAnimationFrame(frame);
  }
  function sync() {
    var go = running();
    hero.setAttribute("data-running", go ? "1" : "0");
    if (go && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    if (!go && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  }

  size();
  palette();
  draw();
  hero.setAttribute("data-webgl", "on");

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es) { inView = es[es.length - 1].isIntersecting; sync(); }).observe(hero);
  }
  document.addEventListener("visibilitychange", function () { shown = !document.hidden; sync(); });
  listen(reduce, function () { still = reduce.matches; if (still) { t = STILL; draw(); } sync(); });
  listen(dark, function () { palette(); draw(); });
  var pending = 0;
  window.addEventListener("resize", function () {
    if (pending) return;
    pending = requestAnimationFrame(function () { pending = 0; size(); draw(); });
  });
  cv.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    off();
  });
  sync();
})();
