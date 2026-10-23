"use strict";
// 画像の上に線を重ねる。線は画像の座標で持ち、画面へは view で写す：画面 = 画像 × scale + (x, y)。
// ペン（S Pen・マウス）で書き、指は1本で動かし2本で拡大する。

const $ = (id) => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");

const BACKGROUND = "#202124";
const MARKER_ALPHA = 0.4;
const MARKER_RATIO = 3;
const ERASER_RADIUS = 12;
const SETTINGS_KEY = "rakugaki-settings";
const TOOL_ICONS = { pen: "✒️", marker: "🖍️", eraser: "🧽" };

const settings = { tool: "pen", color: "#e53935", width: 4 };
const view = { scale: 1, x: 0, y: 0 };
let image = null;
let strokes = [];
let actions = [];

// ---- 描画

let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!image) return;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0);
    for (const stroke of strokes) drawStroke(ctx, stroke);
  });
}

const pressureFactor = (p) => 0.4 + 1.2 * p;

function drawStroke(g, stroke) {
  const pts = stroke.points;
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = stroke.color;
  g.fillStyle = stroke.color;
  if (stroke.tool === "marker") {
    g.globalAlpha = MARKER_ALPHA;
    g.lineWidth = stroke.width;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) g.lineTo(p.x, p.y);
    g.stroke();
  } else if (pts.length === 1) {
    g.beginPath();
    g.arc(pts[0].x, pts[0].y, (stroke.width * pressureFactor(pts[0].p)) / 2, 0, Math.PI * 2);
    g.fill();
  } else {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      g.lineWidth = stroke.width * pressureFactor((a.p + b.p) / 2);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }
  g.restore();
}

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  render();
}

// ---- 表示の位置と倍率

const fitScale = () => Math.min(innerWidth / image.width, innerHeight / image.height);
const clampScale = (s) => Math.min(Math.max(s, fitScale() * 0.5), Math.max(8, fitScale() * 2));

function fit() {
  view.scale = fitScale();
  view.x = (innerWidth - image.width * view.scale) / 2;
  view.y = (innerHeight - image.height * view.scale) / 2;
  render();
}

// 画面の (cx, cy) の下にある画像の点を動かさずに倍率を変える
function zoomAt(cx, cy, scale) {
  const ix = (cx - view.x) / view.scale;
  const iy = (cy - view.y) / view.scale;
  view.scale = clampScale(scale);
  view.x = cx - ix * view.scale;
  view.y = cy - iy * view.scale;
  render();
}

// ---- 指：1本で動かし、2本で拡大

const fingers = new Map();
let gesture = null;

function centroid() {
  let x = 0;
  let y = 0;
  for (const f of fingers.values()) {
    x += f.x;
    y += f.y;
  }
  return { x: x / fingers.size, y: y / fingers.size };
}

function spread() {
  if (fingers.size < 2) return 0;
  const [a, b] = fingers.values();
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const baseline = () => ({ c: centroid(), d: spread(), scale: view.scale, x: view.x, y: view.y });

function applyGesture() {
  const g = gesture;
  const c = centroid();
  const d = spread();
  const scale = g.d > 0 && d > 0 ? clampScale((g.scale * d) / g.d) : g.scale;
  const ix = (g.c.x - g.x) / g.scale;
  const iy = (g.c.y - g.y) / g.scale;
  view.scale = scale;
  view.x = c.x - ix * scale;
  view.y = c.y - iy * scale;
  render();
}

// ---- ペン：書く・消す

let drawing = null;

const isPen = (e) => e.pointerType === "pen" || e.pointerType === "mouse";
// S Pen のボタン・消しゴム側・マウスの右ボタンは、その間だけ消しゴムにする
const wantsEraser = (e) => (e.buttons & (2 | 32)) !== 0;

function toImage(e) {
  return {
    x: (e.clientX - view.x) / view.scale,
    y: (e.clientY - view.y) / view.scale,
    p: e.pressure > 0 ? e.pressure : 0.5,
  };
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function touches(stroke, p, radius) {
  const pts = stroke.points;
  const reach = radius + stroke.width / 2;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distanceToSegment(p, pts[i - 1], pts[i]) <= reach) return true;
  }
  return false;
}

function eraseAt(p, removed) {
  const radius = ERASER_RADIUS / view.scale;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (touches(strokes[i], p, radius)) {
      removed.push({ stroke: strokes[i], index: i });
      strokes.splice(i, 1);
    }
  }
}

// 速くなぞっても間の線を取りこぼさないよう、前の点からの道のりを消しゴムの半径ごとに刻む
function eraseAlong(from, to, removed) {
  const step = ERASER_RADIUS / view.scale / 2;
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
  for (let i = 1; i <= n; i++) {
    eraseAt({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }, removed);
  }
}

function strokeWidth(tool) {
  return (tool === "marker" ? settings.width * MARKER_RATIO : settings.width) / view.scale;
}

function undo() {
  const last = actions.pop();
  if (!last) return;
  if (last.type === "add") strokes.splice(strokes.lastIndexOf(last.stroke), 1);
  else for (const { stroke, index } of [...last.removed].reverse()) strokes.splice(index, 0, stroke);
  render();
  updateButtons();
}

