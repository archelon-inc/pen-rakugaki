// ペンらくがきを headless Chrome で外から操作し、利用者に見える振る舞いを確かめる。
// usage: node test/e2e.mjs <app-url> <out-dir>
//   app-url  アプリを配信している URL（例: http://127.0.0.1:8765/。service worker のため localhost か https）
//   out-dir  各段の画面と書き出した画像を置くディレクトリ（無ければ作る）
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [APP, OUT] = process.argv.slice(2);
if (!APP || !OUT) {
  console.error("usage: node test/e2e.mjs <app-url> <out-dir>");
  process.exit(2);
}
const OUT_DIR = resolve(OUT);
const IMAGE = join(dirname(fileURLToPath(import.meta.url)), "sample.png");
mkdirSync(OUT_DIR, { recursive: true });

const PORT = 9444;
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "pen-rakugaki-e2e-"))}`,
  "--no-first-run", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.error("FAIL 90秒で終わらなかった（アプリが配信されていないか、service worker が動いていない）");
  chrome.kill();
  process.exit(1);
}, 90000).unref();

let version;
for (let i = 0; i < 50 && !version; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (!msg.id || !waiting.has(msg.id)) return;
  const { ok, ng } = waiting.get(msg.id);
  waiting.delete(msg.id);
  msg.error ? ng(new Error(JSON.stringify(msg.error))) : ok(msg.result);
});
const send = (method, params = {}, sessionId) => new Promise((ok, ng) => {
  const id = ++seq;
  waiting.set(id, { ok, ng });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
const evaluate = async (expression) => (await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })).result.value;

await page("Page.enable");
await page("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await page("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
// クリップボードを読むにはページが前に出ている必要がある。ほかのアプリと同じく読み書きを許しておく
await page("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: new URL(APP).origin });
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT_DIR });

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// 画面を撮って残し、下のボタンの帯を除いた絵の部分を比べる材料として返す
async function shot(name) {
  await sleep(300);
  // 「コピーしました」などの知らせが消えてから撮る
  await evaluate(`new Promise((r) => { const t = document.querySelector("#toast"); const wait = () => (t.hidden ? r(true) : setTimeout(wait, 100)); wait(); })`);
  const { data } = await page("Page.captureScreenshot", { format: "png" });
  await writeFile(join(OUT_DIR, `${name}.png`), Buffer.from(data, "base64"));
  const clip = { x: 0, y: 0, width: 412, height: 830, scale: 1 };
  return Buffer.from((await page("Page.captureScreenshot", { format: "png", clip })).data, "base64");
}

async function pen(points, { force = 0.5 } = {}) {
  const base = { pointerType: "pen", button: "left", force };
  await page("Input.dispatchMouseEvent", { ...base, type: "mousePressed", x: points[0][0], y: points[0][1], buttons: 1, clickCount: 1 });
  for (const [x, y] of points.slice(1)) await page("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", x, y, buttons: 1 });
  const [x, y] = points.at(-1);
  await page("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", x, y, buttons: 0, clickCount: 1 });
}

async function fingers(from, to, steps = 8) {
  const points = (list) => list.map(([x, y], id) => ({ x, y, id }));
  await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  for (let s = 1; s <= steps; s++) {
    const now = from.map(([x, y], i) => [x + ((to[i][0] - x) * s) / steps, y + ((to[i][1] - y) * s) / steps]);
    await page("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(now) });
  }
  await page("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// 指で動かした直後のタップは、慣性を止める操作として扱われて押下にならないので、間を置いてから押す
async function tap(selector) {
  await sleep(500);
  const [x, y] = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await fingers([[x, y]], [[x, y]], 0);
  await sleep(100);
}

async function chooseFile(selector, path) {
  const { root } = await page("DOM.getDocument");
  const { nodeId } = await page("DOM.querySelector", { nodeId: root.nodeId, selector });
  await page("DOM.setFileInputFiles", { nodeId, files: [path] });
}

// 共有メニューから画像を送ったときと同じく、共有の入口へ画像を POST して開く
async function shareImage() {
  await evaluate(`(() => {
    const form = Object.assign(document.createElement("form"), { method: "POST", action: "share", enctype: "multipart/form-data" });
    form.append(Object.assign(document.createElement("input"), { type: "file", name: "image", id: "shared-input" }));
    document.body.append(form);
    return true;
  })()`);
  await chooseFile("#shared-input", IMAGE);
  await evaluate("document.querySelector('#shared-input').form.submit(), true");
  await sleep(2000);
}

// 画像（PNG のバイト列、または画面の写しの中の四角 [x, y, 幅, 高さ]）に、どの色があるか。
// 赤はペンの線、橙は試験用の画像の②の枠、緑は貼るための試しの画像の色
const PALETTE = `(d) => {
  const has = { red: false, orange: false, green: false, white: true };
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (r > 180 && g < 90 && b < 90) has.red = true;
    if (r > 230 && g > 140 && g < 200 && b < 40) has.orange = true;
    if (r < 60 && g > 150 && b < 60) has.green = true;
    if (r < 245 || g < 245 || b < 245) has.white = false;
  }
  return has;
}`;
const colors = (png, box) => evaluate(`(async () => {
  const bytes = Uint8Array.from(atob("${png.toString("base64")}"), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const k = bmp.width / 412;
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
  g.drawImage(bmp, 0, 0);
  const [x, y, w, h] = ${JSON.stringify(box)}.map((v) => Math.round(v * k));
  return (${PALETTE})(g.getImageData(x, y, w, h).data);
})()`);
// クリップボードの画像の大きさと色。画像が無ければ null
const clipboard = () => evaluate(`(async () => {
  const [entry] = await navigator.clipboard.read();
  if (!entry || !entry.types.includes("image/png")) return null;
  const bmp = await createImageBitmap(await entry.getType("image/png"));
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
  g.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, ...(${PALETTE})(g.getImageData(0, 0, bmp.width, bmp.height).data) };
})()`);

const wave = (x0, y0, w, h, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x0 + (w * i) / n, y0 + h * Math.sin((i / n) * Math.PI * 2)]);

// 入れられるアプリとして成り立っている
await page("Page.navigate", { url: APP });
await sleep(1500);
check("service worker が動く", await evaluate("navigator.serviceWorker.ready.then(() => true)"));
check("manifest に誤りが無い", (await page("Page.getAppManifest")).errors.length === 0);
check("インストールできる", (await page("Page.getInstallabilityErrors")).installabilityErrors.length === 0);
const visible = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).checkVisibility()`);
check("ブラウザで開くとアプリの紹介とインストールのボタンが出る", (await visible("#intro")) && (await visible("#install")));
check("ブラウザでは紹介とインストールのボタンの他は出ない", !(await visible("#bar")) && !(await visible("#hint")));
await shot("00-browser");

