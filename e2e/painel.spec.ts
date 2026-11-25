/**
 * Testes do painel da revendedora (/painel) e do ADM (/adm), no celular, com Firebase simulado
 * (e2e/fake-firebase.js entra no lugar dos módulos do gstatic). Nada toca no Firebase real.
 */
import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";

const FAKE = fs.readFileSync("e2e/fake-firebase.js", "utf8");
const FOTO = "https://images.yampi.me/assets/stores/veraneio/uploads/images/peca-large.jpg";
const CATS = ["Anéis", "Brincos", "Colares", "Pulseiras"];
const atacado = (n: number) => Array.from({ length: n }, (_, i) => ({ id: "y" + i, nome: `Peça ${i}`, cat: CATS[i % 4], banho: "Ouro 18k", desc: "", fotos: [FOTO], novo: false, ordem: 999, preco: 20 + (i % 30) }));

function seed(n = 800, extra: Record<string, any> = {}) {
  const at = atacado(n), d: Record<string, any> = {};
  for (let i = 0; i * 250 < at.length; i++) d["atacado/p" + i] = { itens: at.slice(i * 250, i * 250 + 250) };
  d["lojas/u1"] = { nome: "Kailane Joias", slug: "kailane-joias", cor: "#043034", status: "ativa", whats: "22999990000", frete: 199, freteRegra: "acima" };
  d["precos/u1"] = { margem: 100, arred: "90", over: {} };
  d["slugs/kailane-joias"] = { uid: "u1" };
  d["admins/adm1"] = { nome: "Jefferson" };
  d["contas/u1"] = { email: "rev@teste.com" };
  d["planos/u1"] = { plano: "assinante", primeiroAcesso: { __ts: Date.UTC(2026, 9, 1) } }; // padrão: tudo liberado
  for (const p of at.slice(0, 30)) d["produtos/" + p.id] = { ...p, yampiId: p.id.slice(1), ativo: true, origem: "yampi" };
  return { ...d, ...extra };
}
const USERS = { "rev@teste.com": { senha: "senha123", uid: "u1" }, "adm@teste.com": { senha: "senha123", uid: "adm1" } };

/* Cada teste grava o que o app escreveu no banco simulado; o arquivo é reproduzido no emulador
   com as regras reais (e2e/regras.test.mjs, R99), para pegar gravações que as regras recusariam. */
const GRAVADAS: any[] = [];
test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed") return;
  try {
    const r = await page.evaluate(() => ({ seed: (window as any).__FAKE_SEED || null, log: JSON.parse(localStorage.getItem("fake:log") || "[]") }));
    if (r.seed && r.log.length) { const s: any = {}; for (const k in r.seed) if (!k.startsWith("atacado/")) s[k] = r.seed[k]; GRAVADAS.push({ teste: info.title, seed: s, log: r.log }); }
  } catch (e) {}
});
test.afterAll(() => { if (GRAVADAS.length) fs.writeFileSync("e2e/escritas-gravadas.json", JSON.stringify(GRAVADAS)); });

async function preparar(page: Page, o: { seed?: any; delay?: any; falha?: string } = {}) {
  const erros: string[] = [];
  page.on("pageerror", (e) => erros.push(String(e)));
  await page.route(/gstatic\.com\/firebasejs\//, (r) => r.fulfill({ contentType: "text/javascript", body: FAKE }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.route(/images\.yampi\.(me|io)|api\.dooki/, (r) => r.abort());
  await page.addInitScript(([s, u, d, f]) => {
    (window as any).__FAKE_SEED = s; (window as any).__FAKE_USERS = u; (window as any).__FAKE_DELAY = d;
    if (f) (window as any).__FAKE_FALHA = new RegExp(f as string);
    if (!sessionStorage.getItem("limpo")) { localStorage.clear(); sessionStorage.setItem("limpo", "1"); }
  }, [o.seed || seed(), USERS, o.delay || {}, o.falha || ""] as const);
  return erros;
}
/* as mudanças da revendedora ficam em rascunho; só vão para a loja ao tocar em "Publicar atualização" */
async function publicar(page: Page) {
  await expect(page.locator("#pubBtn")).toBeVisible({ timeout: 6000 });
  await page.locator("#pubBtn").click();
  await expect(page.locator("#toast")).toContainText("Loja atualizada", { timeout: 10000 });
  await expect(page.locator("#pubbar")).toBeHidden();
}
async function entrar(page: Page, email = "rev@teste.com", url = "/painel") {
  await page.goto(url);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("senha123");
  await page.getByRole("button", { name: "Entrar" }).click();
}
const db = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("fake:db") || "{}"));
const aba = (page: Page, nome: string) => page.locator("#nav").getByRole("button", { name: nome, exact: true });

