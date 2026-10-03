self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("dexter-shell").then((cache) => cache.addAll(["/", "/icon.svg"])));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
