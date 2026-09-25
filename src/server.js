import http from "node:http";
import QRCode from "qrcode";

function unauthorized(response) {
  response.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Pareamento Prime Capital"'
  });
  response.end("Login necessário");
}

function pairingAuthorized(request) {
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
    return user === expectedUser && password === expectedPassword;
  } catch {
    return false;
  }
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="8">
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #07130e; color: #f5fbf7; font: 16px/1.5 system-ui, sans-serif; }
      main { width: min(100%, 520px); padding: 30px; border: 1px solid #214633; border-radius: 22px; background: #0d2117; text-align: center; box-shadow: 0 24px 80px #0008; }
      h1 { margin: 0 0 10px; font-size: 26px; }
      p { margin: 8px 0; color: #c7d8cd; }
      img { display: block; width: min(100%, 360px); margin: 24px auto; padding: 12px; border-radius: 16px; background: white; }
      .ok { color: #64e6a0; font-weight: 700; font-size: 20px; }
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
      response.end(htmlPage("Bot Prime Capital", "<h1>Bot Prime Capital</h1><p>Serviço em funcionamento.</p>"));
      return;
    }

    if (!pairingAuthorized(request)) {
      unauthorized(response);
      return;
    }

    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/html; charset=utf-8");

    if (state.connected) {
      response.end(htmlPage("WhatsApp conectado", "<h1>WhatsApp conectado</h1><p class=\"ok\">✓ Bot pronto</p><p>Você já pode fechar esta página.</p>"));
      return;
    }

    if (!state.qr) {
      response.end(htmlPage("Preparando QR Code", "<h1>Preparando QR Code…</h1><p>A página será atualizada automaticamente.</p>"));
      return;
    }

    const image = await QRCode.toDataURL(state.qr, { width: 420, margin: 2 });
    response.end(htmlPage(
      "Escanear QR Code",
      `<h1>Conectar WhatsApp</h1><p>No novo celular: <b>Configurações → Aparelhos conectados → Conectar aparelho</b>.</p><img src="${image}" alt="QR Code do WhatsApp"><p>O código muda automaticamente se expirar.</p>`
    ));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[web] Painel de pareamento ativo na porta ${port}`);
  });
}