// ここから先は、入れたアプリとして開いたときの振る舞い。
// headless の Chrome は入れたアプリの窓を開けず display-mode も真似られないので、表示モードの問い合わせに全画面のアプリとして答えさせる
await page("Page.addScriptToEvaluateOnNewDocument", {
  source: `{
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q.includes("display-mode") ? real(q.includes("fullscreen") ? "all" : "not all") : real(q));
  }`,
});
await page("Page.reload");
await sleep(1500);
check("入れたアプリでは紹介を出さず、書くためのボタンを出す", !(await visible("#intro")) && (await visible("#bar")));
check("画像は共有でだけ受け取り、端末の画像を選ぶ入口は無い", await evaluate(`document.querySelectorAll('input[type="file"]').length === 0`));
const empty = await shot("01-empty");

// 共有メニューから届いた画像を開く
await shareImage();
check("共有の後は URL に印が残らない", (await evaluate("location.search")) === "");
const loaded = await shot("02-loaded");
check("共有で届いた画像が出る", !loaded.equals(empty));

// ペンで書くと線が載る
await pen(wave(60, 300, 290, 40), { force: 0.2 });
await pen(wave(60, 420, 290, 40), { force: 1 });
const drawn = await shot("03-pen");
check("ペンで書くと線が載る", !drawn.equals(loaded));

