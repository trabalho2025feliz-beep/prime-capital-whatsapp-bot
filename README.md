# Bot de WhatsApp — Prime Capital

Bot de grupo que entrega no WhatsApp os mesmos relatórios do bot do Telegram.

## Comandos

- `/atualizar` — relatório completo
- `/resumo` — resumo geral
- `/linhas` — desempenho das RP1 a RP5
- `/alertas` — ingressos sem classificação
- `/status` — verifica a conexão
- `/ajuda` — mostra os comandos

O bot ignora conversas particulares e outros grupos. O grupo autorizado é definido por `WHATSAPP_GROUP_NAME` ou, com mais precisão, por `WHATSAPP_GROUP_JID`.

## Rotina automática

- relatório completo às 08h, 12h e 18h;
- consulta de alertas a cada duas horas, enviando mensagem somente quando houver alerta.

O fuso é configurado por `TZ` e usa `America/Sao_Paulo` por padrão.

## Hospedagem

O serviço precisa ficar ligado continuamente e ter um volume persistente montado em `/data`. A sessão vinculada do WhatsApp fica em `/data/whatsapp-auth`; por isso o QR Code não precisa ser lido a cada reinicialização.

O QR Code aparece nos logs e também na rota protegida `/parear`. A rota exige o login definido em `PAIRING_USER` e `PAIRING_PASSWORD`.

## Variáveis obrigatórias

Consulte `.env.example`. `REPORT_API_URL` deve apontar para o endpoint protegido do sistema de relatórios e `REPORT_API_SECRET` deve ter o mesmo valor nos dois serviços.

> Esta conexão usa a sessão Web do WhatsApp. Use o número separado dedicado ao bot, evite disparos em massa e mantenha uma pessoa como responsável pelo número.

## Ponte com o relatório atual

O arquivo `integration/api-whatsapp-report.js` deve ser publicado como `api/whatsapp-report.js` no projeto atual da Vercel. Ele reutiliza a consulta já testada do Try e exige `WHATSAPP_BOT_SECRET`, sem expor as credenciais do Try ao serviço do WhatsApp.
# prime-capital-whatsapp-bot
Bot de relatórios da Prime Capital para grupo no WhatsApp
