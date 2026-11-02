function registerServiceWorker(serviceWorkerFileName) {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register(serviceWorkerFileName)
      .then((registration) => {
        console.log("Service Worker registered with scope:", registration.scope);
      })
      .catch((error) => {
        console.log("Service Worker registration failed:", error);
      });
  }
}

function awakenServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((registration) => {
      registration.active.postMessage({ type: "awaken" });
    });
  }
}

// sw.js and sw-fallback.js are part of the label-studio/label_studio/core/static/js/ directory
// and are copied with the rest of the static files when running `python manage.py collectstatic`
//
// Local dev: the workbox precache SW pins the *previous* build's hashed chunks. Every rebuild
// deletes those files from disk, so the still-active SW either serves a stale bundle or 404s on
// the missing chunks (breaking the labeling editor). Skip registration on localhost and tear down
// any previously installed SW + its caches so frontend changes take effect immediately.
const isLocalDev = ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);

if (isLocalDev) {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => {});
    if (window.caches && caches.keys) {
      caches
        .keys()
        .then((keys) => keys.forEach((key) => caches.delete(key)))
        .catch(() => {});
    }
  }
} else {
  registerServiceWorker("/sw.js");

  // Wake up the service worker when the page becomes visible
  // This is needed to ensure we are cleaning up cache when the user is using the application
  // and not only when the user is closing the tab.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      awakenServiceWorker();
    }
  });
}