// 指は書かずに、2本で拡大・1本で動かす
await fingers([[180, 450], [230, 450]], [[80, 450], [330, 450]]);
const zoomed = await shot("04-zoomed");
check("2本指で拡大する", !zoomed.equals(drawn));
await fingers([[200, 600]], [[200, 500]]);
const moved = await shot("05-moved");
check("1本指で動かす", !moved.equals(zoomed));
await tap("#more");
await tap("#fit");
check("全体表示で拡大前に戻る（指では書いていない）", (await shot("06-fit")).equals(drawn));

// マーカーに替えて引く
await tap("#pen");
await tap('[data-tool="marker"]');
await tap('[data-color="#1e63d6"]');
await fingers([[200, 150]], [[200, 150]], 0);
await pen([[60, 250], [350, 250]]);
const marked = await shot("07-marker");
check("マーカーで線が載る", !marked.equals(drawn));

// 消しゴムで消し、元に戻すと戻る。消しゴム・範囲・貼る・白紙は ⋯ の中にしまってある
check("消しゴム・範囲・貼る・白紙・全体表示は、⋯ を押すまで出ない", !(await visible('[data-mode="erase"]')) && !(await visible("#fit")));
await tap("#more");
check("⋯ を押すと、消しゴム・範囲・貼る・白紙・全体表示のボタンが出る",
  (await visible('[data-mode="erase"]')) && (await visible('[data-mode="select"]')) && (await visible("#paste")) && (await visible("#clear")) && (await visible("#fit")));
await shot("07-more");
await tap('[data-mode="erase"]');
await pen([[200, 260], [200, 345]]);
const erased = await shot("08-erased");
check("消しゴムでなぞった線が消える", !erased.equals(marked));
await tap("#undo");
check("元に戻すと消した線が戻る", (await shot("09-undo")).equals(marked));

// 消しゴムからペンのボタンで書くのに戻る
await tap("#pen");
await pen(wave(60, 540, 290, 30));
const rewritten = await shot("10-pen-again");
check("消しゴムのあとにペンのボタンを押すと、書くのに戻る", !rewritten.equals(marked));

// アプリが落ちても閉じても、開き直せば書いたものが残っている
await sleep(1500);
await page("Page.reload");
await sleep(1500);
check("開き直すと、書いたものがそのまま出る", (await shot("11-reopened")).equals(rewritten));

// 送る（共有の無い環境では画像を書き出す）
await tap("#share");
await sleep(1500);
check("送ると書き込んだ画像が出る", readdirSync(OUT_DIR).some((f) => /^rakugaki-.*\.jpg$/.test(f)));

// 範囲を選んでコピーすると、範囲の中の絵と線が1枚の画像でクリップボードに入る
await tap("#more");
await tap('[data-mode="select"]');
const box = [100, 280, 200, 160];
await pen([[box[0], box[1]], [box[0] + box[2] / 2, box[1] + box[3] / 2], [box[0] + box[2], box[1] + box[3]]]);
check("範囲を選ぶと、コピーと切り取りのボタンが出る", (await visible("#copy")) && (await visible("#cut")));
await tap("#copy");
const copied = await clipboard();
check("コピーすると、範囲の中の絵と線が画像でクリップボードに入る",
  copied?.red && copied.orange && Math.abs(copied.width / copied.height - box[2] / box[3]) < 0.05);

// 切り取ると、クリップボードに入り、範囲の中は白くなる
await page("Runtime.evaluate", { expression: "navigator.clipboard.writeText('')", awaitPromise: true, userGesture: true });
const beforeCut = await shot("16-before-cut");
await pen([[box[0], box[1]], [box[0] + box[2], box[1] + box[3]]]);
await tap("#cut");
const afterCut = await shot("17-cut");
const inner = [box[0] + 3, box[1] + 3, box[2] - 6, box[3] - 6];
check("切り取ると、範囲の中の絵と線がクリップボードに入る", (await clipboard())?.orange === true);
check("切り取ると、範囲の中が白くなる", !(await colors(beforeCut, inner)).white && (await colors(afterCut, inner)).white);
await tap("#undo");
check("元に戻すと、切り取った所が戻る", (await shot("18-cut-undone")).equals(beforeCut));

