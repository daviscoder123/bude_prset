/* Bude pršet? — service worker
   Cachuje pouze statický shell (HTML, manifest, ikony), aby šla appka
   přidat na plochu a startovala rychle. API požadavky (předpovědi,
   radar, geokódování) jdou vždy přímo na síť a NEcachují se zde —
   o úsporu dat se stará in-memory cache v aplikaci. Na pozadí SW
   nic nestahuje. */
var CACHE = "bude-prset-v2";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var url = new URL(e.request.url);
  if(url.origin !== location.origin) return;      /* API třetích stran: vždy síť, bez zásahu */
  e.respondWith(
    fetch(e.request).then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
      return res;
    }).catch(function(){ return caches.match(e.request); })
  );
});