test.describe("P01 entrar e continuar no painel", () => {
  test("P01-H1 entra e abre no Início", async ({ page }) => {
    const erros = await preparar(page);
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    expect(erros).toEqual([]);
  });

  test("P01-E1 recarregar a página não volta para a aba de peças/preços", async ({ page }) => {
    await preparar(page);
    await entrar(page);
    await aba(page, "Preços").click();
    await expect(page.getByRole("heading", { name: /Preços/ })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    expect(page.url()).not.toContain("#precos");
    await expect(aba(page, "Início")).toHaveAttribute("aria-current", "true");
  });

  test("P01-E2 trocar de aba antes de carregar não mostra a aba antiga", async ({ page }) => {
    await preparar(page, { delay: { atacado: 1200 } });
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    await aba(page, "Preços").click();
    await aba(page, "Pedidos").click();
    await page.waitForTimeout(1600);
    await expect(page.getByRole("heading", { name: "Pedidos" })).toBeVisible();
    await expect(page.locator("#fM")).toHaveCount(0);
  });

  test("P01-E3 se o carregamento falhar, mostra 'Tentar de novo' e não prende na tela de login", async ({ page }) => {
    await preparar(page, { falha: "^precos/" });
    await entrar(page);
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible();
    await expect(page.getByLabel("Senha")).toHaveCount(0);
    await page.evaluate(() => { (window as any).__FAKE_FALHA = null; });
    await page.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(page.getByText("Link da sua loja")).toBeVisible();
  });

  test("P01-E4 entrar no ADM com outra conta não desconecta o painel", async ({ page, context }) => {
    await preparar(page);
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    const adm = await context.newPage();
    await adm.route(/gstatic\.com\/firebasejs\//, (r) => r.fulfill({ contentType: "text/javascript", body: FAKE }));
    await adm.route(/fonts\.|images\.yampi|api\.dooki/, (r) => r.abort());
    await adm.addInitScript((u) => { (window as any).__FAKE_USERS = u; }, USERS);
    await entrar(adm, "rev@teste.com", "/adm");
    await expect(adm.getByText(/Esta conta não tem acesso ao ADM/)).toBeVisible();
    await page.reload();
    await expect(page.getByText("Link da sua loja")).toBeVisible();
  });

  test("P01-E5 miniaturas do painel são leves (CDN), não a foto original", async ({ page }) => {
    await preparar(page);
    await entrar(page);
    await aba(page, "Peças").click();
    const src = await page.locator(".pr .th img").first().getAttribute("src");
    expect(src).toContain("images.yampi.io/unsafe/fit-in/");
  });
});

test.describe("P02 aba Peças: pronta entrega e tirar do site", () => {
  test("P02-H1 marcar pronta entrega publica na loja com o selo", async ({ page }) => {
    await preparar(page);
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("switch", { name: "Pronta entrega: Peça 1", exact: true }).check();
    await publicar(page);
    const d = await db(page);
    expect(d["precos/u1"].pronta).toEqual(["y1"]);
    const item = d["catalogos/u1/partes/p0"].itens.find((x: any) => x.id === "y1");
    expect(item.pronta).toBe(true);
  });

  test("P02-H2 tirar uma peça do site some do catálogo público e volta ao religar", async ({ page }) => {
    await preparar(page);
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 2");
    await page.getByRole("switch", { name: "No site: Peça 2", exact: true }).uncheck();
    await publicar(page);
    let d = await db(page);
    const todos = () => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
    expect(todos().some((x: any) => x.id === "y2")).toBe(false);
    expect(todos().length).toBe(799);
    await page.getByRole("button", { name: /Fora do site/ }).click();
    await expect(page.locator(".pr")).toHaveCount(1);
    await page.getByRole("switch", { name: "No site: Peça 2", exact: true }).check();
    await publicar(page);
    d = await db(page);
    expect(todos().some((x: any) => x.id === "y2")).toBe(true);
  });

  test("P02-H3 ação em massa: pronta entrega na categoria inteira", async ({ page }) => {
    await preparar(page);
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByLabel("Categoria").selectOption("Brincos");
    await page.getByRole("button", { name: /Marcar todas \(200\) como pronta entrega/ }).click();
    await page.getByRole("button", { name: /Toque de novo/ }).click();
    await publicar(page);
    expect((await db(page))["precos/u1"].pronta.length).toBe(200);
    await page.getByRole("button", { name: /Pronta entrega \(200\)/ }).click();
    await expect(page.locator(".pr").first()).toContainText("Brincos");
  });

  test("P02-E1 peça fora do site não pode ficar como pronta entrega", async ({ page }) => {
    await preparar(page);
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 3");
    await page.getByRole("switch", { name: "Pronta entrega: Peça 3", exact: true }).check();
    await page.getByRole("switch", { name: "No site: Peça 3", exact: true }).uncheck();
    await expect(page.getByRole("switch", { name: "Pronta entrega: Peça 3", exact: true })).toBeDisabled();
    await publicar(page);
    const pr = (await db(page))["precos/u1"];
    expect(pr.ocultas).toEqual(["y3"]);
    expect(pr.pronta).toEqual([]);
  });

  test("P02-E2 mudar a margem continua funcionando e não apaga pronta entrega", async ({ page }) => {
    await preparar(page, { seed: seed(800, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y5"], ocultas: ["y6"] } }) });
    await entrar(page);
    await aba(page, "Preços").click();
    await page.locator("#fM").fill("50");
    await publicar(page);
    const pr = (await db(page))["precos/u1"];
    expect(pr.margem).toBe(50);
    expect(pr.pronta).toEqual(["y5"]);
    expect(pr.ocultas).toEqual(["y6"]);
  });
});

test.describe("P03 ADM", () => {
  test("P03-H1 ADM entra e a republicação respeita as peças que a revendedora tirou do site", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y1"], ocultas: ["y2"] }, "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await expect(page.getByText("Lojas ativas")).toBeVisible();
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.getByText("Catálogo atualizado em todas as lojas")).toBeVisible({ timeout: 8000 });
    const d = await db(page), itens = d["catalogos/u1/partes/p0"].itens;
    expect(itens.some((x: any) => x.id === "y2")).toBe(false);
    expect(itens.find((x: any) => x.id === "y1").pronta).toBe(true);
    expect(erros).toEqual([]);
  });
});

test.describe("P04 modo de trabalho", () => {
  test("P04-H1 'Só pronta entrega' publica só as peças marcadas e volta ao catálogo todo", async ({ page }) => {
    await preparar(page, { seed: seed(800, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y1", "y7"], ocultas: ["y7"] } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.locator("#modo [data-modo='pronta']").click();
    await publicar(page);
    let d = await db(page);
    const ids = () => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens.map((x: any) => x.id));
    expect(ids()).toEqual(["y1"]);
    expect(d["lojas/u1"].modo).toBe("pronta");
    expect(d["precos/u1"].modo).toBe("pronta");
    await expect(page.locator("#modoHint")).toContainText("só 1 peça de pronta entrega");
    await expect(page.getByRole("switch", { name: "No site: Peça 1", exact: true })).toHaveCount(0);
    // marcar outra peça (mesmo que antes estivesse fora do site) coloca ela na loja
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 7");
    await page.getByRole("switch", { name: "Pronta entrega: Peça 7", exact: true }).check();
    await publicar(page);
    d = await db(page);
    expect(ids().sort()).toEqual(["y1", "y7"]);
    await page.locator("#modo [data-modo='catalogo']").click();
    await publicar(page);
    d = await db(page);
    expect(ids().length).toBe(800);
    expect(d["lojas/u1"].modo).toBe("catalogo");
  });
});

test.describe("P05 promoções da Veraneio e preço travado", () => {
  // Yampi simulada: 30 anéis; y1 em promoção (21 → 15); y2 em promoção (22 → 10) mas com preço travado no ADM em R$ 99
  const yampi = Array.from({ length: 30 }, (_, i) => {
    const promo = i === 1 ? [15, 21] : i === 2 ? [10, 22] : null;
    const price = promo ? promo[0] : 20 + i, sale = promo ? promo[1] : 20 + i;
    return { id: i, name: `Peça ${i}`, slug: "p" + i, has_variations: false, blocked_sale: false,
      prices: { data: { price, price_sale: sale, price_discount: promo ? price : 0, has_promotion: !!promo } },
      images: { data: [{ url: "https://images.yampi.me/x.jpg" }] }, skus: { data: [] }, categories: { data: [{ name: "Anéis" }] } };
  });
  async function abrirAdm(page: Page, extra: Record<string, any> = {}) {
    const s = seed(30, { "sistema/yampi": { total: 30, novos: 0, em: { __ts: Date.now() } }, ...extra });
    s["produtos/y2"] = { ...s["produtos/y2"], preco: 99, precoTravado: true };
    await preparar(page, { seed: s });
    await page.unroute(/images\.yampi\.(me|io)|api\.dooki/);
    await page.route(/images\.yampi/, (r) => r.abort());
    await page.route(/api\.dooki\.com\.br/, (r) => {
      const u = new URL(r.request().url()), slug = u.searchParams.get("slug");
      if (u.pathname.endsWith("/count")) return r.fulfill({ json: { data: { total_pages: 1 } } });
      return r.fulfill({ json: { data: slug === "aneis" ? yampi : [], meta: { name: slug === "aneis" ? "Anéis" : slug } } });
    });
    await entrar(page, "adm@teste.com", "/adm");
    await expect(page.getByText("Lojas ativas")).toBeVisible();
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
  }
  const importar = async (page: Page) => {
    const antes = (await db(page))["sistema/yampi"]?.em?.__ts;
    await page.getByRole("button", { name: /Atualizar peças da Yampi|Tentar de novo/ }).click();
    await expect.poll(async () => (await db(page))["sistema/yampi"]?.em?.__ts, { timeout: 15000 }).not.toBe(antes);
    await expect(page.locator("#ysTxt")).toContainText("Última atualização", { timeout: 15000 });
    await expect(page.getByRole("button", { name: "Atualizar peças da Yampi" })).toBeEnabled({ timeout: 15000 });
  };
  const preco = (d: any, id: string) => d["produtos/" + id].preco;
  const naLoja = (d: any, id: string) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens).find((x: any) => x.id === id)?.preco;

  test("P05-H1 'Não repassar' (padrão): promoção não baixa o preço; peça travada não muda", async ({ page }) => {
    await abrirAdm(page);
    await expect(page.getByRole("button", { name: "Não repassar" })).toHaveAttribute("aria-pressed", "true");
    await importar(page);
    const d = await db(page);
    expect(preco(d, "y0")).toBe(20);
    expect(preco(d, "y1")).toBe(21);          // preço cheio, não os R$ 15 da promoção
    expect(preco(d, "y2")).toBe(99);          // travado
    expect(d["produtos/y1"].promoYampi).toBe(15);
    expect(naLoja(d, "y1")).toBe(42.9);       // 21 + 100% → 42,90
    expect(naLoja(d, "y2")).toBe(198.9);
    await expect(page.locator("#ysTxt")).toContainText("2 em promoção na Veraneio (não repassadas)");
    await expect(page.locator("#ysTxt")).toContainText("1 com preço travado");
    await expect(page.locator(".prow", { hasText: "Peça 1" }).first()).toContainText("Promo Veraneio R$ 15,00");
  });

  test("P05-H2 'Repassar': promoção baixa o preço nas lojas, peça travada continua igual", async ({ page }) => {
    await abrirAdm(page);
    await page.getByRole("button", { name: "Repassar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Repassar", exact: true })).toHaveAttribute("aria-pressed", "true");
    await importar(page);
    const d = await db(page);
    expect(d["sistema/config"].promo).toBe("sim");
    expect(preco(d, "y1")).toBe(15);
    expect(preco(d, "y2")).toBe(99);
    expect(naLoja(d, "y1")).toBe(30.9);
  });

  test("E01-H1 peça que a revendedora tirou do site ou excluiu não volta quando o estoque da Yampi é atualizado", async ({ page }) => {
    // revendedora tira y3 do site e exclui y4 pelo painel; depois o ADM atualiza as peças da Yampi
    await abrirAdm(page);
    await page.goto("/painel");
    await page.getByLabel("E-mail").fill("rev@teste.com"); await page.getByLabel("Senha").fill("senha123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.locator("#nav").getByRole("button", { name: "Peças", exact: true }).click();
    await page.getByRole("switch", { name: "No site: Peça 3", exact: true }).uncheck();
    await page.getByRole("button", { name: /Editar peça: Peça 4$/ }).click();
    await page.getByRole("button", { name: "Excluir da minha loja" }).click();
    await page.getByRole("button", { name: "Toque de novo para excluir" }).click();
    await publicar(page);
    await expect.poll(async () => (await db(page))["precos/u1"]?.excluidas, { timeout: 10000 }).toEqual(["y4"]);
    expect((await db(page))["precos/u1"].ocultas).toEqual(expect.arrayContaining(["y3", "y4"]));
    await page.goto("/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await importar(page);
    const d = await db(page);
    expect(naLoja(d, "y3")).toBeUndefined();
    expect(naLoja(d, "y4")).toBeUndefined();
    expect(naLoja(d, "y5")).toBeDefined();
    expect(d["precos/u1"].ocultas).toEqual(expect.arrayContaining(["y3", "y4"]));
    expect(d["precos/u1"].excluidas).toEqual(["y4"]);
  });

  test("E01-H3 mudança não publicada não vai para a loja, nem quando o ADM atualiza o estoque", async ({ page }) => {
    await abrirAdm(page, { "lojas/u1/proprios/rX": { nome: "Colar Novo", cat: "Colares", preco: 90, criadoEm: { __ts: Date.now() } },
      "precos/u1": { margem: 100, arred: "90", over: {}, atualizadoEm: { __ts: Date.now() - 864e5 } } });
    await page.goto("/painel");
    await page.getByLabel("E-mail").fill("rev@teste.com"); await page.getByLabel("Senha").fill("senha123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.locator("#nav").getByRole("button", { name: "Peças", exact: true }).click();
    await page.getByRole("switch", { name: "No site: Peça 3", exact: true }).uncheck();
    await expect(page.locator("#pubbar")).toBeVisible();
    await expect.poll(async () => (await db(page))["rascunhos/u1/docs/precos"]?.ocultas, { timeout: 8000 }).toEqual(["y3"]);
    await page.goto("/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await importar(page);
    let d = await db(page);
    expect(naLoja(d, "y3")).toBeDefined();                // rascunho não vazou
    expect(naLoja(d, "rX")).toBeUndefined();              // peça própria não publicada também não
    // ao publicar, a mudança vai e o rascunho some
    await page.goto("/painel");
    await publicar(page);
    d = await db(page);
    expect(naLoja(d, "y3")).toBeUndefined();
    expect(naLoja(d, "rX")).toBe(90);
    expect(Object.keys(d).filter((k) => k.startsWith("rascunhos/"))).toEqual([]);
  });

  test("E01-H2 peça que o ADM desativou ou excluiu continua fora depois da atualização da Yampi", async ({ page }) => {
    await abrirAdm(page);
    await page.locator(".prow", { hasText: "Peça 7" }).first().getByRole("button", { name: "Desativar" }).click();
    await expect.poll(async () => (await db(page))["produtos/y7"].ativo).toBe(false);
    await page.locator(".prow", { hasText: "Peça 8" }).first().getByRole("button", { name: "Excluir" }).click();
    await page.locator(".prow", { hasText: "Peça 8" }).first().getByRole("button", { name: "Toque de novo para excluir" }).click();
    await expect.poll(async () => (await db(page))["produtos/y8"].excluido).toBe(true);
    await importar(page);
    const d = await db(page);
    expect([d["produtos/y7"].ativo, d["produtos/y8"].ativo, d["produtos/y8"].excluido]).toEqual([false, false, true]);
    expect(naLoja(d, "y7")).toBeUndefined();
    expect(naLoja(d, "y8")).toBeUndefined();
    expect(naLoja(d, "y9")).toBeDefined();
  });

  test("P05-H3 mudar o preço à mão trava a peça; destravar volta a seguir a Yampi", async ({ page }) => {
    await abrirAdm(page);
    await page.locator(".prow", { hasText: "Peça 5" }).first().click();
    const trava = page.getByLabel(/Travar preço/);
    await expect(trava).not.toBeChecked();
    await page.getByLabel("Preço de atacado (R$)").fill("33");
    await expect(trava).toBeChecked();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Produto salvo")).toBeVisible();
    await importar(page);
    let d = await db(page);
    expect(preco(d, "y5")).toBe(33);
    await page.locator(".prow", { hasText: "Peça 5" }).first().click();
    await page.getByLabel(/Travar preço/).uncheck();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Produto salvo")).toBeVisible();
    await importar(page);
    d = await db(page);
    expect(preco(d, "y5")).toBe(25);
  });
});


test.describe("P06 foto própria e peça própria", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMDAwAAA7rAQBn6dO5QAAAABJRU5ErkJggg==", "base64");
  const arq = (n = "foto.png") => ({ name: n, mimeType: "image/png", buffer: PNG });
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);

  test("P06-H1 trocar a foto de uma peça da Veraneio e voltar à original", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Enviar foto", { exact: true }).setInputFiles(arq());
    await expect(page.locator("#ffG img")).toHaveCount(1);
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    let d = await db(page);
    expect(d[Object.keys(d).find((k) => k.startsWith("lojas/u1/fotos/y1~"))!].fotos[0]).toMatch(/^data:image\/jpeg/);
    expect(d["precos/u1"].fotos.y1.n).toBe(1);
    let it = catalogo(d).find((x: any) => x.id === "y1");
    expect(it.fp.n).toBe(1); expect(it.fotos).toEqual([]);
    await expect(page.locator(".pr", { hasText: "Peça 1" }).first()).toContainText("sua foto");
    // voltar às fotos da Veraneio
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await page.getByRole("button", { name: "Voltar às fotos da Veraneio" }).click();
    await publicar(page);
    d = await db(page);
    expect(d[Object.keys(d).find((k) => k.startsWith("lojas/u1/fotos/y1~"))!]).toBeUndefined();
    it = catalogo(d).find((x: any) => x.id === "y1");
    expect(it.fp).toBeUndefined(); expect(it.fotos.length).toBe(1);
    expect(erros).toEqual([]);
  });

  test("P06-H2 cadastrar peça própria, ela vai para a loja; mudar a margem não mexe nela; excluir tira da loja", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Nova peça" }).click();
    await page.getByLabel("Enviar foto da peça").setInputFiles([arq("a.png"), arq("b.png")]);
    await expect(page.locator("#npG img")).toHaveCount(2);
    await page.getByLabel("Nome da peça").fill("Brinco Lua Prata");
    await page.getByLabel("Categoria").last().fill("Brincos");
    await page.getByLabel("Preço de venda (R$)").fill("89,90");
    await page.locator("#vfN").fill("Tamanhos");
    await page.locator("#vfO").fill("P, M, M");
    await page.getByRole("button", { name: "Cadastrar peça" }).click();
    await publicar(page);
    let d = await db(page);
    const id = Object.keys(d).find((k) => k.startsWith("lojas/u1/proprios/"))!.split("/").pop()!;
    expect(d["lojas/u1/proprios/" + id]).toMatchObject({ nome: "Brinco Lua Prata", cat: "Brincos", preco: 89.9, fotosN: 2, var: { nome: "Tamanhos", ops: ["P", "M"] } });
    expect(d[Object.keys(d).find((k) => k.startsWith("lojas/u1/fotos/" + id + "~"))!].fotos.length).toBe(2);
    let it = catalogo(d)[0];
    expect(it).toMatchObject({ id, nome: "Brinco Lua Prata", preco: 89.9, proprio: true, pronta: true, fp: { n: 2 } });
    expect(d["precos/u1"].pronta).toContain(id);
    await expect(page.getByRole("button", { name: "Minhas peças (1)" })).toHaveAttribute("aria-pressed", "true");
    // margem nova: peça própria continua com o preço digitado e continua a pronta entrega
    await aba(page, "Preços").click();
    await page.locator("#fM").fill("50");
    await publicar(page);
    d = await db(page);
    it = catalogo(d).find((x: any) => x.id === id);
    expect(it.preco).toBe(89.9); expect(it.pronta).toBe(true);
    expect(d["precos/u1"].pronta).toContain(id);
    // excluir
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar Brinco Lua Prata" }).click();
    await page.getByRole("button", { name: "Excluir peça" }).click();
    await page.getByRole("button", { name: "Toque de novo para excluir" }).click();
    await publicar(page);
    d = await db(page);
    expect(d["lojas/u1/proprios/" + id]).toBeUndefined();
    expect(d["lojas/u1/fotos/" + id]).toBeUndefined();
    expect(catalogo(d).some((x: any) => x.id === id)).toBe(false);
    expect(erros).toEqual([]);
  });

  test("P06-E1 não cadastra sem nome ou sem preço", async ({ page }) => {
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Nova peça" }).click();
    await page.getByRole("button", { name: "Cadastrar peça" }).click();
    await expect(page.getByRole("alert")).toHaveText("Escreva o nome da peça.");
    await page.getByLabel("Nome da peça").fill("Anel");
    await page.getByRole("button", { name: "Cadastrar peça" }).click();
    await expect(page.getByRole("alert")).toHaveText("Coloque o preço de venda.");
    expect(Object.keys(await db(page)).some((k) => k.includes("/proprios/"))).toBe(false);
  });

  test("P06-E2 a republicação do ADM mantém as peças e fotos próprias", async ({ page }) => {
    const s = seed(40, { "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } },
      "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["rX"], ocultas: [], fotos: { y3: { n: 1, v: 5 } } },
      "lojas/u1/proprios/rX": { nome: "Colar Meu (rascunho)", cat: "Colares", preco: 999, fotosN: 1, fotosV: 9 },
      "catalogos/u1/partes/p0": { itens: [{ id: "rX", nome: "Colar Meu", cat: "Colares", preco: 120, proprio: true, pronta: true, fotos: [], fp: { n: 1, v: 7 }, ordem: 0 }] } });
    await preparar(page, { seed: s });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.getByText("Catálogo atualizado em todas as lojas")).toBeVisible({ timeout: 8000 });
    const it = catalogo(await db(page));
    expect(it[0]).toMatchObject({ id: "rX", preco: 120, proprio: true, pronta: true, fp: { n: 1, v: 7 } });
    expect(it.find((x: any) => x.id === "y3").fp).toEqual({ n: 1, v: 5 });
  });
});

import AxeBuilder from "@axe-core/playwright";
test.describe("P07 casos de borda: fotos e peças próprias, fontes", () => {
  const ARQ = "e2e/arquivos/";
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  async function abrirPecas(page: Page, extra: Record<string, any> = {}) {
    const erros = await preparar(page, { seed: seed(40, extra) });
    await entrar(page);
    await aba(page, "Peças").click();
    return erros;
  }

  test("P07-E1 foto grande do celular (4000×3000, 12 MB) é reduzida e salva", async ({ page }) => {
    await abrirPecas(page);
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await page.getByLabel("Enviar foto", { exact: true }).setInputFiles(ARQ + "grande.jpg");
    await expect(page.locator("#ffG img")).toHaveCount(1, { timeout: 15000 });
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    const d0 = await db(page), f = d0[Object.keys(d0).find((k) => k.startsWith("lojas/u1/fotos/y1~"))!].fotos[0];
    expect(f.length).toBeLessThan(240000);
    const dim = await page.evaluate((u) => new Promise<number[]>((r) => { const i = new Image(); i.onload = () => r([i.width, i.height]); i.src = u; }), f);
    expect(Math.max(...dim)).toBeLessThanOrEqual(1000);
  });

  test("P07-E2 arquivo que não é imagem mostra aviso e não salva nada", async ({ page }) => {
    await abrirPecas(page);
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await page.getByLabel("Enviar foto", { exact: true }).setInputFiles(ARQ + "doc.pdf");
    await expect(page.locator("#ffMsg")).toContainText("Não deu para usar essa imagem");
    await expect(page.locator("#ffG img")).toHaveCount(0);
  });

  test("P07-E3 mais de 3 fotos: fica só com 3 e avisa", async ({ page }) => {
    await abrirPecas(page);
    await page.getByRole("button", { name: "Nova peça" }).click();
    const r = ARQ + "retrato.png";
    await page.getByLabel("Enviar foto da peça").setInputFiles([r, r, r, r]);
    await expect(page.locator("#npG img")).toHaveCount(3);
    await page.getByLabel("Enviar foto da peça").setInputFiles([r]);
    await expect(page.locator("#npMsg")).toContainText("Máximo de 3 fotos");
    // trocar a principal e tirar uma
    await page.locator("#npG").getByRole("button", { name: "Principal" }).first().click();
    await page.getByRole("button", { name: "Tirar a foto 3" }).click();
    await expect(page.locator("#npG img")).toHaveCount(2);
  });

  test("P07-E4 fechar a janela sem salvar não muda nada", async ({ page }) => {
    await abrirPecas(page);
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await page.getByLabel("Enviar foto", { exact: true }).setInputFiles(ARQ + "retrato.png");
    await expect(page.locator("#ffG img")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect((await db(page))["lojas/u1/fotos/y1"]).toBeUndefined();
    await expect(page.locator("body")).not.toHaveClass(/lock/);
  });

  test("P07-E5 nome com acentos e emoji, preço '1.234,56', toque duplo em Cadastrar cria uma peça só", async ({ page }) => {
    await abrirPecas(page);
    await page.getByRole("button", { name: "Nova peça" }).click();
    await page.getByLabel("Nome da peça").fill("Colar Coração ❤️ Árvore da Vida");
    await page.getByLabel("Preço de venda (R$)").fill("1.234,56");
    await page.getByRole("button", { name: "Cadastrar peça" }).dblclick();
    await publicar(page);
    const d = await db(page);
    const meus = Object.keys(d).filter((k) => k.startsWith("lojas/u1/proprios/"));
    expect(meus.length).toBe(1);
    expect(d[meus[0]]).toMatchObject({ nome: "Colar Coração ❤️ Árvore da Vida", preco: 1234.56, cat: "Outras" });
    await expect(page.locator(".pr", { hasText: "Árvore da Vida" })).toContainText("R$ 1.234,56");
  });

  test("P07-E6 nome muito longo é cortado em 80 letras", async ({ page }) => {
    await abrirPecas(page);
    await page.getByRole("button", { name: "Nova peça" }).click();
    await page.getByLabel("Nome da peça").fill("A".repeat(200));
    expect((await page.getByLabel("Nome da peça").inputValue()).length).toBe(80);
  });

  test("P07-E7 modo 'Só pronta entrega': peça própria aparece só se marcada", async ({ page }) => {
    await abrirPecas(page, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: [], modo: "pronta" }, "lojas/u1/proprios/rA": { nome: "Anel Meu", cat: "Anéis", preco: 50 } });
    await page.locator("#modo [data-modo='pronta']").click();
    await page.locator("#modo [data-modo='catalogo']").click();
    await page.locator("#modo [data-modo='pronta']").click();
    await publicar(page);
    expect(catalogo(await db(page)).length).toBe(0);
    await page.getByRole("switch", { name: "Pronta entrega: Anel Meu", exact: true }).check();
    await publicar(page);
    expect(catalogo(await db(page)).map((x: any) => x.id)).toEqual(["rA"]);
  });

  test("P07-E8 peça própria fora do site some da loja e volta", async ({ page }) => {
    await abrirPecas(page, { "lojas/u1/proprios/rA": { nome: "Anel Meu", cat: "Anéis", preco: 50 } });
    await page.getByRole("switch", { name: "No site: Anel Meu", exact: true }).uncheck();
    await publicar(page);
    expect(catalogo(await db(page)).some((x: any) => x.id === "rA")).toBe(false);
    await page.getByRole("switch", { name: "No site: Anel Meu", exact: true }).check();
    await publicar(page);
    expect(catalogo(await db(page))[0].id).toBe("rA");
  });

  test("P07-E9 editar a peça própria mantém as fotos que já tinha", async ({ page }) => {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMDAwAAA7rAQBn6dO5QAAAABJRU5ErkJggg==";
    await abrirPecas(page, { "lojas/u1/proprios/rA": { nome: "Anel Meu", cat: "Anéis", preco: 50, fotosN: 2, fotosV: 1 }, "lojas/u1/fotos/rA": { fotos: [PNG, PNG], v: 1 } });
    await expect(page.locator(".pr", { hasText: "Anel Meu" }).locator(".th img")).toHaveAttribute("src", /^data:image/);
    await page.getByRole("button", { name: "Editar Anel Meu" }).click();
    await expect(page.locator("#npG img")).toHaveCount(2);
    await page.getByLabel("Preço de venda (R$)").fill("55");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    const d = await db(page);
    expect(d["lojas/u1/fotos/rA"].fotos.length).toBe(2);
    expect(d["lojas/u1/proprios/rA"]).toMatchObject({ preco: 55, fotosN: 2 });
  });

  test("P07-F1 fontes: Montserrat no texto, Quicksand nos títulos, rótulos sem caixa alta", async ({ page }) => {
    await abrirPecas(page);
    await expect(page.getByRole("heading", { name: "Peças da loja" })).toBeVisible();
    const f = await page.evaluate(() => ({
      corpo: getComputedStyle(document.body).fontFamily,
      titulo: getComputedStyle(document.querySelector(".box h2")!).fontFamily,
      rotulo: getComputedStyle(document.querySelector(".flabel")!).textTransform,
    }));
    expect(f.corpo).toContain("Montserrat");
    expect(f.titulo).toContain("Quicksand");
    expect(f.rotulo).toBe("none");
  });

  test("P07-A11y aba Peças e janela de nova peça sem falhas graves de acessibilidade", async ({ page }) => {
    await abrirPecas(page, { "lojas/u1/proprios/rA": { nome: "Anel Meu", cat: "Anéis", preco: 50 } });
    const graves = async () => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["critical", "serious"].includes(v.impact || "")).map((v) => `${v.id}: ${v.nodes.length}`);
    expect(await graves()).toEqual([]);
    await page.getByRole("button", { name: "Nova peça" }).click();
    expect(await graves()).toEqual([]);
  });
});

