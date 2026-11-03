// Runs before the page is painted (issue #58): puts the saved navigation dock and rail state on <html> so there is no jump.
// Same-origin, sends nothing. The breakpoint edges and dock names mirror logic.mjs (a test keeps them identical).
(function () {
  // Times are hidden (space kept) until app.js has put them in local time, so they do not change after the first draw; if the
  // script never runs they show again after 3 s (style.css: html.js time[data-local]:not(.lz)).
  document.documentElement.classList.add('js');
  setTimeout(function () { document.documentElement.classList.remove('js'); }, 3000);
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var d = JSON.parse(localStorage.getItem('dash.dock.' + bp));
    var docks = ['top', 'bottom', 'left', 'right'];
    document.documentElement.dataset.dock = bp === 'phone' ? 'bottom' : docks.indexOf(d) >= 0 ? d : 'top';
    if (JSON.parse(localStorage.getItem('dash.navrail')) === true) document.documentElement.dataset.rail = 'collapsed';
  } catch (e) { document.documentElement.dataset.dock = 'top'; }
})();
