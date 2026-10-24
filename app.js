"use strict";
// 画像の上に、書いたもの（線・白で埋めた四角・貼った画像）を順に重ねる。書いたものは画像の座標で持ち、
// 画面へは view で写す：画面 = 画像 × scale + (x, y)。
// ペン（S Pen・マウス）で書き、指は1本で動かし2本で拡大する。

const $ = (id) => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");

const BACKGROUND = "#202124";
const MARKER_ALPHA = 0.4;
const MARKER_RATIO = 3;
const ERASER_RADIUS = 12;
const SETTINGS_KEY = "rakugaki-settings";
const TOOL_ICONS = { pen: "✒️", marker: "🖍️" };
// 貼る途中の画像の角をつかめる範囲（画面の px）と、貼った画像が最初に占める見えている範囲の割合の上限
const GRIP_RADIUS = 24;
const PASTE_SHARE = 0.6;
// これより小さく選んだ範囲は、選び損ねとみて捨てる（画面の px）
const SELECT_MIN = 8;

const settings = { tool: "pen", color: "#e53935", width: 4 };
// ペンで何をするか：書く（draw）・消す（erase）・範囲を選ぶ（select）。
// そのとき限りにして残さない。開き直したときに書けないと戸惑うので
let mode = "draw";
const view = { scale: 1, x: 0, y: 0 };
let image = null;
// 書いたものを重ねる順に持つ。線はペンの点の並び、kind が "fill" は白で埋めた四角、"paste" は貼った画像
let items = [];
let actions = [];
// 選んだ範囲と、貼る途中の画像（決めるまで書いたものに入れない）。どちらも画像の座標の四角を持つ
let selection = null;
let placing = null;

// ---- 描画

// 書き終えた線は、画像に重ねる透明な層 ink へ焼いておき、1コマごとには画像・ink・書いている線だけを描く。
// 毎コマ全部の線を描き直すと、書くほど1コマが重くなり、たくさん書いたあとにアプリが落ちる。
// ink は画面に見せるための写しで、送る画像は線から描き直すので、大きな写真では画素を減らしてメモリを抑える。
const INK_MAX_PIXELS = 12e6;
const ink = document.createElement("canvas");
const inkCtx = ink.getContext("2d");
let inkStale = false;

function resetInk() {
  const k = Math.min(1, Math.sqrt(INK_MAX_PIXELS / (image.width * image.height)));
  ink.width = Math.max(1, Math.round(image.width * k));
  ink.height = Math.max(1, Math.round(image.height * k));
  inkCtx.setTransform(ink.width / image.width, 0, 0, ink.height / image.height, 0, 0);
  inkStale = true;
}

function bakeInk() {
  inkCtx.clearRect(0, 0, image.width, image.height);
  for (const item of items) drawItem(inkCtx, item);
  inkStale = false;
}

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
    if (inkStale) bakeInk();
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0);
    ctx.drawImage(ink, 0, 0, image.width, image.height);
    if (drawing?.stroke) drawStroke(ctx, drawing.stroke);
    if (placing) {
      ctx.drawImage(placing.bitmap, placing.x, placing.y, placing.w, placing.h);
      outline(placing);
      for (const [x, y] of corners(placing)) handle(x, y);
    }
    if (selection) outline(selection);
  });
}

