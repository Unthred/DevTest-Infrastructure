// Runs right after <main>, before the page is first painted (issue #431): applies the saved card layout (order, widths, heights,
// collapsed cards) from this browser's storage so cards never move after the first draw. Same-origin, sends nothing. It mirrors
// applyLayout and sanitizeCollapsed in logic.mjs (a test runs both on the same input); app.js re-applies the same layout later.
(function () {
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var grid = document.querySelector('.cards[data-layout]');
    var page = grid ? grid.getAttribute('data-layout') : location.pathname;
    var saved = JSON.parse(localStorage.getItem('dash.layout.' + page + '.' + bp));
    if (!saved || typeof saved !== 'object') return;
    var all = document.querySelectorAll('.card[data-card]');
    var ids = [], i;
    for (i = 0; i < all.length; i++) ids.push(all[i].getAttribute('data-card'));
    var coll = Array.isArray(saved.collapsed) ? saved.collapsed : [];
    for (i = 0; i < all.length; i++) if (coll.indexOf(all[i].getAttribute('data-card')) >= 0) all[i].classList.add('collapsed');
    if (!grid) return;
    var cards = [], byId = {};
    for (i = 0; i < grid.children.length; i++) {
      var c = grid.children[i];
      if (c.classList.contains('card') && c.hasAttribute('data-card')) { cards.push(c); byId[c.getAttribute('data-card')] = c; }
    }
    var gids = cards.map(function (c) { return c.getAttribute('data-card'); });
    var order = (Array.isArray(saved.order) ? saved.order : []).filter(function (id) { return gids.indexOf(id) >= 0; });
    gids.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    order.forEach(function (id) { grid.appendChild(byId[id]); });
    cards.forEach(function (c) {
      var id = c.getAttribute('data-card'), s = saved.span && saved.span[id], h = saved.h && saved.h[id];
      var okS = bp !== 'phone' && Number.isInteger(s) && s >= 1 && s <= 12;
      var okH = bp !== 'phone' && Number.isInteger(h) && h >= 40 && h <= 4000;
      if (bp === 'desktop' && okS) c.style.setProperty('--span', s);
      if (bp === 'tablet' && okS) c.style.setProperty('--tspan', s);
      if (okH) { c.style.setProperty('--h', h + 'px'); c.style.alignSelf = 'start'; }
    });
  } catch (e) { /* no saved layout: the server order stands */ }
})();