test("P08-S4 ADM: cartão 'Precisam de atenção' sem ponto solto quando a loja não tem responsável", async ({ page }) => {
  await preparar(page, { seed: seed(10, { "sistema/yampi": { total: 10, novos: 0, em: { __ts: Date.now() } } }) });
  await entrar(page, "adm@teste.com", "/adm");
  const t = await page.locator(".lc .hint").first().innerText();
  expect(t.trim()).toBe("Nunca entrou no painel");
});

test.describe("P09 renomear peças da Veraneio", () => {
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  test("P09-H1 renomear publica o nome novo; pesquisa acha pelos dois nomes; voltar ao nome da Veraneio", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await expect(page.getByLabel("Nome na sua loja")).toHaveValue("Peça 1");
    await page.getByLabel("Nome na sua loja").fill("  Brinco   Estrela da Manhã ✨ ");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    let d = await db(page);
    expect(d["precos/u1"].nomes).toEqual({ y1: "Brinco Estrela da Manhã ✨" });
    expect(catalogo(d).find((x: any) => x.id === "y1").nome).toBe("Brinco Estrela da Manhã ✨");
    const linha = page.locator(".pr", { hasText: "Estrela da Manhã" });
    await expect(linha).toContainText("Veraneio: Peça 1");
    await page.getByPlaceholder("Pesquisar peça").fill("estrela");
    await expect(page.locator(".pr")).toHaveCount(1);
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 1");
    await expect(page.locator(".pr", { hasText: "Estrela da Manhã" })).toHaveCount(1);
    // voltar ao nome original
    await page.getByRole("button", { name: "Editar peça: Brinco Estrela da Manhã ✨", exact: true }).click();
    await page.getByRole("button", { name: "Usar o nome da Veraneio" }).click();
    await expect(page.getByLabel("Nome na sua loja")).toHaveValue("Peça 1");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    d = await db(page);
    expect(d["precos/u1"].nomes).toEqual({});
    expect(catalogo(d).find((x: any) => x.id === "y1").nome).toBe("Peça 1");
    expect(erros).toEqual([]);
  });

  test("P09-E1 nome vazio não salva", async ({ page }) => {
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await page.getByLabel("Nome na sua loja").fill("  ");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("alert")).toContainText("Escreva o nome da peça");
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("P09-E2 nome trocado continua depois de mudar a margem e da republicação do ADM; pedido mostra o nome da Veraneio", async ({ page }) => {
    const s = seed(40, { "precos/u1": { margem: 100, arred: "90", over: {}, nomes: { y2: "Colar Lua" } },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } },
      "lojas/u1/leads/L1": { uid: "u1", nome: "Maria", tel: "(22) 99999-0000", status: "enviado", total: 99, ts: { __ts: Date.now() }, itens: [{ id: "y2", nome: "Colar Lua", q: 1, preco: 99 }] } });
    await preparar(page, { seed: s });
    await entrar(page);
    await aba(page, "Pedidos").click();
    await page.getByRole("button", { name: /Enviados/ }).click();
    await expect(page.locator(".lc").first()).toContainText("1x Colar Lua (Veraneio: Peça 2)");
    await aba(page, "Preços").click();
    await expect(page.locator(".pr", { hasText: "Colar Lua" }).first()).toBeVisible();
    await page.locator("#fM").fill("60");
    await publicar(page);
    expect(catalogo(await db(page)).find((x: any) => x.id === "y2").nome).toBe("Colar Lua");
    // ADM republica todas as lojas
    await page.evaluate(() => localStorage.removeItem("fake:user:adm"));
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.getByText("Catálogo atualizado em todas as lojas")).toBeVisible({ timeout: 8000 });
    expect(catalogo(await db(page)).find((x: any) => x.id === "y2").nome).toBe("Colar Lua");
  });
});

test.describe("P10 renomear: segurança e combinações", () => {
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  test("P10-S1 nome com código (<img onerror>) é mostrado como texto, não executa", async ({ page }) => {
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.evaluate(() => { (window as any).__xss = 0; });
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    await page.getByLabel("Nome na sua loja").fill('<img src=x onerror="window.__xss=1">Anel');
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    await expect(page.locator(".pr", { hasText: "<img src=x" }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as any).__xss)).toBe(0);
  });
  test("P10-H1 renomear e trocar a foto juntos; A11y da janela", async ({ page }) => {
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 1", exact: true }).click();
    const graves = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["critical", "serious"].includes(v.impact || "")).map((v) => v.id);
    expect(graves).toEqual([]);
    await page.getByLabel("Nome na sua loja").fill("Anel Lua");
    await page.getByLabel("Enviar foto", { exact: true }).setInputFiles("e2e/arquivos/retrato.png");
    await expect(page.locator("#ffG img")).toHaveCount(1);
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    const it = catalogo(await db(page)).find((x: any) => x.id === "y1");
    expect(it).toMatchObject({ nome: "Anel Lua", fp: { n: 1 }, fotos: [] });
  });
});

test.describe("P11 preço exato por peça (sem porcentagem)", () => {
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  const preco = async (page: Page, id: string) => catalogo(await db(page)).find((x: any) => x.id === id).preco;
  const salvo = (page: Page) => publicar(page);
  // Peça 1 = atacado R$ 21; Peça 2 = R$ 22 (seed: 20 + i%30)
  test("P11-H1 preço exato vale como está e não muda com a margem padrão", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Preços").click();
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 1");
    await page.getByLabel("Preço exato Peça 1", { exact: true }).fill("59,90");
    await salvo(page);
    expect((await db(page))["precos/u1"].fixo).toEqual({ y1: 59.9 });
    expect(await preco(page, "y1")).toBe(59.9);
    const linha = page.locator(".pr", { hasText: "Peça 1" }).first();
    await expect(linha).toContainText("Loja R$ 59,90");
    await expect(linha).toContainText("Lucro R$ 38,90");
    await page.locator("#fM").fill("200");
    await publicar(page);
    await expect.poll(() => preco(page, "y2"), { timeout: 8000 }).toBe(66.9);   // 22 × 3 = 66 → 66,90
    expect(await preco(page, "y1")).toBe(59.9);   // não mudou
    expect(erros).toEqual([]);
  });

  test("P11-E1 preço abaixo do atacado avisa e a loja vende pelo atacado", async ({ page }) => {
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Preços").click();
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 1");
    await page.getByLabel("Preço exato Peça 1", { exact: true }).fill("10");
    await salvo(page);
    await expect(page.locator(".pr", { hasText: "Peça 1" }).first()).toContainText("Abaixo do atacado: a loja vende a R$ 21,00");
    expect(await preco(page, "y1")).toBe(21);
  });

  test("P11-E2 digitar margem apaga o preço exato e vice-versa; 'Usar margem padrão em todas' limpa tudo", async ({ page }) => {
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Preços").click();
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 1");
    const fx = page.getByLabel("Preço exato Peça 1", { exact: true }), mg = page.getByLabel("Margem Peça 1", { exact: true });
    await fx.fill("59,90");
    await mg.fill("50");
    await expect(fx).toHaveValue("");
    await expect.poll(async () => (await db(page))["rascunhos/u1/docs/precos"]?.over, { timeout: 8000 }).toEqual({ y1: 50 });
    let pr = (await db(page))["rascunhos/u1/docs/precos"];
    expect(pr.fixo).toEqual({});
    await fx.fill("1.234,50");
    await expect(mg).toHaveValue("");
    await expect.poll(async () => (await db(page))["rascunhos/u1/docs/precos"]?.fixo, { timeout: 8000 }).toEqual({ y1: 1234.5 });
    pr = (await db(page))["rascunhos/u1/docs/precos"];
    expect(pr.over).toEqual({});
    await page.getByRole("button", { name: "Usar margem padrão em todas" }).click();
    await page.getByRole("button", { name: /Toque de novo/ }).click();
    await expect.poll(async () => (await db(page))["rascunhos/u1/docs/precos"]?.fixo, { timeout: 8000 }).toEqual({});
    expect((await db(page))["rascunhos/u1/docs/precos"]?.over).toEqual({});
  });

  test("P11-H2 preço exato pela janela Editar da aba Peças; ADM republica e mantém", async ({ page }) => {
    await preparar(page, { seed: seed(40, { "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 3", exact: true }).click();
    await page.getByLabel("Preço exato na sua loja (R$, opcional)").fill("abc");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("alert")).toContainText("Preço inválido");
    await page.getByLabel("Preço exato na sua loja (R$, opcional)").fill("45");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    await expect(page.locator(".pr", { hasText: "Peça 3" }).first()).toContainText("R$ 45,00");
    expect(await preco(page, "y3")).toBe(45);
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.getByText("Catálogo atualizado em todas as lojas")).toBeVisible({ timeout: 8000 });
    expect(await preco(page, "y3")).toBe(45);
  });
});

