// Applies a saved light/dark choice before the first paint, so light-mode users don't see a dark flash.
// With no saved choice (Auto) the stylesheet follows the device's own setting. This has to be a plain
// script in <head>: the page's Content-Security-Policy doesn't allow inline scripts.
(function () {
  // One address only: the www copy would have its own separate saved data, and the Google and Microsoft sign-in
  // return addresses are registered for the bare domain. (redirect-www/ does the same at the edge if it is deployed.)
  if (location.hostname === 'www.glucoseanywhere.com') {
    location.replace('https://glucoseanywhere.com' + location.pathname + location.search + location.hash);
    return;
  }
  try {
    var prefs = JSON.parse(localStorage.getItem('ga.prefs') || '{}');
    if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.setAttribute('data-theme', prefs.theme);
  } catch (e) { /* storage unavailable: stay on Auto */ }
})();
