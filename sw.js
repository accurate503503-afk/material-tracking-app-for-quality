const CACHE='ultra503-trace-pwa-v1';
const CORE=['./','./index.html','./style.css','./app.js','./config.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./assets/ultra-logo.png'];

self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));

// IMPORTANT: this app is backed by a live Supabase database. Only the
// same-origin static app shell is cached for offline use. Every request
// to Supabase (auth, data, storage) must always go straight to the
// network — caching those would risk showing stale handover/quantity
// status, which defeats the entire point of this system.
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET' || url.origin!==self.location.origin){
    return; // let the browser handle it normally — no caching, no interception
  }
  e.respondWith(
    caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
      const c=res.clone();
      caches.open(CACHE).then(x=>x.put(e.request,c));
      return res;
    }).catch(()=>caches.match('./index.html')))
  );
});
