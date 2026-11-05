// Issue #552: if the stylesheet fails to load (server restarting or busy, a stale cached page), fetch it again with a growing delay.
// It never reloads the page, so it cannot loop or flicker, and it stops once the styles are in effect. Same-origin, sends nothing else.
(function () {
  var link = document.querySelector('link[rel=stylesheet][href^="/static/style.css"]');
  if (!link) return;
  var tries = 0, timer = null, pending = null;
  function styled() { try { return getComputedStyle(document.documentElement).getPropertyValue('--nav-h').trim() !== ''; } catch (e) { return true; } }
  function schedule() {
    if (timer !== null || pending) return;
    timer = setTimeout(retry, Math.min(30000, 1000 * Math.pow(2, tries)));
  }
  function retry() {
    timer = null;
    if (styled()) return;
    tries += 1;
    var next = document.createElement('link');
    next.rel = 'stylesheet'; next.href = '/static/style.css?r=' + tries;
    pending = next;
    next.addEventListener('load', function () { pending = null; if (styled()) { if (link.parentNode) link.parentNode.removeChild(link); link = next; } else schedule(); });
    next.addEventListener('error', function () { pending = null; if (next.parentNode) next.parentNode.removeChild(next); schedule(); });
    document.head.appendChild(next);
  }
  link.addEventListener('error', schedule);
  window.addEventListener('load', function () { if (!styled()) schedule(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && !styled()) { tries = 0; if (timer !== null) { clearTimeout(timer); timer = null; } schedule(); } });
  window.addEventListener('pageshow', function () { if (!styled()) schedule(); });
})();
