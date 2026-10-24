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
const evaluate = async (expression) => (await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await page("Page.enable");
await page("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await page("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT_DIR });

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// 画面を撮って残し、下のボタンの帯を除いた絵の部分を比べる材料として返す
async function shot(name) {
  await sleep(300);
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

const wave = (x0, y0, w, h, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x0 + (w * i) / n, y0 + h * Math.sin((i / n) * Math.PI * 2)]);

// 入れられるアプリとして成り立っている
await page("Page.navigate", { url: APP });
await sleep(1500);
check("service worker が動く", await evaluate("navigator.serviceWorker.ready.then(() => true)"));
check("manifest に誤りが無い", (await page("Page.getAppManifest")).errors.length === 0);
check("インストールできる", (await page("Page.getInstallabilityErrors")).installabilityErrors.length === 0);
const visible = (selector) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display !== "none"`);
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

// 消しゴムで消し、元に戻すと戻る
await tap("#eraser");
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
const fewLines = await shot("12-before-many");
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
check("ペンで千本の線を書ける", !(await shot("13-many")).equals(fewLines));
const heavy = await frameCost();
check(`千本書いても、書いている間の1コマが重くならない（${light.toFixed(1)} ms → ${heavy.toFixed(1)} ms）`, heavy < light * 2 + 2);

// 書いている途中で別の画像が共有で届くと、前の線は消えてその画像が出る
await shareImage();
check("新しく共有で届いた画像は線なしで出る", (await shot("14-shared")).equals(loaded));

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
check("共有でリンクが届いたら、その画像が出る", (await shot("15-shared-link")).equals(loaded));
await shareText("画像の無い文");
check("画像を取り出せない共有には、そう伝える", (await evaluate("document.querySelector('#hint').textContent")).includes("取り出せませんでした"));

chrome.kill();
process.exit(failures ? 1 : 0);