test.describe("S01 segurança no navegador", () => {
  test("S01-H1 loja, painel e ADM funcionam com os cabeçalhos de segurança, sem bloqueio da política (CSP)", async ({ page }) => {
    const bloqueios: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bloqueios.push(m.text()); });
    const r = await page.request.get("/painel");
    expect(r.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers()["x-frame-options"]).toBe("DENY");
    expect(r.headers()["x-content-type-options"]).toBe("nosniff");
    await preparar(page, { seed: seed(40) });
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    for (const t of ["Pedidos", "Peças", "Preços", "Aparência", "Loja"]) { await aba(page, t).click(); await page.waitForTimeout(300); }
    await entrar(page, "adm@teste.com", "/adm");
    await expect(page.getByText("Lojas ativas").first()).toBeVisible();
    expect(bloqueios).toEqual([]);
  });

  test("S01-E1 pedido falso com código no id, na quantidade e no total não executa nada no painel", async ({ page }) => {
    const s = seed(10, { 'lojas/u1/leads/x" onmouseover="window.__xss=1" a="': { uid: "u1", nome: "<img src=x onerror=window.__xss=2>", tel: "<b>1</b>", status: "abandonado", total: "<img src=x onerror=window.__xss=3>", ts: { __ts: Date.now() },
      itens: [{ id: "y1", nome: "<svg onload=window.__xss=4>", q: "<img src=x onerror=window.__xss=5>", preco: "x" }] },
      "lojas/u1/dias/2026-11-11": { data: "2026-11-11", uid: "u1", visitas: 1, views: { y1: "<img src=x onerror=window.__xss=6>" } } });
    await preparar(page, { seed: s });
    await page.addInitScript(() => { (window as any).__xss = 0; });
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    await page.locator("#nav").getByRole("button", { name: /^Pedidos/ }).click();
    await expect(page.locator(".lc").first()).toContainText("<img src=x onerror=window.__xss=2>");
    await page.locator(".lc").first().hover();
    await page.locator(".lc button, .lc a").first().hover();
    await aba(page, "Início").click();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__xss)).toBe(0);
  });

  test("S01-E2 ADM move responsável, cidade e último acesso para a área privada", async ({ page }) => {
    const s = seed(10, { "lojas/u1": { nome: "Kailane Joias", slug: "kailane-joias", status: "ativa", resp: "Kailane Souza", cidade: "Nova Friburgo", ultimoAcesso: { __ts: Date.now() - 3 * 86400000 } },
      "sistema/yampi": { total: 10, novos: 0, em: { __ts: Date.now() } } });
    await preparar(page, { seed: s });
    await entrar(page, "adm@teste.com", "/adm");
    await expect(page.getByText("Lojas ativas").first()).toBeVisible();
    const d = await db(page);
    expect(d["lojas/u1"].resp).toBeUndefined(); expect(d["lojas/u1"].cidade).toBeUndefined(); expect(d["lojas/u1"].ultimoAcesso).toBeUndefined();
    expect(d["contas/u1"]).toMatchObject({ email: "rev@teste.com", resp: "Kailane Souza", cidade: "Nova Friburgo" });
    expect(d["acessos/u1"].em.__ts).toBeGreaterThan(0);
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    await expect(page.getByText("Kailane Souza · Nova Friburgo")).toBeVisible();
  });

  test("S01-E3 o painel grava o último acesso em acessos/, não na loja pública", async ({ page }) => {
    await preparar(page, { seed: seed(10) });
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    await expect.poll(async () => (await db(page))["acessos/u1"]?.em?.__ts || 0).toBeGreaterThan(0);
    expect((await db(page))["lojas/u1"].ultimoAcesso).toBeUndefined();
  });
});