// ---- 入力

canvas.addEventListener("pointerdown", (e) => {
  if (!image) return;
  closePanel();
  if (isPen(e)) {
    if (drawing) return;
    canvas.setPointerCapture(e.pointerId);
    fingers.clear();
    gesture = null;
    const tool = wantsEraser(e) ? "eraser" : settings.tool;
    if (tool === "eraser") {
      drawing = { id: e.pointerId, removed: [], last: toImage(e) };
      eraseAt(drawing.last, drawing.removed);
    } else {
      const stroke = { tool, color: settings.color, width: strokeWidth(tool), points: [toImage(e)] };
      strokes.push(stroke);
      drawing = { id: e.pointerId, stroke };
    }
    render();
    return;
  }
  // 書いている間に触れた手のひらは無視する
  if (drawing) return;
  canvas.setPointerCapture(e.pointerId);
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = baseline();
});

canvas.addEventListener("pointermove", (e) => {
  if (drawing && e.pointerId === drawing.id) {
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      const p = toImage(ev);
      if (drawing.stroke) {
        drawing.stroke.points.push(p);
      } else {
        eraseAlong(drawing.last, p, drawing.removed);
        drawing.last = p;
      }
    }
    render();
    return;
  }
  if (!fingers.has(e.pointerId)) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  applyGesture();
});

function release(e) {
  if (drawing && e.pointerId === drawing.id) {
    if (drawing.stroke) actions.push({ type: "add", stroke: drawing.stroke });
    else if (drawing.removed.length) actions.push({ type: "erase", removed: drawing.removed });
    drawing = null;
    updateButtons();
    return;
  }
  if (fingers.delete(e.pointerId)) gesture = fingers.size ? baseline() : null;
}
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("wheel", (e) => {
  if (!image) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.002));
}, { passive: false });

// ---- 画像の出し入れ

async function loadImage(blob) {
  try {
    image = await createImageBitmap(blob);
  } catch {
    alert("画像として読めませんでした");
    return;
  }
  strokes = [];
  actions = [];
  $("empty").hidden = true;
  updateMode();
  fit();
  updateButtons();
}

async function takeShared() {
  if (location.search !== "?shared") return;
  history.replaceState(null, "", location.pathname);
  const cache = await caches.open("rakugaki-shared");
  const response = await cache.match("shared");
  if (!response) return;
  await cache.delete("shared");
  await loadImage(await response.blob());
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exportFile() {
  const out = document.createElement("canvas");
  out.width = image.width;
  out.height = image.height;
  const g = out.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(image, 0, 0);
  for (const stroke of strokes) drawStroke(g, stroke);
  const blob = await new Promise((resolve) => out.toBlob(resolve, "image/jpeg", 0.92));
  return new File([blob], `rakugaki-${stamp()}.jpg`, { type: "image/jpeg" });
}

async function send() {
  const file = await exportFile();
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== "AbortError") alert(`送れませんでした：${err.message}`);
    }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---- ペンの設定とボタン

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
  } catch {
    // 保存先が使えないときは既定のまま使う
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても、開いている間は効く
  }
}

function syncSettings() {
  for (const b of document.querySelectorAll("#tools button")) b.setAttribute("aria-pressed", b.dataset.tool === settings.tool);
  for (const b of document.querySelectorAll("#colors button")) {
    b.style.background = b.dataset.color;
    b.setAttribute("aria-pressed", b.dataset.color === settings.color);
  }
  for (const b of document.querySelectorAll("#widths button")) {
    const size = Number(b.dataset.width) + 2;
    Object.assign(b.firstElementChild.style, { width: `${size}px`, height: `${size}px`, background: settings.color });
    b.setAttribute("aria-pressed", Number(b.dataset.width) === settings.width);
  }
  $("pen-tool").textContent = TOOL_ICONS[settings.tool];
  $("pen-dot").style.background = settings.color;
}

function choose(selector, apply) {
  for (const b of document.querySelectorAll(selector)) {
    b.addEventListener("click", () => {
      apply(b.dataset);
      saveSettings();
      syncSettings();
    });
  }
}
choose("#tools button", (d) => (settings.tool = d.tool));
choose("#colors button", (d) => (settings.color = d.color));
choose("#widths button", (d) => (settings.width = Number(d.width)));

const closePanel = () => ($("panel").hidden = true);
$("pen").addEventListener("click", () => ($("panel").hidden = !$("panel").hidden));

function updateButtons() {
  $("undo").disabled = actions.length === 0;
  $("fit").disabled = !image;
  $("share").disabled = !image;
}

// ---- インストール：まだ入れていないブラウザで開いたら、入れるボタンだけを出す
// 入れられないブラウザ（iPhone など）や、断られた後は、ブラウザのまま使えるよう普段の画面にする

let installPrompt = null;
const updateMode = () => document.body.classList.toggle("install-only", Boolean(installPrompt) && !image);

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  updateMode();
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  updateMode();
});
$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  updateMode();
});

$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (file) loadImage(file);
});
$("undo").addEventListener("click", undo);
$("fit").addEventListener("click", fit);
$("share").addEventListener("click", send);
addEventListener("resize", resize);

loadSettings();
syncSettings();
resize();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
takeShared();
