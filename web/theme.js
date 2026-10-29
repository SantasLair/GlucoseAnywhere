// Applies a saved light/dark choice before the first paint, so light-mode users don't see a dark flash.
// With no saved choice (Auto) the stylesheet follows the device's own setting. This has to be a plain
// script in <head>: the page's Content-Security-Policy doesn't allow inline scripts.
(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem('ga.prefs') || '{}');
    if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.setAttribute('data-theme', prefs.theme);
  } catch (e) { /* storage unavailable: stay on Auto */ }
})();