// 四角の縁を、どんな背景でも見えるよう白の上に青の破線で描く。太さは画面の px で揃える
function outline(r) {
  const unit = 1 / view.scale;
  ctx.save();
  ctx.lineWidth = 2 * unit;
  ctx.strokeStyle = "#ffffff";
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([6 * unit, 6 * unit]);
  ctx.strokeStyle = "#1e63d6";
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function handle(x, y) {
  const unit = 1 / view.scale;
  ctx.save();
  ctx.fillStyle = "#1e63d6";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2 * unit;
  ctx.beginPath();
  ctx.arc(x, y, 9 * unit, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// 左上・右上・左下・右下。向かいの角は 3 - i
const corners = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];

function drawItem(g, item) {
  if (item.kind === "fill") {
    g.fillStyle = "#ffffff";
    g.fillRect(item.x, item.y, item.w, item.h);
  } else if (item.kind === "paste") {
    g.drawImage(item.bitmap, item.x, item.y, item.w, item.h);
  } else {
    drawStroke(g, item);
  }
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

function boxOf(points) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of points) {
    box.x0 = Math.min(box.x0, p.x);
    box.y0 = Math.min(box.y0, p.y);
    box.x1 = Math.max(box.x1, p.x);
    box.y1 = Math.max(box.y1, p.y);
  }
  return box;
}

// 消しゴムは線だけを消し、白で埋めた四角と貼った画像は残す
function touches(stroke, p, radius) {
  if (stroke.kind) return false;
  const pts = stroke.points;
  const reach = radius + stroke.width / 2;
  // 囲む四角の外なら、点を1つずつ調べずに済ませる（線が増えても消しゴムが重くならないように）
  const b = stroke.box;
  if (p.x < b.x0 - reach || p.x > b.x1 + reach || p.y < b.y0 - reach || p.y > b.y1 + reach) return false;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distanceToSegment(p, pts[i - 1], pts[i]) <= reach) return true;
  }
  return false;
}