// ほかのアプリでコピーした画像を貼ると、画面の真ん中に元の大きさで出て、角を引いて大きさを変えられる
await evaluate(`(async () => {
  const c = new OffscreenCanvas(400, 200);
  const g = c.getContext("2d");
  g.fillStyle = "#00c000";
  g.fillRect(0, 0, 400, 200);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": await c.convertToBlob({ type: "image/png" }) })]);
  return true;
})()`);
const scale = await evaluate("innerWidth") / 1080;
const half = [200 * scale, 100 * scale];
const center = [412 / 2, 915 / 2];
await tap("#more");
const pasting = await shot("19-pasting");
check("コピー・切り取りのあとは、⋯ のボタンを押すとすぐ貼れる",
  !(await visible("#subpanel")) && (await colors(pasting, [center[0] - 20, center[1] - 10, 40, 20])).green);
check("貼ると、画面の真ん中に元の大きさで出る",
  (await colors(pasting, [center[0] - half[0] + 4, center[1] - half[1] + 4, half[0] * 2 - 8, half[1] * 2 - 8])).green
  && !(await colors(pasting, [center[0] + half[0] + 14, center[1] + half[1] + 14, 20, 20])).green);
const corner = [center[0] + half[0], center[1] + half[1]];
await pen([corner, [corner[0] + 30, corner[1] + 15], [corner[0] + 60, corner[1] + 30]]);
const resized = await shot("20-resized");
check("角を引くと、その場で大きくなる", (await colors(resized, [center[0] + half[0] + 14, center[1] + half[1] + 14, 20, 10])).green);
await pen([[60, 780]]);
const placed = await shot("21-placed");
check("貼る途中の画像の外をペンで触ると、貼って抜ける（四角が消え、画像は残る）",
  !placed.equals(resized) && (await colors(placed, [center[0] - 20, center[1] - 10, 40, 20])).green);
await sleep(1500);
await page("Page.reload");
await sleep(1500);
check("開き直しても、貼った画像が残る", (await shot("22-placed-reopened")).equals(placed));
await tap("#undo");
check("元に戻すと、貼った画像が消える", (await shot("23-paste-undone")).equals(beforeCut));

// 範囲を選んだあとは、貼る途中の画像と同じく、中をつかんで動かし、角を引いて大きさを変えられる。元の所は白くなる
await tap("#more");
await tap('[data-mode="select"]');
await pen([[box[0], box[1]], [box[0] + box[2], box[1] + box[3]]]);
const mid = [box[0] + box[2] / 2, box[1] + box[3] / 2];
await pen([mid, [mid[0], mid[1] + 110], [mid[0], mid[1] + 220]]);
const lifted = await shot("23b-lifted");
check("範囲の中をつかんで動かすと、絵と線が動き、元の所は白くなる",
  (await colors(lifted, inner)).white && (await colors(lifted, [inner[0], inner[1] + 220, inner[2], inner[3]])).orange);
await tap("#undo");
check("動かしている途中で元に戻すと、動かす前に戻る", (await shot("23c-unlifted")).equals(beforeCut));
await pen([[box[0], box[1]], [box[0] + box[2], box[1] + box[3]]]);
const selected = await shot("23d-selected");
const end = [box[0] + box[2], box[1] + box[3]];
await pen([end, [end[0] + 30, end[1] + 24], [end[0] + 60, end[1] + 48]]);
const grown = await shot("23e-grown");
check("範囲の角を引くと、絵と線がその場で大きくなる", !grown.equals(selected));
await tap("#pen");
const grownPlaced = await shot("23f-grown-placed");
check("動かしている途中でペンのボタンに替えると、動かした絵と線が入る（四角が消え、絵と線は残る）",
  !grownPlaced.equals(grown) && !grownPlaced.equals(beforeCut));
