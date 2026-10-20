# Plataforma de lojas Veraneio

Três endereços no mesmo site:

| Endereço | Quem usa | O que tem |
|---|---|---|
| `seusite.com/nome-da-loja` | Cliente final | Só a vitrine: banners, peças, sacola, pedido pelo WhatsApp |
| `seusite.com/painel` | Revendedora (login próprio) | Acessos, pedidos, carrinhos abandonados, aparência, banners, margem |
| `seusite.com/adm` | Veraneio | Revendedoras, vendas, acessos, produtos |

A loja abre em **modo demonstração** enquanto o `config.js` estiver vazio (ou com `?demo` no endereço).

---

## Colocar no ar (uma vez)

**1. Criar o projeto no Firebase.** Recomendo um projeto novo, `veraneio-lojas`, separado do `veraneio-vendas`. As regras de segurança deste projeto substituiriam as regras do sistema de vendas se fossem publicadas no mesmo projeto.

No console do Firebase (console.firebase.google.com):
- Crie o projeto e ative o **plano Blaze**. As Cloud Functions exigem o Blaze; o uso desta plataforma fica dentro da cota gratuita na maioria dos meses.
- **Firestore Database** → Criar banco → local **southamerica-east1 (São Paulo)**.
- **Authentication** → Método de login → ative **E-mail/senha**.
- **Storage** → Começar.
- ⚙️ **Configurações do projeto** → Seus apps → **Web** (`</>`) → copie a configuração para `public/config.js`.

**2. Publicar.** No computador, com o Node.js instalado:

```bash
npm install -g firebase-tools
firebase login
cd veraneio-lojas
# se o ID do projeto não for "veraneio-lojas", troque no arquivo .firebaserc
cd functions && npm install && cd ..

# credenciais da Yampi (Yampi → Configurações → API). Cada comando pede o valor:
firebase functions:secrets:set YAMPI_TOKEN
firebase functions:secrets:set YAMPI_SECRET

firebase deploy
# no primeiro deploy ele pergunta YAMPI_ALIAS: digite o alias da sua loja na Yampi
```

**3. Criar o seu acesso de ADM.**
- Authentication → Usuários → **Adicionar usuário** (seu e-mail e uma senha).
- Copie o **UID** desse usuário.
- Firestore → **Iniciar coleção** `admins` → ID do documento = o UID → campo `nome` = `Jefferson`.
- Abra `seusite.web.app/adm` e entre.

**4. Domínio próprio (opcional).** Hosting → **Adicionar domínio personalizado**, por exemplo `lojas.veraneiosemijoias.com.br`. Depois, em Authentication → Configurações → **Domínios autorizados**, adicione o mesmo domínio.

---

## Uso do dia a dia

- **Produtos:** ADM → Produtos. O preço cadastrado é o de **atacado**. Ao salvar, todas as lojas são atualizadas em alguns segundos. Quando a Yampi estiver conectada, essa lista se preenche sozinha.
- **Nova revendedora:** ADM → Revendedoras → **+ Nova**. Ao criar, aparece uma mensagem pronta com o link para ela criar a senha e acessar o painel. É só enviar pelo WhatsApp.
- **Link expirou:** no cartão da revendedora, toque em **Acesso** para gerar outro.
- **Pausar loja:** tira o site do ar sem apagar nada.

---

## Como os dados ficam guardados

| Coleção | Conteúdo | Quem lê |
|---|---|---|
| `produtos/{id}` | Catálogo com preço de **atacado** | Somente usuários logados |
| `precos/{uid}` | Margem padrão, arredondamento e margem por peça | Revendedora dona + ADM |
| `catalogos/{uid}` | Catálogo da loja **já com o preço final**, gerado pelo servidor | Público |
| `lojas/{uid}` | Nome, logo, cor, banners, WhatsApp, aviso, frete, status | Público |
| `lojas/{uid}/dias/{data}` | Acessos e peças vistas por dia | Revendedora + ADM |
| `lojas/{uid}/leads/{id}` | Carrinhos (abandonados) e pedidos enviados | Revendedora + ADM |
| `slugs/{slug}` | Garante que cada endereço de loja seja único | Público |
| `admins/{uid}` | Quem acessa o ADM | — |

O preço de atacado **nunca vai para o navegador da cliente final**. A função `catalogoDaLoja` calcula o preço de cada peça com a margem da revendedora e publica só o valor final em `catalogos/{uid}`. A regra de cálculo fica em `functions/preco.js`; existe uma cópia em `painel.html` (`precoFinal`) para a prévia. Se mudar uma, mude a outra.

**Carrinho abandonado:** assim que a cliente final preenche nome e WhatsApp na sacola, o carrinho é salvo como `abandonado`. Ao tocar em **Finalizar pelo WhatsApp**, passa para `enviado`. No painel, a revendedora pode marcar um abandonado como `recuperado`.

---

## Produtos da Yampi

ADM → Produtos → **Importar da Yampi agora**. Depois disso, a sincronização roda sozinha a cada 6 horas (função `yampiAutomatico`).

| Vem da Yampi (atualiza sempre) | Fica com você no ADM (não é sobrescrito) |
|---|---|
| Nome, categoria, preço, fotos, descrição, ativo | Novidade, ordem na vitrine, esgotado, banho |

- O preço usado é o preço do SKU: o promocional, se houver; senão, o de venda. Esse é o valor de **atacado** da plataforma.
- O banho é sugerido pelo nome e pela descrição ("ródio", "ouro", "rosé"…) só na primeira importação. Depois, o que vale é o que você ajustar.
- Produto que sai ou é desativado na Yampi fica inativo aqui. Nada é apagado.
- Se der erro, a mensagem aparece no quadro "Yampi" do ADM. Os detalhes ficam em Firebase → Functions → Registros.

Para trocar as credenciais: rode `firebase functions:secrets:set YAMPI_TOKEN` de novo e depois `firebase deploy --only functions`.
