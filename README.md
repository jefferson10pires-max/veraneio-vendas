# Plataforma de lojas Veraneio

Projeto Firebase: **site-revendedoras-veraneio** (plano gratuito Spark).

| Endereço | Quem usa | O que tem |
|---|---|---|
| `site-revendedoras-veraneio.web.app/nome-da-loja` | Cliente final | A vitrine: banners, peças, carrinho, pedido pelo WhatsApp |
| `…/painel` | Revendedora (login próprio) | Acessos, pedidos, carrinhos abandonados, aparência, banners, margem, frete, barra do carrinho, rodapé |
| `…/adm` | Veraneio | Revendedoras, vendas, acessos, produtos, importação da Yampi |

A loja abre em modo demonstração com `?demo` no endereço.

## Publicar ou atualizar o site

No console do Firebase, abra o **Cloud Shell** (ícone `>_` no canto superior direito) e rode:

```bash
rm -rf veraneio-lojas && git clone -b lojas-revendedoras --depth 1 https://github.com/jefferson10pires-max/veraneio-vendas veraneio-lojas
cd veraneio-lojas && firebase deploy --project site-revendedoras-veraneio
```

## Primeiro acesso do ADM (uma vez)

1. Firebase → Authentication → Usuários → **Adicionar usuário**: cadastre o seu e-mail e uma senha.
2. Copie o **UID** desse usuário.
3. Firestore → **Iniciar coleção** `admins` → ID do documento = o UID → campo `nome` = `Jefferson`.
4. Entre em `/adm`.

## Dia a dia

- **Produtos:** ADM → Produtos → **Importar da Yampi agora**. Usa a API pública da loja `veraneio` e não precisa de token. Leva cerca de 2 minutos para ~850 peças. Clique de novo sempre que mudar preços ou cadastrar peças na Yampi.
  - Vem da Yampi e é sempre atualizado: nome, categoria, preço, fotos e descrição.
  - Fica com você no ADM e não é sobrescrito: novidade, ordem, esgotado e banho.
  - As categorias importadas ficam em `public/catalogo.js` (`YAMPI_CATEGORIAS`).
- **Nova revendedora:** ADM → Revendedoras → **+ Nova**. O login é criado e o Firebase envia um e-mail para ela criar a senha. Depois, mande a mensagem pronta pelo WhatsApp.
- **Esqueceu a senha:** no cartão da revendedora, toque em **Acesso** para enviar um novo e-mail.
- **Pausar loja:** tira o site do ar sem apagar nada.

## Como funciona sem servidor

- O ADM monta o catálogo de atacado (`atacado/p0, p1…`). Só usuários logados conseguem ler.
- Cada loja tem o seu catálogo público já com o preço final, em `catalogos/{uid}/partes/…`. Ele é publicado pelo painel quando a revendedora salva a margem, e pelo ADM depois de importar ou editar produtos. **O preço de atacado nunca vai para a cliente final.**
- Logo e banners ficam comprimidos no próprio banco (`lojas/{uid}.logo` e `banners/{uid}`, até 4 banners), sem usar o Storage, que é pago.
- A regra de preço está em `public/catalogo.js` (`precoFinal`).

Limite do plano grátis: 50 mil leituras e 20 mil gravações por dia. Uma visita na loja gasta cerca de 3 leituras.

A pasta `extras/` guarda a versão com Cloud Functions (plano Blaze): sincronização automática da Yampi a cada 6 horas e imagens no Storage. Ela não é publicada.
