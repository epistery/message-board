const CACHE_NAME = 'message-board-v1';
const POSTS_CACHE_KEY = 'posts-cache';

// Install service worker
self.addEventListener('install', (event) => {
  console.log('Service Worker installing');
  self.skipWaiting();
});

// Activate service worker
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating');
  event.waitUntil(self.clients.claim());
});

// Handle messages from the app
self.addEventListener('message', async (event) => {
  if (event.data.type === 'UPDATE_CACHE') {
    // Store posts in cache
    const cache = await caches.open(CACHE_NAME);
    const postsData = {
      posts: event.data.posts,
      timestamp: Date.now()
    };
    await cache.put(
      POSTS_CACHE_KEY,
      new Response(JSON.stringify(postsData))
    );
  } else if (event.data.type === 'GET_CACHE') {
    // Retrieve posts from cache
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(POSTS_CACHE_KEY);

    if (response) {
      const data = await response.json();
      event.source.postMessage({
        type: 'CACHED_POSTS',
        posts: data.posts
      });
    }
  }
});

// Intercept fetch requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Handle API requests
  if (url.pathname.startsWith('/api/posts')) {
    event.respondWith(
      fetch(event.request)
        .catch(async () => {
          // If fetch fails (offline), return cached data
          if (event.request.method === 'GET' && url.pathname === '/api/posts') {
            const cache = await caches.open(CACHE_NAME);
            const response = await cache.match(POSTS_CACHE_KEY);

            if (response) {
              const data = await response.json();
              return new Response(JSON.stringify(data.posts), {
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }

          return new Response(JSON.stringify({ error: 'Offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
  } else {
    // For static assets, use network-first strategy
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(event.request))
    );
  }
});
