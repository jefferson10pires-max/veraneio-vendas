# Conversas Veraneio — CRM de WhatsApp

CRM focado em **falar com a cliente**, ligado ao Firebase `veraneio-vendas` (mesmo login do sistema de vendas).
Cada número (Revenda e Varejo) pode ser conectado pela **API oficial** ou pela **API híbrida** (coexistência: o número continua funcionando no WhatsApp Business do celular).

## Arquivos

| Arquivo | O que é |
|---|---|
| `crm.html` | O CRM. Vai para o mesmo GitHub Pages do sistema de vendas. `crm.html?demo=1` abre com dados de exemplo. |
| `crm-demo.html` | Versão só demonstração (publicada como página para testar). |
| `functions/` | Servidor: webhook da Meta, envio, conexão, disparos, atribuição de venda, catálogo Yampi. |
| `functions/test/` | 17 testes automáticos (`npm test`). |
| `firebase/` | `firebase.json` (codebase `whatsapp`, não mexe na função `superfrete`), regras e índices. |

## O que tem

- **Conversas**: fila "Aguardando resposta" com quem espera há mais tempo primeiro e o tempo de espera; não lidas, minhas, sem responsável, importantes, encerradas.
- Chat com foto, áudio, vídeo, documento, resposta citada, status ✓ ✓✓ lida e falha com "tentar de novo".
- Aviso da **janela de 24h** com contagem; fechada → só modelo aprovado, com prévia e custo.
- **Respostas rápidas** com `/` (nome da cliente preenchido sozinho), **nota interna**, rascunho por conversa.
- **Sugestões pelo contexto**: rastreio do último pedido, link do carrinho do Quiz, Pix, mandar peça.
- **Catálogo Yampi no chat**: escolhe as peças e manda foto + preço.
- Painel da cliente: compras do sistema de vendas, segmento (Campeã, Fiel, Em risco…), etapa do Quiz, etiquetas, anotações, "recebe disparos".
- **Busca em todo o histórico** (Ctrl+K) que abre a conversa na mensagem.
- "✓ Não precisa responder" tira a conversa da fila sem encerrar.
- Mensagens mandadas **pelo celular** (híbrida) aparecem marcadas "Pelo celular"; histórico importado aparece como "Importada do celular".
- **Disparos**: público pelos segmentos de vendas, quem parou no Quiz ou números colados; tira quem pediu para sair; custo estimado; teste para o seu número; envio aos poucos; lidas, respostas, pedidos e receita atribuída.
- Opt-out automático: "SAIR", "não quero receber" ou o botão do modelo.
- Funciona no celular (lista → conversa → dados da cliente).

## Como colocar no ar

1. **Meta**: em developers.facebook.com crie um app (tipo Negócios), adicione **WhatsApp** e **Login do Facebook para Empresas**. Crie uma configuração de *Cadastro incorporado* e anote o **Configuration ID**.
   - Para a **híbrida**, a Meta só libera a coexistência pelo Cadastro incorporado. Confirme no painel da Meta se seu app tem acesso; se não tiver, dá para entrar por um parceiro oficial (BSP).
2. **Segredos das functions** (na pasta `firebase/`):
   ```
   firebase functions:secrets:set META_APP_SECRET
   firebase functions:secrets:set WA_VERIFY_TOKEN      # invente uma senha
   firebase functions:secrets:set YAMPI_TOKEN
   firebase functions:secrets:set YAMPI_SECRET
   ```
   e crie `functions/.env` com `META_APP_ID=...` e `YAMPI_ALIAS=...`.
