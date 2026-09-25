import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

const runtimePairingToken = randomBytes(12).toString("base64url");

function unauthorized(response) {
  response.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Pareamento Prime Capital"'
  });
  response.end("Login necessário");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function pairingAuthorized(request, url) {
  if (safeEqual(url.searchParams.get("token"), runtimePairingToken)) return true;

  const expectedUser = process.env.PAIRING_USER;
  const expectedPassword = process.env.PAIRING_PASSWORD;
  if (!expectedUser || !expectedPassword) return false;

  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return safeEqual(user, expectedUser) && safeEqual(password, expectedPassword);
  } catch {
    return false;
  }
}

function htmlPage(title, body, refresh = false) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${refresh ? '<meta http-equiv="refresh" content="8">' : ""}
    <meta name="referrer" content="no-referrer">
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #07130e; color: #f5fbf7; font: 16px/1.5 system-ui, sans-serif; }
      main { width: min(100%, 520px); padding: 30px; border: 1px solid #214633; border-radius: 22px; background: #0d2117; text-align: center; box-shadow: 0 24px 80px #0008; }
      h1 { margin: 0 0 10px; font-size: 26px; }
      p { margin: 8px 0; color: #c7d8cd; }
      img { display: block; width: min(100%, 360px); margin: 24px auto; padding: 12px; border-radius: 16px; background: white; }
      .ok { color: #64e6a0; font-weight: 700; font-size: 20px; }
      form { display: grid; gap: 12px; margin-top: 24px; }
      input, button { width: 100%; min-height: 48px; border-radius: 12px; font: inherit; }
      input { border: 1px solid #37664e; padding: 0 14px; background: #07130e; color: white; }
      button { border: 0; background: #30c875; color: #04150b; font-weight: 800; cursor: pointer; }
    </style>
  </head>
  <body><main>${body}</main></body>
</html>`;
}

export function startServer(state) {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        ok: true,
        whatsapp: state.connected ? "connected" : state.qr ? "waiting_for_qr" : "starting"
      }));
      return;
    }

    if (url.pathname !== "/parear") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(htmlPage("Bot Prime Capital", [
        "<h1>Conectar WhatsApp</h1>",
        "<p>Digite o código de pareamento exibido nos logs do Railway.</p>",
        '<form action="/parear" method="get">',
        '<input name="token" autocomplete="one-time-code" placeholder="Código de pareamento" required>',
        '<button type="submit">Mostrar QR Code</button>',
        "</form>"
      ].join("")));
      return;
    }

    if (!pairingAuthorized(request, url)) {
      response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      response.end(htmlPage("Código inválido", '<h1>Código inválido</h1><p>Volte à página inicial e confira o código mais recente nos logs.</p><p><a href="/" style="color:#64e6a0">Tentar novamente</a></p>'));
      return;
    }

    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/html; charset=utf-8");

    if (state.connected) {
      response.end(htmlPage("WhatsApp conectado", "<h1>WhatsApp conectado</h1><p class=\"ok\">✓ Bot pronto</p><p>Você já pode fechar esta página.</p>", true));
      return;
    }

    if (!state.qr) {
      response.end(htmlPage("Preparando QR Code", "<h1>Preparando QR Code…</h1><p>A página será atualizada automaticamente.</p>", true));
      return;
    }

    const image = await QRCode.toDataURL(state.qr, { width: 420, margin: 2 });
    response.end(htmlPage(
      "Escanear QR Code",
      `<h1>Conectar WhatsApp</h1><p>No novo celular: <b>Configurações → Aparelhos conectados → Conectar aparelho</b>.</p><img src="${image}" alt="QR Code do WhatsApp"><p>O código muda automaticamente se expirar.</p>`
    , true));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[web] Painel de pareamento ativo na porta ${port}`);
    console.log(`[web] Código de pareamento: ${runtimePairingToken}`);
  });
}
