# Vitrine da cliente — falhas encontradas

Teste de 05/11/2026, no celular (375 px e Pixel 7), em duas frentes:
- a loja publicada `kailane-joias`, só com leitura (nenhum pedido ou carrinho foi gravado na loja real);
- 21 testes automáticos (`e2e/vitrine.spec.ts`) no modo demonstração.

| ID | Sev. | Falha | Situação |
|---|---|---|---|
| V-01 | S2 | Peças com tamanho/letra/signo não deixavam escolher a opção (50 dos 67 anéis, colares de letra, medalha de signo). O pedido chegava sem o tamanho. | Corrigido |
| V-02 | S2 | A loja desenhava as 813 peças de uma vez: página com 136 mil px de altura e ~4,8 s até aparecer no celular. | Corrigido (24 por vez + "Carregar mais") |
| V-03 | S3 | Fotos quebradas (8 peças): a Yampi trocou as fotos depois da importação de 20/10. | Corrigido (troca para a próxima foto ou desenho) · precisa reimportar |
| V-04 | S3 | "Novidades" aparecia duas vezes no menu. | Corrigido |
| V-05 | S3 | Banner do celular era cortado em quadrado: banner largo perdia as laterais ("RÉ…ACK", "ção de…alizados"). | Corrigido no envio; a revendedora precisa reenviar o banner |
| V-06 | S3 | "Mais Vendidos" mostrava as peças em ordem alfabética, não as mais vendidas. | Corrigido (ranking da Yampi na importação) |
| V-07 | S3 | Fotos pesadas: cada miniatura baixava a foto original de 1000 px. | Corrigido (miniatura de 400 px pelo CDN da Yampi, ~8× mais rápida) |
| V-08 | S4 | Acessibilidade: carrosséis e banners não recebiam foco pelo teclado (axe: scrollable-region-focusable). | Corrigido |

## Detalhes

**V-01** · Abrir "Anel Solitário A01" → Adicionar. *Esperado:* escolher tamanho. *Antes:* adicionava sem tamanho. Na Yampi, a peça tem os tamanhos 12 a 24, com alguns esgotados. *Agora:* a ficha mostra só os tamanhos à venda, não deixa adicionar sem escolher, o carrinho separa os tamanhos em linhas e a mensagem do WhatsApp sai como "1x Anel Solitário A01 — Tamanhos: 16". O botão rápido de carrinho em peça com tamanho abre a ficha. Testes F03-E2, F03-E3 e F04-E1.

**V-02** · Testado com 800 peças: antes, 800 cards na tela; agora, 24 cards e a loja abre na hora. Teste F01-E1.

**V-03** · `anel-3-coracoes-a05-18-…-large.jpg` retorna erro; a foto atual na Yampi é `…-20-6ada1f05c6008-large.jpg`. Teste F03-E4.

## A conferir (não reproduzido)
- Carrinho abandonado e pedido enviado gravando no painel da revendedora. Não testei na loja real para não criar cliente falsa no painel da Kailane.
- Link da loja compartilhado no WhatsApp não mostra a prévia com nome e logo da loja. A página é montada no navegador, e o WhatsApp não executa esse código.
