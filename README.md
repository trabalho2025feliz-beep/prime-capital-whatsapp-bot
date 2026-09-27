# Bot de WhatsApp — Prime Capital

Bot de grupo que entrega no WhatsApp os mesmos relatórios do bot do Telegram e registra comprovantes dos grupos financeiros.

## Grupos monitorados

- `Relatórios Prime Capital` — comandos e relatórios do Try;
- `Entradas Prime Capital` — pagamentos de juros e quitações;
- `Saídas Prime Capital` — Pix de empréstimos/vendas liberados.

O mesmo número do bot pode acompanhar os três grupos. Os nomes podem ser alterados pelas variáveis `WHATSAPP_INCOMING_GROUP_NAME` e `WHATSAPP_OUTGOING_GROUP_NAME`. Para evitar ambiguidade, também é possível configurar os JIDs específicos.

## Envio de comprovantes

Envie o PDF ou a imagem com uma legenda no mesmo padrão:

```text
Cliente: Maria Souza | RP2 | Juros | R$ 250,00
```

Para quitação:

```text
Cliente: João Lima | RP4 | Quitação | R$ 800,00
```

Para saída:

```text
Cliente: Ana Paula | RP5 | Liberado | R$ 600,00
```

O bot lê PDF, JPG e PNG, identifica valor, banco, data e identificador Pix quando disponíveis, detecta divergência de valor e bloqueia comprovantes repetidos. Os registros ficam no volume persistente, sem guardar o arquivo original nem o texto bancário completo.

> “Comprovante lido” significa que o documento foi interpretado. Um PDF ou uma imagem pode ser falsificado; o status “confirmado” só deve ser usado depois da conferência no extrato bancário ou de uma futura integração oficial com o banco.

## Comandos

- `/atualizar` — relatório completo
- `/resumo` — resumo geral
- `/linhas` — desempenho das RP1 a RP5
- `/alertas` — ingressos sem classificação
- `/financeiro` — resumo de entradas e saídas do dia
- `/entradas` — resumo dos comprovantes de entrada
- `/saidas` — resumo dos comprovantes de saída
- `/pendentes` — comprovantes que precisam de revisão
- `/confirmar CÓDIGO` — confirma o movimento após conferência bancária
- `/status` — verifica a conexão
- `/ajuda` — mostra os comandos

O bot ignora conversas particulares e outros grupos. O grupo autorizado é definido por `WHATSAPP_GROUP_NAME` ou, com mais precisão, por `WHATSAPP_GROUP_JID`.

## Rotina automática

- relatório completo às 08h, 12h e 18h;
- consulta de alertas a cada duas horas, enviando mensagem somente quando houver alerta.
- resumo das entradas e saídas às 18h05.

O fuso é configurado por `TZ` e usa `America/Sao_Paulo` por padrão.

## Hospedagem

O serviço precisa ficar ligado continuamente e ter um volume persistente montado em `/data`. A sessão vinculada do WhatsApp fica em `/data/whatsapp-auth` e o livro financeiro fica em `/data/prime-capital-finance.json`; por isso ambos sobrevivem a reinicializações.

O QR Code aparece nos logs e também na rota protegida `/parear`. A rota exige o login definido em `PAIRING_USER` e `PAIRING_PASSWORD`.

## Variáveis obrigatórias

`REPORT_API_URL` deve apontar para o endpoint protegido do sistema de relatórios e `REPORT_API_SECRET` deve ter o mesmo valor nos dois serviços.

Variáveis financeiras opcionais:

- `WHATSAPP_INCOMING_GROUP_NAME` e `WHATSAPP_OUTGOING_GROUP_NAME`;
- `WHATSAPP_INCOMING_GROUP_JID` e `WHATSAPP_OUTGOING_GROUP_JID`;
- `FINANCE_WHATSAPP_NUMBERS` — números autorizados a usar `/confirmar`, separados por vírgula e com DDI;
- `LEDGER_API_SECRET` — ativa a API protegida para o painel (`/api/finance/summary` e `/api/finance/recent`);
- `MAX_RECEIPT_BYTES` — tamanho máximo do comprovante, 12 MB por padrão.

> Esta conexão usa a sessão Web do WhatsApp. Use o número separado dedicado ao bot, evite disparos em massa e mantenha uma pessoa como responsável pelo número.

## Ponte com o relatório atual

O arquivo `integration/api-whatsapp-report.js` deve ser publicado como `api/whatsapp-report.js` no projeto atual da Vercel. Ele reutiliza a consulta já testada do Try e exige `WHATSAPP_BOT_SECRET`, sem expor as credenciais do Try ao serviço do WhatsApp.
