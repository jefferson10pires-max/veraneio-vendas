// Servidor local para os testes: serve public/ com as mesmas regras do firebase.json
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const raiz = path.resolve("public"), porta = Number(process.env.PORT || 5055);
const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/painel") p = "/painel.html"; else if (p === "/adm") p = "/adm.html";
  let f = path.join(raiz, p);
  if (!f.startsWith(raiz) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(raiz, "loja.html");
  res.writeHead(200, { "content-type": tipos[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(porta, () => console.log("servindo em http://localhost:" + porta));
