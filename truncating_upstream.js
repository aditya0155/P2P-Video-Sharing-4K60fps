const http = require('http');

// Upstream that answers with headers and a partial body, then destroys the
// socket mid-response — a MediaMTX restart landing inside a status probe or a
// WHEP handshake.
//
// This has to be a Node server, not a Python one. With a Python upstream the
// socket failure surfaces on the proxy's REQUEST object as well, so
// `proxyReq.on('error')` handles it and the response is cut regardless of
// whether `proxyRes` is listened to — the case then cannot distinguish the
// two, and passes against the broken code. A Node upstream destroying its own
// socket reproduces the real condition, where only a handler on the RESPONSE
// stream can notice.
const port = Number(process.argv[2] || 0);
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
    res.write('{"items":[');
    setTimeout(() => { res.socket.destroy(); }, 150);
});
server.listen(port, '127.0.0.1', () => {
    process.stdout.write(String(server.address().port) + '\n');
});