/* Correções da auditoria de segurança: cada teste reproduz o ataque e confere que ele não funciona mais. */
test.describe("S02 auditoria de segurança — ADM", () => {
  const duas = (extra: Record<string, any> = {}) => seed(40, {
    "lojas/vit": { nome: "Vitima Joias", slug: "vitima", cor: "#043034", status: "ativa" },
    "lojas/atk": { nome: "Atacante Joias", slug: "atacante", cor: "#043034", status: "ativa", uid: "vit" },
    "contas/vit": { email: "vitima@exemplo.test" }, "contas/atk": { email: "atacante@exemplo.test" },
    "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } }, ...extra,
  });

  test("S02-1 'Pausar' no cartão de uma loja que gravou uid de outra pausa só a própria loja", async ({ page }) => {
    await preparar(page, { seed: duas() });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    const cartao = page.locator(".rescard", { hasText: "Atacante Joias" });
    await cartao.getByRole("button", { name: "Pausar" }).click();
    await expect.poll(async () => (await db(page))["lojas/atk"].status).toBe("pausada");
    expect((await db(page))["lojas/vit"].status).toBe("ativa");
  });

  test("S02-2 uma loja com preços malformados não impede a republicação das outras", async ({ page }) => {
    await preparar(page, { seed: duas({ "precos/atk": { margem: 0, arred: "", over: {}, pronta: 1 }, "precos/vit": { margem: 100, arred: "90", over: {} } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.getByText("Catálogo atualizado em todas as lojas")).toBeVisible({ timeout: 8000 });
    const d = await db(page);
    for (const u of ["u1", "vit", "atk"]) expect(d[`catalogos/${u}/partes/p0`].itens.length).toBeGreaterThan(0);
  });

  test("S02-3 cor da loja com código CSS não entra no estilo do ADM", async ({ page }) => {
    const erros = await preparar(page, { seed: duas({ "lojas/atk": { nome: "Atacante Joias", slug: "atacante", status: "ativa", cor: "red;background-image:url(https://exemplo.test/x)" } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    const st = await page.locator(".rescard", { hasText: "Atacante Joias" }).locator(".logo").getAttribute("style");
    expect(st).not.toContain("url(");
    expect(erros).toEqual([]);
  });

  test("S02-4 recuperar senha não revela se o e-mail tem cadastro", async ({ page }) => {
    await preparar(page);
    await page.goto("/painel");
    await page.getByLabel("E-mail").fill("ninguem@exemplo.test");
    await page.getByRole("button", { name: /Esqueci/ }).click();
    await expect(page.locator("#toast")).toContainText("Se esse e-mail tiver cadastro");
  });

  test("S02-5 contadores adulterados (negativos, enormes, data no futuro) não distorcem o painel", async ({ page }) => {
    const hoje = new Date(), k = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await preparar(page, { seed: seed(40, {
      "lojas/u1/dias/9999-12-31": { data: "9999-12-31", uid: "u1", visitas: -1000000, views: { y3: 1e15 } },
      [`lojas/u1/dias/${k(hoje)}`]: { data: k(hoje), uid: "u1", visitas: 7, views: { y1: 5, y2: "abc" } },
    }) });
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    await expect(page.locator("#main")).not.toContainText("1000000000000000");
    await expect(page.locator("#main")).not.toContainText("Peça 3");
  });
});

test.describe("PE1 pronta entrega da revendedora não some quando a peça sai da Veraneio", () => {
  const itensDe = (d: any, u: string) => Object.keys(d).filter((k) => k.startsWith(`catalogos/${u}/partes/`)).flatMap((k) => d[k].itens);
  const base = (extra: any = {}) => seed(40, {
    "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y3", "y4"] },
    "lojas/u2": { nome: "Outra Loja", slug: "outra", status: "ativa", cor: "#043034" }, "precos/u2": { margem: 100 },
    "planos/u2": { plano: "assinante" },
    "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } }, ...extra });
  const linha = (page: Page, nome: string) => page.locator(".prow", { hasText: nome });

  test("PE1-H1 ADM desativa / marca esgotado: some da encomenda, fica para quem tem como pronta entrega; Excluir tira de todos", async ({ page }) => {
    const erros = await preparar(page, { seed: base({ "rascunhos/u2/docs/precos": { margem: 100, pronta: ["y4"] } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await linha(page, "Peça 3").getByRole("button", { name: "Desativar" }).click();
    await expect(page.locator("#toast")).toContainText("pronta entrega");
    await expect.poll(async () => itensDe(await db(page), "u1").find((x: any) => x.id === "y3")?.pronta, { timeout: 10000 }).toBe(true);
    await expect.poll(async () => itensDe(await db(page), "u2").length, { timeout: 10000 }).toBeGreaterThan(0);
    let d = await db(page);
    expect(itensDe(d, "u2").some((x: any) => x.id === "y3")).toBe(false);
    expect(itensDe(d, "u1").find((x: any) => x.id === "y3")).toMatchObject({ pronta: true, nome: "Peça 3" });
    expect(itensDe(d, "u1").find((x: any) => x.id === "y3").fora).toBeUndefined();
    const at = Object.keys(d).filter((k) => k.startsWith("atacado/")).flatMap((k) => d[k].itens);
    expect(at.find((x: any) => x.id === "y3")).toMatchObject({ fora: true });
    expect(at.some((x: any) => x.id === "y7" && x.fora)).toBe(false);
    // peça que ninguém tem como pronta entrega sai de vez (nem vai para o atacado)
    await linha(page, "Peça 7").getByRole("button", { name: "Desativar" }).click();
    await expect.poll(async () => itensDe(await db(page), "u1").some((x: any) => x.id === "y7"), { timeout: 10000 }).toBe(false);
    d = await db(page);
    expect(Object.keys(d).filter((k) => k.startsWith("atacado/")).flatMap((k) => d[k].itens).some((x: any) => x.id === "y7")).toBe(false);
    // y4 é pronta da u2 só no rascunho (ainda não publicou): continua no atacado, para o painel dela
    await expect.poll(async () => itensDe(await db(page), "u1").some((x: any) => x.id === "y7"), { timeout: 10000 }).toBe(false);
    await page.locator(".prow", { hasText: /Peça 4(?!\d)/ }).getByRole("button", { name: "Desativar" }).click();
    await expect.poll(async () => { const x = await db(page); return Object.keys(x).filter((k) => k.startsWith("atacado/")).flatMap((k) => x[k].itens).find((i: any) => i.id === "y4")?.fora; }, { timeout: 10000 }).toBe(true);
    // Excluir: sai de todo mundo, até da pronta entrega
    await linha(page, "Peça 3").getByRole("button", { name: "Excluir" }).click();
    await linha(page, "Peça 3").getByRole("button", { name: "Toque de novo para excluir" }).click();
    await expect(page.locator("#toast")).toContainText("inclusive da pronta entrega");
    await expect.poll(async () => itensDe(await db(page), "u1").some((x: any) => x.id === "y3"), { timeout: 10000 }).toBe(false);
    expect(erros).toEqual([]);
  });

  test("PE1-H2 painel: peça que saiu da Veraneio aparece só para quem tem como pronta entrega; desmarcar tira na publicação", async ({ page }) => {
    const at = atacado(40);
    const fora = (i: number) => ({ ...at[i], fora: true });
    const erros = await preparar(page, { seed: base({ "atacado/p0": { itens: [...at.filter((p) => !["y3", "y9"].includes(p.id)), fora(3), fora(9)] } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.locator("#pq").fill("Peça 3");
    await expect(page.locator(".pr", { hasText: /Peça 3(?!\d)/ })).toContainText("Saiu do catálogo Veraneio");
    await page.locator("#pq").fill("Peça 9");
    await expect(page.locator("#plist .pr")).toHaveCount(0);
    await page.locator("#pq").fill("Peça 4");
    await expect(page.locator(".pr", { hasText: "Peça 4" })).not.toContainText("Saiu do catálogo");
    await page.locator("#pq").fill("Peça 3");
    await page.locator("[data-pe='y3']").uncheck();
    await expect(page.locator("#toast")).toContainText("saiu do catálogo Veraneio");
    await publicar(page);
    const its = itensDe(await db(page), "u1");
    expect(its.some((x: any) => x.id === "y3" || x.id === "y9")).toBe(false);
    expect(its.find((x: any) => x.id === "y4")).toMatchObject({ pronta: true });
    expect(erros).toEqual([]);
  });

  test("PE1-H3 atualização da Yampi: peça que sumiu do site da Veraneio continua na pronta entrega", async ({ page }) => {
    const erros = await preparar(page, { seed: base({ "sistema/yampi": { total: 40, novos: 0, em: { __ts: 0 } } }) });
    // Yampi devolve todas as peças menos a y3 (tirada do site)
    await page.route(/api\.dooki\.com\.br/, async (r) => {
      const u = r.request().url();
      if (u.includes("/count")) return r.fulfill({ json: { data: { total_pages: 1 } } });
      const slug = new URL(u).searchParams.get("slug");
      const data = slug === "aneis" ? atacado(30).filter((p) => p.id !== "y3").map((p) => ({ id: Number(p.id.slice(1)), name: p.nome, slug: "p" + p.id,
        prices: { data: { price: p.preco } }, images: { data: [] }, skus: { data: [] }, categories: { data: [{ name: "Anéis" }] } })) : [];
      return r.fulfill({ json: { data, meta: { name: "Anéis" } } });
    });
    await entrar(page, "adm@teste.com", "/adm");
    await expect.poll(async () => (await db(page))["produtos/y3"]?.ativo, { timeout: 20000 }).toBe(false);
    await expect.poll(async () => itensDe(await db(page), "u2").some((x: any) => x.id === "y3"), { timeout: 20000 }).toBe(false);
    expect(itensDe(await db(page), "u1").find((x: any) => x.id === "y3")).toMatchObject({ pronta: true });
    expect(erros).toEqual([]);
  });
});

test.describe("D01 desativar e excluir produto no ADM", () => {
  const base = () => seed(40, { "produtos/m1": { nome: "Peça Manual", cat: "Anéis", banho: "Ouro 18k", preco: 30, ativo: true, ordem: 1, fotos: [] }, "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } });
  const abrirProdutos = async (page: Page) => {
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
  };
  const linha = (page: Page, nome: string) => page.locator(".prow", { hasText: nome });

  test("D01-H1 desativar tira das lojas e ativar devolve", async ({ page }) => {
    const erros = await preparar(page, { seed: base() });
    await abrirProdutos(page);
    await linha(page, "Peça 3").getByRole("button", { name: "Desativar" }).click();
    await expect(page.locator("#toast")).toContainText("desativado");
    expect((await db(page))["produtos/y3"].ativo).toBe(false);
    await expect.poll(async () => ((await db(page))["catalogos/u1/partes/p0"]?.itens ?? { some: () => null }).some((x: any) => x.id === "y3"), { timeout: 10000 }).toBe(false);
    await linha(page, "Peça 3").getByRole("button", { name: "Ativar" }).click();
    await expect.poll(async () => ((await db(page))["catalogos/u1/partes/p0"]?.itens ?? { some: () => null }).some((x: any) => x.id === "y3"), { timeout: 10000 }).toBe(true);
    expect(erros).toEqual([]);
  });

  test("D01-H2 excluir peça da Yampi pede confirmação, some da lista e pode ser restaurada", async ({ page }) => {
    await preparar(page, { seed: base() });
    await abrirProdutos(page);
    const b = linha(page, "Peça 5").getByRole("button", { name: "Excluir" });
    await b.click();
    expect((await db(page))["produtos/y5"].excluido).toBeUndefined();
    await linha(page, "Peça 5").getByRole("button", { name: "Toque de novo para excluir" }).click();
    await expect(linha(page, "Peça 5")).toHaveCount(0);
    const d = (await db(page))["produtos/y5"];
    expect([d.excluido, d.ativo, d.desligadoAdm]).toEqual([true, false, true]);
    await expect.poll(async () => ((await db(page))["catalogos/u1/partes/p0"]?.itens ?? { some: () => null }).some((x: any) => x.id === "y5"), { timeout: 10000 }).toBe(false);
    await page.locator("#pst").selectOption("excluidos");
    await linha(page, "Peça 5").getByRole("button", { name: "Restaurar" }).click();
    await expect.poll(async () => (await db(page))["produtos/y5"].excluido).toBe(false);
    expect((await db(page))["produtos/y5"].ativo).toBe(true);
  });

  test("D01-H3 excluir produto cadastrado à mão apaga o produto", async ({ page }) => {
    await preparar(page, { seed: base() });
    await abrirProdutos(page);
    await linha(page, "Peça Manual").getByRole("button", { name: "Excluir" }).click();
    await linha(page, "Peça Manual").getByRole("button", { name: "Toque de novo para excluir" }).click();
    await expect.poll(async () => (await db(page))["produtos/m1"]).toBeUndefined();
    await expect(linha(page, "Peça Manual")).toHaveCount(0);
  });
});

test.describe("D02 revendedora exclui peça da Veraneio da própria loja", () => {
  test("D02-H1 excluir tira do site e das listas; restaurar devolve", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y4"] } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: /Editar peça: Peça 4$/ }).click();
    await page.getByRole("button", { name: "Excluir da minha loja" }).click();
    await page.getByRole("button", { name: "Toque de novo para excluir" }).click();
    await expect(page.locator("#toast")).toContainText("excluída");
    await publicar(page);
    await expect.poll(async () => (await db(page))["precos/u1"]?.excluidas, { timeout: 10000 }).toEqual(["y4"]);
    const pr = (await db(page))["precos/u1"];
    expect(pr.ocultas).toContain("y4");
    expect(pr.pronta).not.toContain("y4");
    await expect.poll(async () => ((await db(page))["catalogos/u1/partes/p0"]?.itens ?? { some: () => null }).some((x: any) => x.id === "y4"), { timeout: 10000 }).toBe(false);
    await expect(page.locator("#plist")).not.toContainText("Peça 4");
    await page.locator("#pf").getByRole("button", { name: /Excluídas/ }).click();
    await page.getByRole("button", { name: "Restaurar Peça 4" }).click();
    await publicar(page);
    await expect.poll(async () => (await db(page))["precos/u1"].excluidas, { timeout: 10000 }).toEqual([]);
    await expect.poll(async () => ((await db(page))["catalogos/u1/partes/p0"]?.itens ?? { some: () => null }).some((x: any) => x.id === "y4"), { timeout: 10000 }).toBe(true);
    expect(erros).toEqual([]);
  });
});

test.describe("A01 aviso do ADM no Início das revendedoras", () => {
  test("A01-H1 ADM cria aviso com imagem, título, mensagem e link; revendedora vê no Início", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.getByRole("button", { name: "Criar aviso" }).click();
    await page.getByLabel("Escolher imagem do banner").setInputFiles("e2e/arquivos/retrato.png");
    await expect(page.locator("#avMsg")).toHaveText("Imagem pronta.");
    await page.getByLabel("Título").fill("Coleção Verão chegou");
    await page.getByLabel("Mensagem").fill("Peças novas no catálogo.\nAproveitem!");
    await page.getByLabel("Link do botão (opcional)").fill("https://veraneio.com.br/verao");
    await page.getByLabel("Texto do botão").fill("Ver coleção");
    await page.getByLabel("Mostrar no painel das revendedoras").check();
    await expect(page.locator("#avPrev")).toContainText("Coleção Verão chegou");
    await page.getByRole("button", { name: "Salvar aviso" }).click();
    await expect(page.locator("#toast")).toContainText("Aviso publicado");
    const a = (await db(page))["avisos/geral"];
    expect(a.ativo).toBe(true);
    expect(a.img).toMatch(/^data:image\/jpeg;base64,/);
    expect(a.img.length).toBeLessThan(300000);
    await expect(page.locator("#main")).toContainText("Aparecendo no painel");
    await entrar(page);
    const p2 = page;
    const av = p2.getByRole("region", { name: "Aviso da Veraneio" });
    await expect(av).toContainText("Coleção Verão chegou");
    await expect(av.getByRole("link", { name: "Ver coleção" })).toHaveAttribute("href", "https://veraneio.com.br/verao");
    await expect(av.locator("img")).toHaveCount(1);
    expect(erros).toEqual([]);
  });

  test("A01-H2 aviso desligado não aparece; texto com HTML aparece como texto", async ({ page }) => {
    await preparar(page, { seed: seed(40, { "avisos/geral": { ativo: false, titulo: "Escondido", texto: "x" } }) });
    await entrar(page);
    await expect(page.getByText("Link da sua loja")).toBeVisible();
    await expect(page.getByRole("region", { name: "Aviso da Veraneio" })).toHaveCount(0);
  });

  test("A01-N1 título com HTML e link javascript: não viram código", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "avisos/geral": { ativo: true, titulo: '<img src=x onerror="window.__pw=1">Oi', texto: "<b>t</b>", link: "javascript:alert(1)" } }) });
    await entrar(page);
    const av = page.getByRole("region", { name: "Aviso da Veraneio" });
    await expect(av).toContainText('<img src=x onerror="window.__pw=1">Oi');
    await expect(av.getByRole("link")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pw)).toBeUndefined();
    expect(erros).toEqual([]);
  });
});

test.describe("H02 revendedora edita a faixa de destaques", () => {
  test("H02-1 trocar texto e esconder item salva na loja", async ({ page }) => {
    const erros = await preparar(page);
    await entrar(page);
    await aba(page, "Loja").click();
    await page.getByLabel("Título").first().fill("Entrega em 24h");
    await page.locator("#dqS0").fill("para Nova Friburgo");
    await page.locator('[data-dq="1"][data-k="on"]').uncheck();
    await expect(page.locator("#dqT1")).toBeDisabled();
    await expect.poll(async () => (await db(page))["lojas/u1"].destaques, { timeout: 3000 }).toBeUndefined();
    await publicar(page);
    await expect.poll(async () => (await db(page))["lojas/u1"].destaques, { timeout: 5000 }).toEqual([
      { t: "Entrega em 24h", s: "para Nova Friburgo", off: false }, { t: "", s: "", off: true }, { t: "", s: "", off: false }, { t: "", s: "", off: false }]);
    expect(erros).toEqual([]);
  });
});

test.describe("DS1 descrição da peça", () => {
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  test("DS1-H1 revendedora escreve a descrição e ela vai para a loja ao publicar; apagar volta ao vazio", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: /Editar peça: Peça 2$/ }).click();
    await expect(page.getByLabel("Descrição na sua loja (opcional)")).toHaveValue("");
    await page.getByLabel("Descrição na sua loja (opcional)").fill("Anel regulável banhado a ouro 18k.");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    let d = await db(page);
    expect(d["precos/u1"].descs).toEqual({ y2: "Anel regulável banhado a ouro 18k." });
    expect(catalogo(d).find((x: any) => x.id === "y2").descricao).toBe("Anel regulável banhado a ouro 18k.");
    expect(catalogo(d).find((x: any) => x.id === "y3").descricao).toBe("");
    await page.getByRole("button", { name: /Editar peça: Peça 2$/ }).click();
    await expect(page.getByLabel("Descrição na sua loja (opcional)")).toHaveValue("Anel regulável banhado a ouro 18k.");
    await page.getByLabel("Descrição na sua loja (opcional)").fill("");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    d = await db(page);
    expect(d["precos/u1"].descs).toEqual({});
    expect(catalogo(d).find((x: any) => x.id === "y2").descricao).toBe("");
    expect(erros).toEqual([]);
  });
});

test.describe("PL1 plano de acesso (gratuito / assinante)", () => {
  test("PL1-H1 1º acesso registra a data e mostra 'Acesso gratuito' no Início", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(800, { "planos/u1": undefined }) });
    await entrar(page);
    await expect(page.locator(".plano")).toHaveText("Acesso gratuito");
    const p = (await db(page))["planos/u1"];
    expect(p.plano).toBe("gratuito");
    expect(p.primeiroAcesso).toBeTruthy();
    expect(erros).toEqual([]);
  });
  test("PL1-H2 assinante vê o selo 'Assinante' e o 1º acesso não muda", async ({ page }) => {
    await preparar(page, { seed: seed(40, { "planos/u1": { plano: "assinante", primeiroAcesso: { __ts: Date.UTC(2026, 9, 1) } } }) });
    await entrar(page);
    await expect(page.locator(".plano")).toHaveText("Assinante");
    expect((await db(page))["planos/u1"].primeiroAcesso).toEqual({ __ts: Date.UTC(2026, 9, 1) });
  });
  test("PL1-H3 ADM vê 1º acesso e selo, torna assinante e volta para gratuito", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 5 * 864e5 } },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    const c = page.locator(".rescard").first();
    await expect(c.locator(".pill.pl-gratuito")).toHaveText("Gratuito");
    await expect(c).toContainText(/1º acesso em \d{2}\/\d{2}\/\d{4} \(5 dias\)/);
    await c.getByRole("button", { name: "Tornar assinante" }).click();
    await page.getByRole("button", { name: "Marcar como assinante" }).click();
    await expect.poll(async () => (await db(page))["planos/u1"].plano).toBe("assinante");
    expect((await db(page))["planos/u1"]).toMatchObject({ origem: "manual", pagoAte: null });
    await expect(page.locator(".rescard").first().locator(".pill.pl-assinante")).toHaveText("Assinante");
    await page.locator("#rst").selectOption("gratuito");
    await expect(page.locator(".rescard")).toHaveCount(0);
    await page.locator("#rst").selectOption("assinante");
    await expect(page.locator(".rescard")).toHaveCount(1);
    await page.locator(".rescard").first().getByRole("button", { name: "Voltar para gratuito" }).click();
    await page.locator("#gfOk").click();
    await expect.poll(async () => (await db(page))["planos/u1"].plano).toBe("gratuito");
    expect((await db(page))["planos/u1"].primeiroAcesso).toBeTruthy();
    expect(erros).toEqual([]);
  });
});