await tap("#undo");
check("元に戻すと、1回で動かす前に戻る", (await shot("23g-grow-undone")).equals(beforeCut));

// 白紙にすると絵も線も消えて白くなり、元に戻すと戻る
await tap("#more");
await tap("#clear");
check("白紙にすると、絵も線も消えて白くなる", (await colors(await shot("24-clear"), [10, 30, 392, 780])).white);
await tap("#undo");
check("元に戻すと、白紙にする前に戻る", (await shot("25-clear-undone")).equals(beforeCut));

// たくさん書いても、書いている間の1コマが重くならない（重くなり続けると、たくさん書いたあとにアプリが落ちる）。
// CDP で1点ずつ送ると千本の線に時間がかかるので、ペンの入力をページの中で送る
const PEN = `const board = document.querySelector("#board");
  const pen = (type, x, y) => board.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, pressure: 0.5, buttons: type === "pointerup" ? 0 : 1, bubbles: true }));`;
// ペンの1点を受けてから、その点を描いた1コマを描き終えるまでの時間（中央値）。
// 受けるのにかかった時間と、そのコマの描画の前後に置いた印の間を足す。書いたものを残すなどの裏の仕事は
// コマの外で走るので入らず、描く重さだけを見られる
const frameCost = () => evaluate(`(async () => {
  ${PEN}
  const costs = [];
  pen("pointerdown", 100, 600);
  for (let i = 1; i <= 9; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    let frameStart = 0;
    requestAnimationFrame(() => (frameStart = performance.now()));
    const received = performance.now();
    pen("pointermove", 100 + i * 20, 600 + i * 5);
    const receiving = performance.now() - received;
    const frameEnd = await new Promise((r) => requestAnimationFrame(() => r(performance.now())));
    costs.push(receiving + frameEnd - frameStart);
  }
  pen("pointerup", 280, 645);
  return costs.sort((a, b) => a - b)[4];
})()`);
await shareImage();
await tap("#pen");
await tap('[data-tool="pen"]');
await fingers([[200, 150]], [[200, 150]], 0);
const light = await frameCost();
const fewLines = await shot("26-before-many");
await evaluate(`(() => {
  ${PEN}
  for (let k = 0; k < 1000; k++) {
    const x = 40 + ((k * 37) % 330);
    const y = 120 + ((k * 53) % 600);
    pen("pointerdown", x, y);
    for (let i = 1; i <= 100; i++) pen("pointermove", x + i * 0.4, y + 8 * Math.sin(i / 6));
    pen("pointerup", x + 40, y);
  }
  return true;
})()`);
check("ペンで千本の線を書ける", !(await shot("27-many")).equals(fewLines));
const heavy = await frameCost();
check(`千本書いても、書いている間の1コマが重くならない（${light.toFixed(1)} ms → ${heavy.toFixed(1)} ms）`, heavy < light * 2 + 2);

// 書いている途中で別の画像が共有で届くと、前の線は消えてその画像が出る
await shareImage();
check("新しく共有で届いた画像は線なしで出る", (await shot("28-shared")).equals(loaded));

// 共有メニューから画像のリンク（文）が届いたら、その画像を取ってきて開く
async function shareText(text) {
  await evaluate(`(() => {
    const form = Object.assign(document.createElement("form"), { method: "POST", action: "share", enctype: "multipart/form-data" });
    form.append(Object.assign(document.createElement("input"), { type: "hidden", name: "text", value: ${JSON.stringify(text)} }));
    document.body.append(form);
    form.submit();
    return true;
  })()`);
  await sleep(2000);
}
await shareText(`見て ${new URL("test/sample.png", APP).href}`);
check("共有でリンクが届いたら、その画像が出る", (await shot("29-shared-link")).equals(loaded));
await shareText("画像の無い文");
check("画像を取り出せない共有には、そう伝える", (await evaluate("document.querySelector('#hint').textContent")).includes("取り出せませんでした"));

chrome.kill();
process.exit(failures ? 1 : 0);
