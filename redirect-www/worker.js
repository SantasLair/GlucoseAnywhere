// Sends www.glucoseanywhere.com to glucoseanywhere.com, keeping the path and query string.
// (A #fragment such as /#big is kept by the browser itself; it is never sent to a server.)
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = 'glucoseanywhere.com';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  },
};