test.describe("PZ1 prazo do período gratuito", () => {
  const dia = 864e5;
  test("PZ1-H1 ADM define o prazo; cartões mostram quanto falta ou que encerrou; filtro de encerrados", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "lojas/u2": { nome: "Loja Velha", slug: "velha", status: "ativa", cor: "#043034" },
      "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 5 * dia } },
      "planos/u2": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 40 * dia } },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    await expect(page.locator(".rescard", { hasText: "Loja Velha" })).not.toContainText("encerrou");
    await page.getByRole("button", { name: "Planos e cobrança" }).click();
    await page.getByLabel("Período gratuito (dias)").fill("30");
    await page.locator("#pzOk").click();
    await expect(page.locator("#toast")).toContainText("Planos e cobrança salvos");
    await expect(page.locator("#main")).toContainText("Grátis: 30 dias");
    expect((await db(page))["config/planos"].diasGratis).toBe(30);
    await expect(page.locator(".rescard", { hasText: "Loja Velha" }).locator(".pill.pl-vencido")).toHaveText("Gratuito encerrado");
    await expect(page.locator(".rescard", { hasText: "Loja Velha" })).toContainText("encerrou há 10");
    await expect(page.locator(".rescard").filter({ hasNotText: "Loja Velha" })).toContainText("faltam 25");
    await page.locator("#rst").selectOption("vencido");
    await expect(page.locator(".rescard")).toHaveCount(1);
    await expect(page.locator(".rescard")).toContainText("Loja Velha");
    expect(erros).toEqual([]);
  });
  test("PZ1-H2 revendedora vê quantos dias faltam; depois do prazo vê 'Período gratuito encerrado'", async ({ page }) => {
    await preparar(page, { seed: seed(40, { "config/planos": { diasGratis: 30 }, "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 5 * dia } } }) });
    await entrar(page);
    await expect(page.locator(".plano")).toHaveText("Acesso gratuito · faltam 25 dias");
  });
  test("PZ1-H3 prazo vencido e assinante", async ({ page }) => {
    await preparar(page, { seed: seed(40, { "config/planos": { diasGratis: 30 }, "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 31 * dia } } }) });
    await entrar(page);
    await expect(page.locator(".plano")).toHaveText("Período gratuito encerrado");
  });
});

test.describe("PG1 o que o plano gratuito libera", () => {
  const dia = 864e5;
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  test("PG1-H1 gratuito não cadastra peça própria; ao publicar, as peças próprias que já tinha saem da loja", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "config/planos": { diasGratis: 30 }, "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 2 * dia } },
      "lojas/u1/proprios/rX": { nome: "Colar Meu", cat: "Colares", preco: 100 } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await expect(page.getByText("Cadastrar peças suas é do plano")).toBeVisible();
    await page.getByRole("button", { name: "Nova peça" }).click();
    await expect(page.locator("#toast")).toContainText("plano Assinante");
    await expect(page.locator("#npF")).toHaveCount(0);
    await page.locator("#pf").getByRole("button", { name: /Minhas/ }).click();
    await expect(page.locator("#massa")).toContainText("não aparecem na loja");
    await expect(page.locator(".pr.bloq", { hasText: "Colar Meu" })).toContainText("Não aparece na loja no plano gratuito");
    await expect(page.getByRole("button", { name: /Editar Colar Meu/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Bloqueada: Colar Meu" }).click();
    await expect(page.locator("#toast")).toContainText("Peça bloqueada");
    await expect(page.locator("#npF")).toHaveCount(0);
    await page.locator("#pf").getByRole("button", { name: /Todas/ }).click();
    await page.locator("[data-pe]").first().check();
    await publicar(page);
    const itens = catalogo(await db(page));
    expect(itens.length).toBeGreaterThan(0);
    expect(itens.some((x: any) => x.proprio)).toBe(false);
    expect(erros).toEqual([]);
  });
  test("PG1-H2 prazo vencido: loja segue no ar, Início e Pedidos abrem, o resto fica bloqueado", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "config/planos": { diasGratis: 30 }, "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 31 * dia } } }) });
    await entrar(page);
    await expect(page.getByRole("heading", { name: "Seu período gratuito terminou" })).toBeVisible();
    await expect(page.locator("#pubbar")).toBeHidden();
    for (const n of ["Peças", "Preços", "Aparência", "Loja"]) {
      await page.locator("#nav").getByRole("button", { name: `${n} bloqueada`, exact: true }).click();
      await expect(page.getByRole("heading", { name: "Seu período gratuito terminou" })).toBeVisible();
      await expect(page.locator("#plist, #npF, #fWa")).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
    await aba(page, "Pedidos").click();
    await expect(page.getByRole("heading", { name: "Seu período gratuito terminou" })).toHaveCount(0);
    expect(Object.keys(await db(page)).some((k) => k.startsWith("rascunhos/") || k.startsWith("catalogos/"))).toBe(false);
    expect(erros).toEqual([]);
  });
  test("PG1-H3 ADM: voltar para gratuito tira as peças próprias da loja; tornar assinante traz de volta", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "lojas/u1/proprios/rX": { nome: "Colar Meu", cat: "Colares", preco: 100 },
      "catalogos/u1/partes/p0": { itens: [{ id: "rX", nome: "Colar Meu", preco: 100, proprio: true }] },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    await page.locator(".rescard").first().getByRole("button", { name: "Voltar para gratuito" }).click();
    await page.locator("#gfOk").click();
    await expect(page.locator("#toast")).toContainText("peças próprias saíram");
    let itens = catalogo(await db(page));
    expect(itens.some((x: any) => x.proprio)).toBe(false);
    expect(itens.length).toBeGreaterThan(0);
    await page.locator(".rescard").first().getByRole("button", { name: "Tornar assinante" }).click();
    await page.getByRole("button", { name: "Marcar como assinante" }).click();
    await expect(page.locator("#toast")).toContainText("agora é assinante");
    itens = catalogo(await db(page));
    expect(itens.find((x: any) => x.id === "rX")).toMatchObject({ nome: "Colar Meu", proprio: true });
    expect(erros).toEqual([]);
  });
  test("PG1-H4 republicação do ADM mantém peças próprias de assinante e tira de gratuita", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "lojas/u2": { nome: "Loja Grátis", slug: "gratis", status: "ativa", cor: "#043034" }, "precos/u2": { margem: 100 },
      "planos/u2": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() } },
      "catalogos/u1/partes/p0": { itens: [{ id: "rX", nome: "Colar Meu", preco: 100, proprio: true }] },
      "catalogos/u2/partes/p0": { itens: [{ id: "rY", nome: "Colar Dela", preco: 100, proprio: true }] },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.locator("#toast")).toContainText("Catálogo atualizado", { timeout: 10000 });
    const d = await db(page);
    const de = (u: string) => Object.keys(d).filter((k) => k.startsWith(`catalogos/${u}/partes/`)).flatMap((k) => d[k].itens);
    expect(de("u1").some((x: any) => x.id === "rX")).toBe(true);
    expect(de("u2").some((x: any) => x.proprio)).toBe(false);
    expect(de("u2").length).toBeGreaterThan(0);
    expect(erros).toEqual([]);
  });
});

test.describe("PR1 desconto nas peças", () => {
  const catalogo = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).sort().flatMap((k) => d[k].itens);
  test("PR1-H1 desconto em % na peça da Veraneio: loja recebe preço riscado; nunca abaixo do atacado; tirar o desconto volta", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "precos/u1": { margem: 100, arred: "", over: {} } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: /Editar peça: Peça 2$/ }).click();
    await page.getByLabel("Desconto (%) — opcional").fill("20");
    await expect(page.locator("#prmTxt")).toContainText("Na loja:");
    await page.getByRole("button", { name: "Salvar" }).click();
    await page.getByRole("button", { name: /Editar peça: Peça 3$/ }).click();
    await page.getByLabel("Desconto (%) — opcional").fill("90");
    await expect(page.locator("#prmTxt")).toContainText("não fica abaixo do atacado");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    let d = await db(page), y2 = catalogo(d).find((x: any) => x.id === "y2"), y3 = catalogo(d).find((x: any) => x.id === "y3");
    const at = (id: string) => d["atacado/p0"].itens.find((x: any) => x.id === id).preco;
    expect(y2.de).toBeCloseTo(at("y2") * 2, 2);
    expect(y2.preco).toBeCloseTo(Math.round(at("y2") * 2 * 80) / 100, 2);
    expect(y3.preco).toBeCloseTo(at("y3"), 2);
    expect(y3.de).toBeCloseTo(at("y3") * 2, 2);
    expect(d["precos/u1"].promos).toEqual({ y2: 20, y3: 90 });
    await expect(page.locator("#plist")).toContainText("(−20%)");
    await page.getByRole("button", { name: /Editar peça: Peça 2$/ }).click();
    await page.getByLabel("Desconto (%) — opcional").fill("");
    await page.getByRole("button", { name: "Salvar" }).click();
    await publicar(page);
    d = await db(page); y2 = catalogo(d).find((x: any) => x.id === "y2");
    expect(y2.de).toBeUndefined();
    expect(y2.preco).toBeCloseTo(at("y2") * 2, 2);
    expect(erros).toEqual([]);
  });
  test("PR1-H2 desconto em peça própria", async ({ page }) => {
    await preparar(page, { seed: seed(40, { "lojas/u1/proprios/rX": { nome: "Colar Meu", cat: "Colares", preco: 100 } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar Colar Meu" }).click();
    await page.getByLabel("Desconto (%) — opcional").fill("15");
    await page.locator("#npOk").click();
    await publicar(page);
    const it = catalogo(await db(page)).find((x: any) => x.id === "rX");
    expect([it.de, it.preco]).toEqual([100, 85]);
  });
});

test.describe("PAG1 assinatura paga (Mercado Pago)", () => {
  const dia = 864e5;
  const CFG = { diasGratis: 30, tolerancia: 3, valor: 39.9, valorPix: 35, mpPublicKey: "TEST-abcdef12-3456" };
  const gravar = (page: Page, k: string, v: any) => page.evaluate(([k, v]) => { const d = JSON.parse(localStorage.getItem("fake:db") || "{}"); d[k] = v; localStorage.setItem("fake:db", JSON.stringify(d)); }, [k, v] as const);
  /** servidor de pagamentos de mentira: guarda as chamadas e responde como o real */
  async function servidor(page: Page, resp: (b: any) => any) {
    const chamadas: any[] = [];
    await page.route("**/api/assinatura", async (r) => {
      const b = JSON.parse(r.request().postData() || "{}");
      chamadas.push({ ...b, auth: r.request().headers()["authorization"] });
      const x = await resp(b);
      return r.fulfill({ status: x && x.__status || 200, json: x });
    });
    return chamadas;
  }
  const SDK_FAKE = `window.MercadoPago=class{constructor(k){window.__mpKey=k}bricks(){return{create:async(n,id,o)=>{window.__mpOpts=o;const el=document.getElementById(id);
    el.innerHTML='<input aria-label="Número do cartão"><button type="button" id="mpSub">Assinar</button>';
    el.querySelector('#mpSub').onclick=()=>o.callbacks.onSubmit({token:"abcdef0123456789abcdef"}).catch(()=>{});return{unmount(){el.innerHTML=""}}}}}}`;

  test("PAG1-H1 ADM configura valores, tolerância e chave pública (sem apagar o prazo)", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "config/planos": { diasGratis: 30 }, "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    await page.getByRole("button", { name: "Planos e cobrança" }).click();
    await expect(page.getByLabel("Período gratuito (dias)")).toHaveValue("30");
    await page.getByLabel("Assinatura no cartão (R$ por mês)").fill("39,90");
    await page.getByLabel("Mensalidade no Pix (R$)").fill("35");
    await page.getByLabel("Tolerância depois do vencimento (dias)").fill("3");
    await page.getByLabel("Chave pública do Mercado Pago (Public Key)").fill("APP_USR-segredo<x>");
    await page.locator("#pzOk").click();
    await expect(page.locator("#pzE")).toContainText("APP_USR- ou TEST-");
    await page.getByLabel("Chave pública do Mercado Pago (Public Key)").fill("TEST-abcdef12-3456");
    await page.locator("#pzOk").click();
    await expect(page.locator("#toast")).toContainText("salvos");
    expect((await db(page))["config/planos"]).toMatchObject({ diasGratis: 30, valor: 39.9, valorPix: 35, tolerancia: 3, mpPublicKey: "TEST-abcdef12-3456" });
    await expect(page.locator("#main")).toContainText("R$ 39,90/mês no cartão");
    expect(erros).toEqual([]);
  });

  test("PAG1-H2 ADM marca assinante manual até uma data; cartão mostra 'pago até' e origem", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "config/planos": CFG, "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 5 * dia } }, "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    await page.locator(".rescard").first().getByRole("button", { name: "Tornar assinante" }).click();
    await page.getByLabel("Até a data").check();
    await page.getByLabel("Pago até").fill("2020-01-01");
    await page.getByRole("button", { name: "Marcar como assinante" }).click();
    await expect(page.locator("#asE")).toContainText("a partir de hoje");
    const futuro = new Date(Date.now() + 60 * dia), iso = `${futuro.getFullYear()}-${String(futuro.getMonth() + 1).padStart(2, "0")}-${String(futuro.getDate()).padStart(2, "0")}`;
    await page.getByLabel("Pago até").fill(iso);
    await page.getByRole("button", { name: "Marcar como assinante" }).click();
    await expect(page.locator("#toast")).toContainText("agora é assinante até");
    const p = (await db(page))["planos/u1"];
    expect(p).toMatchObject({ plano: "assinante", origem: "manual" });
    expect(p.pagoAte.__ts).toBeGreaterThan(Date.now() + 59 * dia);
    await expect(page.locator(".rescard").first()).toContainText(`Assinante (manual) · pago até ${futuro.toLocaleDateString("pt-BR")}`);
    expect(erros).toEqual([]);
  });

  test("PAG1-H3 painel: paga com Pix na mesma tela, vira Assinante e as peças próprias voltam para a loja", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "config/planos": CFG,
      "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 2 * dia } },
      "precos/u1": { margem: 100, arred: "90", over: {} },
      "lojas/u1/proprios/rX": { nome: "Colar Meu", cat: "Colares", preco: 100 } }) });
    let pago = false;
    const ch = await servidor(page, async (b) => {
      if (b.acao === "pix") return { id: "555", qr: "00020126PIXCOPIAECOLA", qrImg: "iVBORw0KGgo=", valor: 35, expira: Date.now() + 30 * 60e3 };
      if (b.acao === "conferir") {
        if (!pago) { pago = true; return { pago: false }; }
        await gravar(page, "planos/u1", { plano: "assinante", origem: "pix", pagoAte: { __ts: Date.now() + 31 * dia }, primeiroAcesso: { __ts: Date.now() - 2 * dia } });
        return { pago: true };
      }
      return { __status: 400, erro: "acao" };
    });
    await entrar(page);
    await expect(page.getByRole("heading", { name: "Seja Assinante" })).toBeVisible();
    await page.getByRole("button", { name: /Pagar com Pix · R\$ 35,00/ }).click();
    await expect(page.getByRole("img", { name: "QR Code do Pix" })).toBeVisible();
    await expect(page.locator("#pxC")).toHaveValue("00020126PIXCOPIAECOLA");
    await expect(page.getByText("Pagamento confirmado!")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#toast")).toContainText("Você é Assinante");
    expect(ch.every((c) => c.auth === "Bearer tok-u1")).toBe(true);
    expect(ch.map((c) => c.acao)).toEqual(["pix", "conferir", "conferir"]);
    expect(ch.some((c) => "valor" in c)).toBe(false); // o valor nunca sai do navegador
    await expect.poll(async () => { const x = await db(page); return Object.keys(x).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => x[k].itens).some((i: any) => i.id === "rX"); }, { timeout: 5000 }).toBe(true);
    const d = await db(page);
    const itens = Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
    expect(itens.find((x: any) => x.id === "rX")).toMatchObject({ proprio: true });
    await page.locator("#flX").click();
    await expect(page.locator(".plano.assinante")).toHaveText("Assinante");
    expect(erros).toEqual([]);
  });

  test("PAG1-H4 painel: assina no cartão com o formulário do Mercado Pago embutido e depois cancela", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "config/planos": CFG, "planos/u1": { plano: "gratuito", primeiroAcesso: { __ts: Date.now() - 2 * dia } } }) });
    await page.route(/sdk\.mercadopago\.com/, (r) => r.fulfill({ contentType: "text/javascript", body: SDK_FAKE }));
    const ch = await servidor(page, async (b) => {
      if (b.acao === "cartao") {
        await gravar(page, "planos/u1", { plano: "assinante", origem: "cartao", pagoAte: { __ts: Date.now() + 2 * dia }, primeiroAcesso: { __ts: Date.now() - 2 * dia } });
        await gravar(page, "assinaturas/u1", { cartao: { id: "pre1", status: "authorized" } });
        return { status: "authorized" };
      }
      if (b.acao === "cancelar") { await gravar(page, "assinaturas/u1", { cartao: { id: "pre1", status: "cancelled" } }); return { status: "cancelled" }; }
      return { __status: 400, erro: "acao" };
    });
    await entrar(page);
    await page.getByRole("button", { name: /Assinar no cartão · R\$ 39,90\/mês/ }).click();
    await expect(page.getByLabel("Número do cartão")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__mpKey)).toBe("TEST-abcdef12-3456");
    expect(await page.evaluate(() => (window as any).__mpOpts.initialization.amount)).toBe(39.9);
    await page.locator("#mpSub").click();
    await expect(page.getByText("Assinatura feita!")).toBeVisible();
    expect(ch[0]).toMatchObject({ acao: "cartao", token: "abcdef0123456789abcdef" });
    await page.locator("#flX").click();
    await expect(page.getByText("No cartão, renova sozinha todo mês.")).toBeVisible();
    await page.getByRole("button", { name: "Cancelar assinatura" }).click();
    await page.locator("#ccOk").click();
    await expect(page.locator("#toast")).toContainText("Assinatura cancelada");
    expect(ch[1]).toMatchObject({ acao: "cancelar" });
    expect(erros).toEqual([]);
  });

  test("PAG1-H5 venceu: na tolerância avisa e deixa pagar; passou da tolerância trava com botão de pagar; sem vencimento não mostra cobrança", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "config/planos": CFG,
      "planos/u1": { plano: "assinante", origem: "pix", pagoAte: { __ts: Date.now() - 1 * dia }, primeiroAcesso: { __ts: Date.now() - 90 * dia } } }) });
    await entrar(page);
    await expect(page.locator(".plano")).toContainText("pagamento atrasado");
    await expect(page.locator("#main")).toContainText("Pague até");
    await expect(page.getByRole("button", { name: /Pagar com Pix/ })).toBeVisible();
    await gravar(page, "planos/u1", { plano: "assinante", origem: "pix", pagoAte: { __ts: Date.now() - 5 * dia }, primeiroAcesso: { __ts: Date.now() - 90 * dia } });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sua assinatura venceu" })).toBeVisible();
    await expect(page.locator(".plano")).toHaveText("Assinatura vencida");
    await page.locator("#nav").getByRole("button", { name: "Peças bloqueada", exact: true }).click();
    await expect(page.getByRole("button", { name: /Assinar no cartão/ })).toBeVisible();
    await gravar(page, "planos/u1", { plano: "assinante", origem: "manual", pagoAte: null, primeiroAcesso: { __ts: Date.now() - 90 * dia } });
    await page.reload();
    await expect(page.locator(".plano")).toHaveText("Assinante");
    await expect(page.getByRole("button", { name: /Pagar com Pix|Assinar no cartão/ })).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test("PAG1-H6 ADM: voltar para gratuito quem tem cartão ativo cancela a cobrança no Mercado Pago antes", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "config/planos": CFG,
      "planos/u1": { plano: "assinante", origem: "cartao", pagoAte: { __ts: Date.now() + 20 * dia }, primeiroAcesso: { __ts: Date.now() - 90 * dia } },
      "assinaturas/u1": { cartao: { id: "pre1", status: "authorized", proxima: { __ts: Date.now() + 19 * dia } } },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    let falha = true;
    const ch = await servidor(page, async () => { if (falha) { falha = false; return { __status: 502, erro: "mp_falhou" }; } return { status: "cancelled" }; });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Revendedoras" }).click();
    await expect(page.locator(".rescard").first()).toContainText("Assinante (cartão)");
    await expect(page.locator(".rescard").first()).toContainText("cartão ativo · próxima cobrança");
    await page.locator(".rescard").first().getByRole("button", { name: "Voltar para gratuito" }).click();
    await page.getByRole("button", { name: "Cancelar cartão e voltar para gratuito" }).click();
    await expect(page.locator("#gfE")).toContainText("Nada foi mudado");
    expect((await db(page))["planos/u1"].plano).toBe("assinante");
    await page.getByRole("button", { name: "Cancelar cartão e voltar para gratuito" }).click();
    await expect.poll(async () => (await db(page))["planos/u1"].plano).toBe("gratuito");
    expect(ch.map((c) => [c.acao, c.uid])).toEqual([["cancelar", "u1"], ["cancelar", "u1"]]);
    expect(erros).toEqual([]);
  });
});

