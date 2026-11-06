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

## Novidades de 05/11 (pedido do Jefferson)
- **Pronta entrega:** categoria fixa no menu da loja, logo depois de "Todos os produtos", e carrossel no início. As peças ganham o selo verde "Pronta entrega" e a mensagem do WhatsApp avisa "✅ pronta entrega". No painel, em **Peças**, cada peça tem a chave "Pronta entrega" e há o filtro "★ Só pronta entrega". Testes F06.
- **Atualizar peças da Yampi:** traz peças novas, preços, tamanhos e fotos, e tira das lojas o que não está mais à venda ou visível no site. Roda sozinho ao abrir o ADM quando a última atualização tem mais de 12 h. Se a Yampi devolver bem menos peças que o normal, não altera nada. Agora também lê Semi joias OURO, Piercing, Porta-joias, Peças para iniciantes e Ofertas.
- **Baixar foto:** botão abaixo da foto na ficha da peça. Gera um JPEG pelo wsrv.nl. No celular abre "Salvar imagem / Compartilhar"; no computador baixa o arquivo. Se falhar, abre a foto para salvar segurando o dedo. Testes F07.

Testes automáticos: 25 de 25 passando.
