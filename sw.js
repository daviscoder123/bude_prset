/* Bude pršet? — service worker
   Cachuje pouze statický shell (HTML, manifest, ikony), aby šla appka
   přidat na plochu a startovala rychle. API požadavky (předpovědi,
   radar, geokódování) jdou vždy přímo na síť a NEcachují se zde —
   o úsporu dat se stará in-memory cache v aplikaci. Na pozadí SW
   nic nestahuje. */
var CACHE = "bude-prset-v6 /* kolo 8l: bump verze vynuti SW update, controllerchange pak reloadne stranku */";
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
  if(e.request.method !== "GET") return;   /* ne-GET do cache nepatří, c.put() by vyhodil výjimku */
  var url = new URL(e.request.url);
  if(url.origin !== location.origin) return;      /* API třetích stran: vždy síť, bez zásahu */
  /* kolo 8j hotfix: network-first samo o sobe neznamena "vzdy cerstve" -
     fetch() uvnitr SW respektuje HTTP cache a Pages servuje index.html
     s max-age=600, takze mobil do 10 minut (iOS PWA i dele) zobrazuje
     starou verzi po nasazeni. Navigace proto obejdou HTTP cache. */
  var net = e.request.mode === "navigate"
    ? fetch(e.request, {cache: "reload"})
    : fetch(e.request);
  e.respondWith(
    net.then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ return c.put(e.request, copy); }).catch(function(){});
      return res;
    }).catch(function(){ return caches.match(e.request); })
  );
});