test.describe("MD1 'só pronta entrega' não volta para o catálogo todo", () => {
  const itensDe = (d: any, u: string) => Object.keys(d).filter((k) => k.startsWith(`catalogos/${u}/partes/`)).flatMap((k) => d[k].itens);
  test("MD1-H1 republicação do ADM respeita o modo escolhido na loja, mesmo com cópia velha no precos", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "lojas/u1": { ...seed(40)["lojas/u1"], modo: "pronta" },
      "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y1", "y2"], modo: "catalogo" },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.locator("#toast")).toContainText("Catálogo atualizado", { timeout: 10000 });
    const its = itensDe(await db(page), "u1");
    expect(its.map((x: any) => x.id).sort()).toEqual(["y1", "y2"]);
    expect(erros).toEqual([]);
  });
  test("MD1-H2 painel abre no modo da loja (rascunho incluído) e publica o precos com ele", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y3"], modo: "catalogo" },
      "rascunhos/u1/docs/loja": { modo: "pronta" }, "rascunhos/u1/docs/mudou": { em: { __ts: Date.now() } } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await expect(page.locator("#modo [data-modo='pronta']")).toHaveAttribute("aria-pressed", "true");
    await publicar(page);
    const d = await db(page);
    expect(d["lojas/u1"].modo).toBe("pronta");
    expect(d["precos/u1"].modo).toBe("pronta");
    expect(itensDe(d, "u1").map((x: any) => x.id)).toEqual(["y3"]);
    expect(erros).toEqual([]);
  });
});

test.describe("MD2 quatro jeitos de trabalhar", () => {
  const ids = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
  test("MD2-H1 só encomenda: catálogo todo sem selo de pronta entrega; escolhidas: só encomenda marcada + pronta", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y1"], ocultas: ["y9"] } }) });
    await entrar(page);
    await aba(page, "Peças").click();
    await expect(page.locator("#modo button")).toHaveCount(4);
    await page.locator("#modo [data-modo='encomenda']").click();
    await expect(page.getByRole("switch", { name: /^Pronta entrega:/ })).toHaveCount(0);
    await publicar(page);
    let d = await db(page);
    expect(ids(d).length).toBe(39);
    expect(ids(d).some((x: any) => x.pronta)).toBe(false);
    expect(d["lojas/u1"].modo).toBe("encomenda");
    // encomenda escolhida + pronta entrega
    await page.locator("#modo [data-modo='escolhidas']").click();
    await expect(page.locator("#modoHint")).toContainText("1 peça");
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 5");
    await page.getByRole("switch", { name: "Encomenda: Peça 5", exact: true }).check();
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 9");
    await page.getByRole("switch", { name: "Encomenda: Peça 9", exact: true }).check();
    await publicar(page);
    d = await db(page);
    expect(ids(d).map((x: any) => x.id).sort()).toEqual(["y1", "y5", "y9"]);
    expect(ids(d).find((x: any) => x.id === "y1").pronta).toBe(true);
    expect(ids(d).find((x: any) => x.id === "y5").pronta).toBeUndefined();
    expect(d["precos/u1"]).toMatchObject({ modo: "escolhidas", encomenda: ["y5", "y9"] });
    await page.getByPlaceholder("Pesquisar peça").fill("");
    await page.locator("#pf").getByRole("button", { name: /^Encomenda \(2\)/ }).click();
    await expect(page.locator("#plist .pr")).toHaveCount(2);
    expect(erros).toEqual([]);
  });
  test("MD2-H2 atualização do catálogo pelo ADM mantém 'escolhidas' e 'só encomenda'", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, {
      "lojas/u1": { ...seed(40)["lojas/u1"], modo: "escolhidas" },
      "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y1"], encomenda: ["y2", "y3"], modo: "escolhidas" },
      "lojas/u2": { nome: "Outra", slug: "outra", status: "ativa", cor: "#043034", modo: "encomenda" },
      "precos/u2": { margem: 100, pronta: ["y4"], modo: "catalogo" }, "planos/u2": { plano: "assinante" },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.locator("#toast")).toContainText("Catálogo atualizado", { timeout: 10000 });
    const d = await db(page);
    expect(ids(d).map((x: any) => x.id).sort()).toEqual(["y1", "y2", "y3"]);
    const u2 = Object.keys(d).filter((k) => k.startsWith("catalogos/u2/partes/")).flatMap((k) => d[k].itens);
    expect(u2.length).toBeGreaterThan(20);
    expect(u2.some((x: any) => x.id === "y4")).toBe(true);
    expect(u2.some((x: any) => x.pronta)).toBe(false);
    expect(erros).toEqual([]);
  });
});

test.describe("CU1 assinante que pagou fora da tela tem as peças próprias de volta", () => {
  const itens = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
  const base = { "lojas/u1/proprios/rX": { nome: "Colar Meu", cat: "Colares", preco: 100, criadoEm: { __ts: Date.now() - 5 * 864e5 } },
    "lojas/u1/proprios/rNovo": { nome: "Feita hoje", cat: "Colares", preco: 80, criadoEm: { __ts: Date.now() } },
    "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["rX", "rNovo"], modo: "pronta", atualizadoEm: { __ts: Date.now() - 864e5 } },
    "catalogos/u1/partes/p0": { itens: [] } };
  test("CU1-H1 abrir o painel já devolve as peças próprias para a loja", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { ...base, "lojas/u1": { ...seed(40)["lojas/u1"], modo: "pronta" },
      "planos/u1": { plano: "assinante", origem: "pix", pagoAte: { __ts: Date.now() + 30 * 864e5 }, primeiroAcesso: { __ts: Date.now() - 9 * 864e5 } } }) });
    await entrar(page);
    await expect.poll(async () => itens(await db(page)).map((x: any) => x.id), { timeout: 8000 }).toEqual(["rX"]);
    expect(erros).toEqual([]);
  });
  test("CU1-H2 republicação do ADM traz as peças próprias de quem virou assinante e ainda não tinha nenhuma na loja", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(40, { ...base, "lojas/u1": { ...seed(40)["lojas/u1"], modo: "pronta" },
      "sistema/yampi": { total: 40, novos: 0, em: { __ts: Date.now() } } }) });
    await entrar(page, "adm@teste.com", "/adm");
    await page.locator("#nav").getByRole("button", { name: "Produtos" }).click();
    await page.getByRole("button", { name: "Republicar catálogo em todas as lojas" }).click();
    await expect(page.locator("#toast")).toContainText("Catálogo atualizado", { timeout: 10000 });
    expect(itens(await db(page)).map((x: any) => x.id)).toEqual(["rX"]);
    expect(erros).toEqual([]);
  });
});

