// 共有メニューから届いた画像を受け取り、アプリの画面へ渡す。
// 画面の部品は毎回配信元へ新しさを確かめ（ブラウザの保存を素通しにしない）、繋がらないときだけ手元の写しを使う。
"use strict";

const SHELL = "rakugaki-shell-v2";
const SHARED = "rakugaki-shared";
const FILES = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== SHARED).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname.endsWith("/share")) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request.url, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

async function receiveShare(request) {
  const form = await request.formData();
  const file = form.get("image");
  const home = new URL("./", self.registration.scope);
  if (!(file instanceof File)) return Response.redirect(home.href, 303);
  const cache = await caches.open(SHARED);
  await cache.put("shared", new Response(file, { headers: { "Content-Type": file.type } }));
  home.search = "shared";
  return Response.redirect(home.href, 303);
}
