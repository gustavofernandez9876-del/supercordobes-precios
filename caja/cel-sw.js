// Service worker de la página del celular: solo para que se pueda instalar como app.
// No guarda nada en caché (siempre trae precios y ventas frescos de la red).
// Su alcance es solo celular.html: no toca la caja (index.html).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