test.describe("VR1 variações", () => {
  const itens = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
  test("VR1-H1 revendedora muda, tira e volta a variação de uma peça da Veraneio", async ({ page }) => {
    const s = seed(10);
    const at = s["atacado/p0"].itens; at[2] = { ...at[2], var: { nome: "Tamanhos", ops: ["12", "14", "16"] } };
    const erros = await preparar(page, { seed: s });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 2", exact: true }).click();
    await expect(page.locator("#vfBox")).toContainText("Da Veraneio: Tamanhos: 12, 14, 16");
    await expect(page.locator("#vfO")).toHaveValue("12, 14, 16");
    await page.locator("#vfN").fill("Aro");
    await page.locator("#vfO").fill("15, 17, 17, 19");
    await page.locator("#ffOk").click();
    await publicar(page);
    let d = await db(page);
    expect(itens(d).find((x: any) => x.id === "y2").var).toEqual({ nome: "Aro", ops: ["15", "17", "19"] });
    expect(d["precos/u1"].vars.y2).toEqual({ nome: "Aro", ops: ["15", "17", "19"] });
    // tira a variação
    await page.getByRole("button", { name: "Editar peça: Peça 2", exact: true }).click();
    await page.locator("#vfO").fill("");
    await page.locator("#ffOk").click();
    await publicar(page);
    d = await db(page);
    expect(itens(d).find((x: any) => x.id === "y2").var).toBeUndefined();
    // volta a da Veraneio
    await page.getByRole("button", { name: "Editar peça: Peça 2", exact: true }).click();
    await page.getByRole("button", { name: "Usar a da Veraneio" }).click();
    await page.locator("#ffOk").click();
    await publicar(page);
    d = await db(page);
    expect(itens(d).find((x: any) => x.id === "y2").var).toEqual({ nome: "Tamanhos", ops: ["12", "14", "16"] });
    expect(d["precos/u1"].vars?.y2).toBeUndefined();
    // inclui variação numa peça que não tinha
    await page.getByRole("button", { name: "Editar peça: Peça 3", exact: true }).click();
    await page.locator("#vfN").fill("Cor");
    await page.locator("#vfO").fill("Dourado, Prata");
    await page.locator("#ffOk").click();
    await publicar(page);
    d = await db(page);
    expect(itens(d).find((x: any) => x.id === "y3").var).toEqual({ nome: "Cor", ops: ["Dourado", "Prata"] });
    expect(erros).toEqual([]);
  });
  test("VR1-H2 peça própria com variação de nome livre", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(10) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Nova peça" }).click();
    await page.locator("#npN").fill("Pulseira Nome");
    await page.locator("#npP").fill("59,90");
    await page.locator("#vfN").fill("Letra");
    await page.locator("#vfO").fill("A, B, C");
    await page.locator("#npOk").click();
    await publicar(page);
    const d = await db(page);
    const p = itens(d).find((x: any) => x.nome === "Pulseira Nome");
    expect(p.var).toEqual({ nome: "Letra", ops: ["A", "B", "C"] });
    expect(erros).toEqual([]);
  });
});

test.describe("CJ1 compre junto no painel", () => {
  const itens = (d: any) => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
  test("CJ1-H1 escolhe até 3 peças, tira uma, publica e reabre com as escolhidas", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(10) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Editar peça: Peça 2", exact: true }).click();
    const q = page.locator("#jcQ");
    for (const n of ["Peça 5", "Peça 6", "Peça 7"]) {
      await q.fill(n);
      await page.locator("#jcR").getByRole("button", { name: n, exact: true }).click();
    }
    await expect(page.locator("#jcC .jchip")).toHaveCount(3);
    await expect(q).toBeDisabled();
    await page.getByRole("button", { name: "Tirar Peça 6" }).click();
    await q.fill("Peça 2");
    await expect(page.locator("#jcR")).toContainText("Nenhuma peça encontrada"); // a própria peça não aparece
    await q.fill("Peça 8");
    await page.locator("#jcR").getByRole("button", { name: "Peça 8", exact: true }).click();
    await page.locator("#ffOk").click();
    await publicar(page);
    let d = await db(page);
    expect(d["precos/u1"].juntos).toEqual({ y2: ["y5", "y7", "y8"] });
    expect(itens(d).find((x: any) => x.id === "y2").juntos).toEqual(["y5", "y7", "y8"]);
    // reabrir mostra as escolhidas
    await page.getByRole("button", { name: "Editar peça: Peça 2", exact: true }).click();
    await expect(page.locator("#jcC")).toContainText("Peça 5");
    await expect(page.locator("#jcC .jchip")).toHaveCount(3);
    expect(erros).toEqual([]);
  });
  test("CJ1-H2 peça própria com compre junto", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(10) });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Nova peça" }).click();
    await page.locator("#npN").fill("Pulseira Junto");
    await page.locator("#npP").fill("59,90");
    await page.locator("#jcQ").fill("Peça 1");
    await page.locator("#jcR").getByRole("button", { name: "Peça 1", exact: true }).click();
    await page.locator("#npOk").click();
    await publicar(page);
    const d = await db(page);
    const p = itens(d).find((x: any) => x.nome === "Pulseira Junto");
    expect(p.juntos).toEqual(["y1"]);
    expect(erros).toEqual([]);
  });
});

test.describe("AV1 avaliações no painel", () => {
  const pend = (id: string, produto: string, nome: string, nota: number, texto: string, t: number) =>
    ({ [`lojas/u1/avaliacoes/${id}`]: { produto, nome, nota, texto, status: "pendente", ts: { __ts: t } } });
  const base = () => seed(10, {
    ...pend("AAAAAAAAAAAAAAAAAAA1", "y2", "Ana", 5, "Amei a peça!", Date.UTC(2026, 10, 20)),
    ...pend("AAAAAAAAAAAAAAAAAAA2", "y2", "<b>Bia</b>", 3, '<img src=x onerror="window.__xss=1">', Date.UTC(2026, 10, 21)),
    ...pend("AAAAAAAAAAAAAAAAAAA3", "y3", "Cris", 4, "", Date.UTC(2026, 10, 22)),
  });
  test("AV1-H1 Início avisa, aprova duas, exclui uma; loja recebe as aprovadas e o resumo", async ({ page }) => {
    const erros = await preparar(page, { seed: base() });
    await entrar(page);
    await expect(page.getByText("3 avaliações esperando você")).toBeVisible();
    await page.getByRole("button", { name: "Ver avaliações" }).click();
    const avs = page.locator("#avs");
    await expect(avs.locator(".lc")).toHaveCount(3);
    await expect(avs).toContainText("<b>Bia</b>");
    await expect(avs).toContainText("Peça 2");
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    await avs.locator(".lc", { hasText: "Ana" }).getByRole("button", { name: "Aprovar" }).click();
    await expect(page.locator("#toast")).toContainText("aprovada");
    await expect(avs.locator(".lc")).toHaveCount(2);
    await avs.locator(".lc", { hasText: "Cris" }).getByRole("button", { name: "Aprovar" }).click();
    await expect(avs.locator(".lc")).toHaveCount(1);
    const ex = avs.locator(".lc", { hasText: "Bia" }).getByRole("button", { name: "Excluir" });
    await ex.click();
    await avs.locator(".lc", { hasText: "Bia" }).getByRole("button", { name: "Toque de novo para excluir" }).click();
    await expect(avs).toContainText("Nenhuma avaliação esperando aprovação");
    const d = await db(page);
    expect(Object.keys(d).filter((k) => k.startsWith("lojas/u1/avaliacoes/"))).toEqual([]);
    expect(d["lojas/u1/avaliacoesPub/y2"]).toMatchObject({ n: 1, media: 5, itens: [{ nome: "Ana", nota: 5, texto: "Amei a peça!", ts: Date.UTC(2026, 10, 20) }] });
    expect(d["lojas/u1/avaliacoesPub/y3"]).toMatchObject({ n: 1, media: 4 });
    expect(d["lojas/u1/pub/resumoAvaliacoes"]).toEqual({ y2: { n: 1, media: 5 }, y3: { n: 1, media: 4 } });
    expect(erros).toEqual([]);
  });
  test("AV1-H2 média com várias avaliações e tirar uma publicada da loja", async ({ page }) => {
    const s = base();
    s["lojas/u1/avaliacoesPub/y2"] = { n: 2, media: 3, itens: [{ nome: "Duda", nota: 2, texto: "ok", ts: 1 }, { nome: "Eva", nota: 4, texto: "", ts: 2 }] };
    s["lojas/u1/pub/resumoAvaliacoes"] = { y2: { n: 2, media: 3 } };
    const erros = await preparar(page, { seed: s });
    await entrar(page);
    await aba(page, "Pedidos").click();
    await page.getByRole("button", { name: /^Avaliações \(3\)$/ }).click();
    await page.locator("#avs .lc", { hasText: "Ana" }).getByRole("button", { name: "Aprovar" }).click();
    await expect(page.locator("#avs .lc")).toHaveCount(2);
    let d = await db(page);
    expect(d["lojas/u1/avaliacoesPub/y2"]).toMatchObject({ n: 3, media: 3.7 });
    expect(d["lojas/u1/avaliacoesPub/y2"].itens.map((x: any) => x.nome)).toEqual(["Ana", "Duda", "Eva"]);
    await page.getByRole("button", { name: "Ver avaliações publicadas" }).click();
    const pub = page.locator("#avPub");
    await expect(pub.locator(".lc")).toHaveCount(3);
    await pub.locator(".lc", { hasText: "Duda" }).getByRole("button", { name: "Tirar da loja" }).click();
    await pub.locator(".lc", { hasText: "Duda" }).getByRole("button", { name: "Toque de novo para tirar" }).click();
    await expect(pub.locator(".lc")).toHaveCount(2);
    d = await db(page);
    expect(d["lojas/u1/avaliacoesPub/y2"]).toMatchObject({ n: 2, media: 4.5 });
    expect(d["lojas/u1/pub/resumoAvaliacoes"].y2).toEqual({ n: 2, media: 4.5 });
    for (const n of ["Ana", "Eva"]) {
      await pub.locator(".lc", { hasText: n }).getByRole("button", { name: "Tirar da loja" }).click();
      await pub.locator(".lc", { hasText: n }).getByRole("button", { name: "Toque de novo para tirar" }).click();
      await expect(pub.locator(".lc", { hasText: n })).toHaveCount(0);
    }
    await expect(pub).toContainText("Nenhuma avaliação publicada");
    d = await db(page);
    expect(d["lojas/u1/avaliacoesPub/y2"]).toBeUndefined();
    expect(d["lojas/u1/pub/resumoAvaliacoes"].y2).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(erros).toEqual([]);
  });
});

test.describe("AR1 gerador de arte", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAQUlEQVR4Xu3QQQ3AIADAQEAD/vUgi8zE8VjPQJPOs/d4Yb2IfgozrWZazbSaaTXTaqbVTKuZVjOtZlrNtJr53+oLwKgBQN3bd6IAAAAASUVORK5CYII=", "base64");
  const pixel = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => Array.from((document.getElementById("arC") as HTMLCanvasElement).getContext("2d")!.getImageData(x, y, 1, 1).data).slice(0, 3), [x, y]);
  test("AR1-H1 story e post com a foto da peça (via wsrv), modelos, preço e download em JPEG", async ({ page }) => {
    const pedidos: string[] = [];
    const s = seed(10, { "lojas/u1": { ...seed(1)["lojas/u1"], insta: "@kailane", cor: "#7a1030" }, "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y2"], promos: { y2: 10 } } });
    const erros = await preparar(page, { seed: s });
    await page.route(/wsrv\.nl/, (r) => { pedidos.push(r.request().url()); return r.fulfill({ contentType: "image/png", body: PNG }); });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Gerar arte: Peça 2" }).click();
    await expect(page.locator("#arMsg")).toHaveText("Escolha o modelo e o formato e toque em Baixar.");
    expect(pedidos[0]).toContain("url=" + encodeURIComponent(FOTO));
    expect(pedidos[0]).toContain("output=jpg");
    const cv = page.locator("#arC");
    expect(await cv.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1080, 1920]);
    // foto desenhada (vermelha) no meio da moldura; fundo creme
    expect(await pixel(page, 540, 770)).toEqual([200, 20, 20]);
    expect(await pixel(page, 10, 10)).toEqual([246, 240, 230]);
    // cor da loja
    await page.locator("#arM").getByRole("button", { name: "Cor da loja" }).click();
    expect(await pixel(page, 10, 10)).toEqual([122, 16, 48]);
    // post 1:1
    await page.locator("#arF").getByRole("button", { name: "Post 1:1" }).click();
    expect(await cv.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1080, 1080]);
    await page.locator("#arM").getByRole("button", { name: "Oferta" }).click();
    await page.locator("#arP").uncheck();
    // a imagem pode ser exportada (canvas não "contaminado")
    expect(await cv.evaluate((c: HTMLCanvasElement) => c.toDataURL("image/jpeg").length)).toBeGreaterThan(1000);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar / compartilhar" }).click()]);
    expect(dl.suggestedFilename()).toBe("peca-2-post.jpg");
    expect(erros).toEqual([]);
  });
  test("AR1-E1 foto não carrega: avisa e ainda gera a arte sem foto", async ({ page }) => {
    const erros = await preparar(page, { seed: seed(10) });
    await page.route(/wsrv\.nl/, (r) => r.fulfill({ status: 500, body: "x" }));
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Gerar arte: Peça 3" }).click();
    await expect(page.locator("#arMsg")).toContainText("Não foi possível carregar a foto");
    await expect(page.getByRole("button", { name: "Baixar / compartilhar" })).toBeEnabled();
    expect(erros).toEqual([]);
  });
  test("AR1-H2 peça própria usa a foto da revendedora (sem passar pelo wsrv)", async ({ page }) => {
    const foto = "data:image/png;base64," + PNG.toString("base64");
    const s = seed(10, { "lojas/u1/proprios/r1": { nome: "Pulseira Minha", cat: "Pulseiras", preco: 80, fotosN: 1, fotosV: 5 }, "lojas/u1/fotos/r1~5": { fotos: [foto], v: 5 } });
    const erros = await preparar(page, { seed: s });
    let wsrv = 0; await page.route(/wsrv\.nl/, (r) => { wsrv++; return r.abort(); });
    await entrar(page);
    await aba(page, "Peças").click();
    await page.getByRole("button", { name: "Gerar arte: Pulseira Minha" }).click();
    await expect(page.locator("#arMsg")).toHaveText("Escolha o modelo e o formato e toque em Baixar.");
    expect(await pixel(page, 540, 770)).toEqual([200, 20, 20]);
    expect(wsrv).toBe(0);
    expect(erros).toEqual([]);
  });
});
