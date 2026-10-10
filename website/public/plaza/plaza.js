/* 广场页交互：拉 hub feed 渲染（ES5 同官网 site.js 口径，textContent 防 XSS——feed 内容来自各站，属半可信） */
(function () {
  'use strict'

  var HUB = 'https://plaza.bloghao.com'
  var feedEl = document.getElementById('plaza-feed')
  var sitesEl = document.getElementById('plaza-sites')
  var state = { kind: '' }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function fmtDate(ts) {
    var d = new Date(ts - 0)
    // 北京时间口径（+8h 后取 UTC 分量，与博客内核 cstDate 同理）
    var b = new Date(d.getTime() + 8 * 3600 * 1000)
    function p(n) { return (n < 10 ? '0' : '') + n }
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate())
  }

  function renderFeed(feed) {
    if (!feed || !feed.length) {
      feedEl.innerHTML =
        '<div class="plaza-empty">广场还空着——第一篇同步上来的文章会出现在这里。<br>你的博客号也可以：<a href="../#start">现在就开一个</a>。</div>'
      return
    }
    var html = ''
    for (var i = 0; i < feed.length; i++) {
      var it = feed[i]
      // 所有动态字段走 esc；hub 出参里的 url 只收 https（hub 端已校验），这里仍只作为 href 输出
      html +=
        '<a class="plaza-card" href="' + esc(it.url) + '" target="_blank" rel="noopener">' +
        (it.image ? '<img class="plaza-card-thumb" src="' + esc(it.image) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
        '<div class="plaza-card-main">' +
        '<h3 class="plaza-card-title">' + esc(it.title) + '</h3>' +
        (it.summary && it.summary !== it.title ? '<p class="plaza-card-summary">' + esc(it.summary) + '</p>' : '') +
        '<div class="plaza-card-meta">' +
        '<a class="plaza-site-link" href="' + esc(it.siteUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(it.siteName) + '</a>' +
        (it.siteVerified ? '<span class="plaza-badge" title="站点已通过所有权验证">✔︎ 认证</span>' : '') +
        '<span class="plaza-kind-chip">' + (it.kind === 'post' ? '📝 文章' : '💭 微博') + '</span>' +
        '<span>' + fmtDate(it.publishedAt) + '</span>' +
        '</div></div></a>'
    }
    feedEl.innerHTML = html
  }

  function loadFeed() {
    feedEl.innerHTML = '<div class="plaza-loading">广场内容加载中…</div>'
    // 时间戳抖一抖绕过中间缓存，保证「换一批」真的换
    fetch(HUB + '/api/feed?limit=30&kind=' + state.kind + '&_=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { renderFeed(d && d.feed) })
      .catch(function () {
        feedEl.innerHTML = '<div class="plaza-empty">广场暂时连不上，稍后再来看看。</div>'
      })
  }

  function renderSites(sites) {
    if (!sites || !sites.length) {
      sitesEl.innerHTML = '<li>还没有博客号上榜，第一坐等你来。</li>'
      return
    }
    var html = ''
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i]
      html +=
        '<li>' +
        '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>' +
        (s.verified ? '<span class="plaza-badge" title="站点已通过所有权验证">✔︎</span>' : '') +
        '<span class="plaza-sites-count">' + (s.items - 0) + ' 条</span>' +
        '</li>'
    }
    sitesEl.innerHTML = html
  }

  function loadSites() {
    fetch(HUB + '/api/sites')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { renderSites(d && d.sites) })
      .catch(function () { sitesEl.innerHTML = '<li>名录暂时连不上。</li>' })
  }

  // 类型 tab
  var tabs = document.querySelectorAll('.plaza-tab[data-kind]')
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      state.kind = this.getAttribute('data-kind') || ''
      for (var j = 0; j < tabs.length; j++) {
        tabs[j].classList.toggle('is-active', tabs[j] === this)
        tabs[j].setAttribute('aria-selected', tabs[j] === this ? 'true' : 'false')
      }
      loadFeed()
    })
  }
  document.getElementById('plaza-refresh').addEventListener('click', loadFeed)

  loadFeed()
  loadSites()
})()
