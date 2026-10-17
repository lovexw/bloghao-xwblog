/* 博客号后台 Service Worker（C10 / PWA 可安装）：只为「添加到主屏幕」的安装资格存在。
 * 刻意不做任何资源缓存——无构建链「改完即生效」是产品定位，缓存会造成幽灵旧版后台。
 * fetch 只做透传 + 离线时显式 503 提示，不吞不缓存任何请求。 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  e.respondWith(
    fetch(e.request).catch(
      () =>
        new Response('后台处于离线状态，恢复网络后重试即可。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
    )
  )
})