3. **Publicar**: `cd firebase && firebase deploy --only functions:whatsapp,firestore`
4. **Webhook na Meta**: URL `https://southamerica-east1-veraneio-vendas.cloudfunctions.net/waWebhook`, token = o `WA_VERIFY_TOKEN`. Assine os campos `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `phone_number_quality_update`, `message_template_status_update`. **Faça isso antes de conectar a híbrida**: o histórico chega uma vez só.
5. **Regras**: o `firebase/firestore.rules` já inclui as regras do sistema de vendas + as do WhatsApp. ⚠️ O card "Segurança" do sistema de vendas gera regras sem as do WhatsApp; o catch-all dele deixaria as conversas abertas. Atualize o `FIRESTORE_RULES` do `index.html` com este arquivo (posso fazer isso no repositório).
6. **Storage** — acrescente:
   ```
   match /wa_out/{conv}/{file} { allow write: if request.auth != null && request.resource.size < 100 * 1024 * 1024; allow read: if request.auth != null; }
   match /wa_in/{all=**} { allow read: if request.auth != null; allow write: if false; }
   ```
7. Suba `crm.html` no GitHub Pages, entre como gestor → **Conexões** → preencha App ID e Configuration ID → **Conectar** no número.

## Testes feitos (29/10/2026)

**Servidor — 17/17 passando** (`npm test`, Firestore em memória + Meta simulada): assinatura do webhook; mensagem com foto baixada para o Storage; número sem o 9 cai na mesma conversa; webhook repetido não duplica; eco do celular; importação do histórico (encerradas, sem contar não lidas, nome da agenda); envio com janela aberta, bloqueio sem janela, erro da Meta virando mensagem com falha; status que não volta atrás; conexão híbrida pedindo contatos + histórico; só gestor conecta e dispara; disparo tirando duplicados e quem saiu; fila; resposta e opt-out contados na campanha; venda atribuída uma vez só.

**Tela — Playwright, computador (1400px) e celular (390px)**, no modo demonstração e com Firebase simulado.

Bugs achados e corrigidos:
1. Resposta rápida: Enter não aplicava o texto e o segundo Enter mandava "/pi" para a cliente.
2. Etiqueta nova não aparecia enquanto o campo estava em foco.
3. Aviso de janela dizia "faz mais de 24h que ela escreveu" para quem nunca escreveu.
4. Celular: cabeçalho do chat estourava (nome sumia, botões fora da tela); responsável e importante foram para o painel da cliente.
5. Celular: o painel da cliente cobria a tela sem jeito de fechar.
6. Chat não ficava no fim quando fotos carregavam.
7. Faixa de demonstração bloqueava toques.
8. "1 dias" → "ontem".
9. Confirmações usavam `confirm()`/`prompt()` do navegador; agora são na própria tela.
10. Servidor: transação lia depois de gravar (o Firestore recusa) e a resposta de campanha não achava o destinatário quando o número vinha sem o 9.

## A conferir na conexão real

- Formato exato dos eventos `history`, `smb_message_echoes` e `smb_app_state_sync` (escritos pela documentação pública; o teste usa o mesmo formato).
- Endereço e campos da API da Yampi no catálogo.
- Limite de envio da híbrida (a Meta pode ser mais restritiva que na oficial).

## Atualização 30/10 — Yampi, recorrência, descontos e frete

- **Pedidos da Yampi** entram no CRM pela função `waYampiSync` (a cada hora, revisa os últimos 10 dias) e pelo botão **Conexões › Pedidos da Yampi › Importar agora** (até 12 meses). Ficam em `yampi_orders`. Usa os mesmos segredos `YAMPI_ALIAS`, `YAMPI_TOKEN`, `YAMPI_SECRET`.
- Pedido com o mesmo nº Yampi no sistema de vendas conta uma vez só. Pedido "Aguardando pagamento" ou "Cancelado" não conta.
- **Indicadores** agora tem 3 abas e período livre (7/30/90 dias, 12 meses ou **Escolher datas**, com atalhos "Este mês", "Mês passado" e "Este ano"):
  - *Visão geral*
  - *Compras recorrentes*: receita/pedidos/clientes recorrentes, intervalo entre compras, gráfico recorrentes × novas, lista pesquisável e "Deviam ter voltado", com disparo direto.
  - *Descontos e frete*: cupons (por código), promoções do site, descontos do WhatsApp e **frete por mês** (padrão R$ 15,75: quanto as clientes pagaram, desconto dado, pago acima do padrão, desconto líquido, fretes grátis, média paga). O frete padrão é editável na própria tela.
- **Regras do Firestore**: publique `firebase/firestore.rules` (corrige a leitura pública dos leads do quiz — ver `replica/bugs.md`, B01).
- **Testes**: `npm i && npx playwright test` (27 testes de tela, computador e celular, com acessibilidade) e `cd functions && npm test` (21 testes do servidor). Plano em `replica/test-plan.md`, bugs em `replica/bugs.md`.