function eraseAt(p, removed) {
  const radius = ERASER_RADIUS / view.scale;
  for (let i = items.length - 1; i >= 0; i--) {
    if (touches(items[i], p, radius)) {
      removed.push({ item: items[i], index: i });
      items.splice(i, 1);
      inkStale = true;
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

function add(item) {
  items.push(item);
  drawItem(inkCtx, item);
  actions.push({ type: "add", item });
  render();
  changed();
  updateButtons();
}

function undo() {
  const last = actions.pop();
  if (!last) return;
  if (last.type === "add") items.splice(items.lastIndexOf(last.item), 1);
  else if (last.type === "clear") items = last.before;
  else for (const { item, index } of [...last.removed].reverse()) items.splice(index, 0, item);
  inkStale = true;
  render();
  changed();
  updateButtons();
}

// ---- 範囲を選んでコピー・切り取り、クリップボードの画像を貼る、白紙にする

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function between(a, b) {
  const x0 = clamp(Math.min(a.x, b.x), 0, image.width);
  const y0 = clamp(Math.min(a.y, b.y), 0, image.height);
  const x1 = clamp(Math.max(a.x, b.x), 0, image.width);
  const y1 = clamp(Math.max(a.y, b.y), 0, image.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 範囲の中の、画像と書いたものを1枚の PNG にする
function cropped(r) {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(r.w));
  out.height = Math.max(1, Math.round(r.h));
  const g = out.getContext("2d");
  g.setTransform(out.width / r.w, 0, 0, out.height / r.h, (-r.x * out.width) / r.w, (-r.y * out.height) / r.h);
  g.drawImage(image, 0, 0);
  for (const item of items) drawItem(g, item);
  return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}

async function copySelection() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": cropped(selection) })]);
    return true;
  } catch (err) {
    toast(`コピーできませんでした：${err.message}`);
    return false;
  }
}

function unselect() {
  selection = null;
  render();
  updateButtons();
}

async function copy() {
  if (!(await copySelection())) return;
  unselect();
  toast("コピーしました");
}

async function cut() {
  const r = selection;
  if (!(await copySelection())) return;
  unselect();
  add({ kind: "fill", ...r });
  toast("切り取りました");
}

async function clipboardImage() {
  for (const entry of await navigator.clipboard.read()) {
    const type = entry.types.find((t) => t.startsWith("image/"));
    if (type) return entry.getType(type);
  }
  return null;
}

async function paste() {
  let blob;
  try {
    blob = await clipboardImage();
  } catch {
    toast("クリップボードを読めませんでした");
    return;
  }
  if (!blob) {
    toast("クリップボードに画像がありません");
    return;
  }
  // 画像を開いていなければ、貼った画像をそのまま開く
  if (!image) {
    await loadImage(blob);
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    toast("画像として読めませんでした");
    return;
  }
  // 見えている範囲の真ん中に元の大きさで出す。大きすぎれば見えている範囲に収まるよう縮める
  const k = Math.min(1, (PASTE_SHARE * innerWidth) / (bitmap.width * view.scale), (PASTE_SHARE * innerHeight) / (bitmap.height * view.scale));
  const w = bitmap.width * k;
  const h = bitmap.height * k;
  const cx = (innerWidth / 2 - view.x) / view.scale;
  const cy = (innerHeight / 2 - view.y) / view.scale;
  selection = null;
  placing = { kind: "paste", bitmap, blob, x: cx - w / 2, y: cy - h / 2, w, h };
  render();
  updateButtons();
}

// 貼る途中の画像のどこをつかんだか：角なら 0〜3、中なら "move"、外なら null
function gripAt(e) {
  const p = toImage(e);
  const i = corners(placing).findIndex(([x, y]) => Math.hypot(p.x - x, p.y - y) * view.scale <= GRIP_RADIUS);
  if (i >= 0) return i;
  const r = placing;
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h ? "move" : null;
}

// 中をつかめば動かし、角をつかめば向かいの角を止めたまま縦横の比を保って大きさを変える
function grab(p) {
  const { grip, start, from } = drawing;
  if (grip === "move") {
    placing.x = from.x + p.x - start.x;
    placing.y = from.y + p.y - start.y;
    return;
  }
  const [ax, ay] = corners(from)[3 - grip];
  const smallest = GRIP_RADIUS / (view.scale * Math.min(from.w, from.h));
  const k = Math.max(smallest, Math.abs(p.x - ax) / from.w, Math.abs(p.y - ay) / from.h);
  placing.w = from.w * k;
  placing.h = from.h * k;
  placing.x = grip % 2 === 0 ? ax - placing.w : ax;
  placing.y = grip < 2 ? ay - placing.h : ay;
}

function place() {
  const item = placing;
  placing = null;
  add(item);
}

function unplace() {
  placing = null;
  render();
  updateButtons();
}

async function clearSheet() {
  if (!image) {
    await openBlankSheet();
    return;
  }
  actions.push({ type: "clear", before: items });
  items = [{ kind: "fill", x: 0, y: 0, w: image.width, h: image.height }];
  inkStale = true;
  selection = null;
  render();
  changed();
  updateButtons();
}

// 画像を開いていないときの白紙は、画面の大きさの白い画像を開く
async function openBlankSheet() {
  const dpr = devicePixelRatio || 1;
  const sheet = document.createElement("canvas");
  sheet.width = Math.round(innerWidth * dpr);
  sheet.height = Math.round(innerHeight * dpr);
  const g = sheet.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, sheet.width, sheet.height);
  await loadImage(await new Promise((resolve) => sheet.toBlob(resolve, "image/png")));
}

let toastTimer = 0;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 2000);
}

// ---- 入力

canvas.addEventListener("pointerdown", (e) => {
  if (!image) return;
  closePanels();
  // 書いている間に触れた手のひらは無視する
  if (drawing) return;
  // 貼る途中の画像は、ペンでも指でもつかめる
  const grip = placing && fingers.size === 0 ? gripAt(e) : null;
  if (grip !== null) {
    canvas.setPointerCapture(e.pointerId);
    drawing = { id: e.pointerId, grip, start: toImage(e), from: { ...placing } };
    return;
  }
  if (isPen(e)) {
    if (placing) return;
    canvas.setPointerCapture(e.pointerId);
    fingers.clear();
    gesture = null;
    const tool = wantsEraser(e) || mode === "erase" ? "eraser" : mode === "select" ? "select" : settings.tool;
    if (tool === "select") {
      selection = null;
      drawing = { id: e.pointerId, anchor: toImage(e) };
      updateButtons();
    } else if (tool === "eraser") {
      drawing = { id: e.pointerId, removed: [], last: toImage(e) };
      eraseAt(drawing.last, drawing.removed);
    } else {
      const stroke = { tool, color: settings.color, width: strokeWidth(tool), points: [toImage(e)] };
      drawing = { id: e.pointerId, stroke };
    }
    render();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = baseline();
});

canvas.addEventListener("pointermove", (e) => {
  if (drawing && e.pointerId === drawing.id) {
    if (drawing.grip !== undefined) {
      grab(toImage(e));
      render();
      return;
    }
    if (drawing.anchor) {
      selection = between(drawing.anchor, toImage(e));
      render();
      return;
    }
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
    const { stroke, removed, anchor } = drawing;
    drawing = null;
    if (anchor && selection && Math.min(selection.w, selection.h) * view.scale < SELECT_MIN) selection = null;
    if (stroke) {
      stroke.box = boxOf(stroke.points);
      add(stroke);
      return;
    }
    if (removed?.length) {
      actions.push({ type: "erase", removed });
      changed();
    }
    render();
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

// ---- 書きかけを端末に残す：アプリが落ちても閉じても、開き直せば続きから書ける

const SAVE_DELAY_MS = 1000;
let database = null;
let saveTimer = 0;

function transact(mode, use) {
  database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("rakugaki", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("work");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return database.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("work", mode);
    const result = use(tx.objectStore("work"));
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}

// 線の点は1つずつの物にせず x・y・筆圧の数の並びにして残す。点が多くても速く書き出せるように
function pack(stroke) {
  if (stroke.kind === "fill") return stroke;
  if (stroke.kind === "paste") {
    const { kind, blob, x, y, w, h } = stroke;
    return { kind, blob, x, y, w, h };
  }
  const flat = new Float64Array(stroke.points.length * 3);
  stroke.points.forEach((p, i) => {
    flat[i * 3] = p.x;
    flat[i * 3 + 1] = p.y;
    flat[i * 3 + 2] = p.p;
  });
  return { tool: stroke.tool, color: stroke.color, width: stroke.width, points: flat };
}

async function unpack(saved) {
  if (saved.kind === "fill") return saved;
  if (saved.kind === "paste") return { ...saved, bitmap: await createImageBitmap(saved.blob) };
  const points = [];
  for (let i = 0; i < saved.points.length; i += 3) points.push({ x: saved.points[i], y: saved.points[i + 1], p: saved.points[i + 2] });
  return { tool: saved.tool, color: saved.color, width: saved.width, points, box: boxOf(points) };
}

function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStrokes, SAVE_DELAY_MS);
}

function saveStrokes() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  const saved = items.map(pack);
  transact("readwrite", (store) => store.put(saved, "strokes")).catch(() => {
    // 残せない端末でも、開いている間は書ける
  });
}

// 裏へ回ったアプリは、端末に閉じられることがある
addEventListener("visibilitychange", () => document.hidden && saveStrokes());

async function restore() {
  try {
    const [kept, saved] = await transact("readonly", (store) => [store.get("image"), store.get("strokes")]);
    if (kept.result) await showWork(kept.result, await Promise.all((saved.result || []).map(unpack)));
  } catch {
    // 残したものを読めなければ、まっさらから始める
  }
}

// ---- 画像の出し入れ

async function showWork(blob, saved) {
  image = await createImageBitmap(blob);
  items = saved;
  actions = saved.map((item) => ({ type: "add", item }));
  selection = null;
  placing = null;
  resetInk();
  $("empty").hidden = true;
  fit();
  updateButtons();
}

async function loadImage(blob) {
  try {
    await showWork(blob, []);
  } catch {
    alert("画像として読めませんでした");
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = 0;
  transact("readwrite", (store) => {
    store.put(blob, "image");
    store.put([], "strokes");
  }).catch(() => {
    // 残せない端末でも、開いている間は書ける
  });
}

// 共有で開いたなら、その結果を出したかを返す
async function takeShared() {
  const result = location.search;
  if (result !== "?shared" && result !== "?share-failed") return false;
  history.replaceState(null, "", location.pathname);
  if (result === "?share-failed") {
    $("hint").textContent = "共有されたものから画像を取り出せませんでした";
    return true;
  }
  const cache = await caches.open("rakugaki-shared");
  const response = await cache.match("shared");
  if (!response) return false;
  await cache.delete("shared");
  await loadImage(await response.blob());
  return true;
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
  for (const item of items) drawItem(g, item);
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
  if (!(settings.tool in TOOL_ICONS)) settings.tool = "pen";
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
  $("pen").setAttribute("aria-pressed", mode === "draw");
  $("more").setAttribute("aria-pressed", mode !== "draw");
  $("more-icon").setAttribute("href", `#icon-${mode === "draw" ? "more" : mode}`);
  for (const b of document.querySelectorAll("#subpanel [data-mode]")) b.setAttribute("aria-pressed", b.dataset.mode === mode);
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

function closePanels() {
  $("panel").hidden = true;
  $("subpanel").hidden = true;
}

function togglePanel(id) {
  const open = $(id).hidden;
  closePanels();
  $(id).hidden = !open;
}

function setMode(next) {
  mode = next;
  selection = null;
  closePanels();
  syncSettings();
  render();
  updateButtons();
}

// ペンのボタンは、消しゴムや範囲のときは書くのに戻し、書いているときは道具・色・太さを選ぶ板を開け閉めする
$("pen").addEventListener("click", () => (mode === "draw" ? togglePanel("panel") : setMode("draw")));
// ⋯ は、消しゴム・範囲・貼る・白紙のボタンをしまった板を開け閉めする
$("more").addEventListener("click", () => togglePanel("subpanel"));
for (const b of document.querySelectorAll("#subpanel [data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
$("paste").addEventListener("click", () => {
  closePanels();
  paste();
});
$("clear").addEventListener("click", () => {
  closePanels();
  clearSheet();
});
$("copy").addEventListener("click", copy);
$("cut").addEventListener("click", cut);
$("unselect").addEventListener("click", unselect);
$("place").addEventListener("click", place);
$("unplace").addEventListener("click", unplace);

function updateButtons() {
  $("undo").disabled = actions.length === 0;
  $("fit").disabled = !image;
  $("share").disabled = !image;
  $("selected").hidden = !selection || Boolean(drawing?.anchor);
  $("placing").hidden = !placing;
}

// ---- インストール：ブラウザで開いたら、アプリの紹介と入れ方だけを出す。書く画面は入れたアプリの中でだけ出す

let installPrompt = null;
document.body.classList.toggle("install-only", matchMedia("(display-mode: browser)").matches);

// 入れる確認を出せるときはボタンを、出せないとき（Discord などの中の窓・断られた後）は入れ方の文を出す
function offerInstall(ready) {
  $("install").hidden = !ready;
  $("install-note").hidden = ready;
}

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  offerInstall(true);
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  $("install-note").textContent = "入りました。ホーム画面か、共有メニューの「ペンらくがき」から開いてください";
  offerInstall(false);
});
$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome !== "accepted") offerInstall(false);
});

$("undo").addEventListener("click", undo);
$("fit").addEventListener("click", fit);
$("share").addEventListener("click", send);
addEventListener("resize", resize);

loadSettings();
syncSettings();
resize();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
// ブラウザでは紹介だけを出すので、書きかけは入れたアプリで開いたときに出す
if (!document.body.classList.contains("install-only")) takeShared().then((shown) => shown || restore());
