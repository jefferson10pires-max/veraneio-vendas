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
  for (const p of at.slice(0, 30)) d["produtos/" + p.id] = { ...p, yampiId: p.id.slice(1), ativo: true, origem: "yampi" };
  return { ...d, ...extra };
}
const USERS = { "rev@teste.com": { senha: "senha123", uid: "u1" }, "adm@teste.com": { senha: "senha123", uid: "adm1" } };

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
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
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
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
    let d = await db(page);
    const todos = () => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens);
    expect(todos().some((x: any) => x.id === "y2")).toBe(false);
    expect(todos().length).toBe(799);
    await page.getByRole("button", { name: /Fora do site/ }).click();
    await expect(page.locator(".pr")).toHaveCount(1);
    await page.getByRole("switch", { name: "No site: Peça 2", exact: true }).check();
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
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
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
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
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
    const pr = (await db(page))["precos/u1"];
    expect(pr.ocultas).toEqual(["y3"]);
    expect(pr.pronta).toEqual([]);
  });

  test("P02-E2 mudar a margem continua funcionando e não apaga pronta entrega", async ({ page }) => {
    await preparar(page, { seed: seed(800, { "precos/u1": { margem: 100, arred: "90", over: {}, pronta: ["y5"], ocultas: ["y6"] } }) });
    await entrar(page);
    await aba(page, "Preços").click();
    await page.locator("#fM").fill("50");
    await expect(page.locator("#saved")).toHaveText(/Salvo/, { timeout: 6000 });
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
    await page.getByRole("button", { name: "Só pronta entrega" }).click();
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
    let d = await db(page);
    const ids = () => Object.keys(d).filter((k) => k.startsWith("catalogos/u1/partes/")).flatMap((k) => d[k].itens.map((x: any) => x.id));
    expect(ids()).toEqual(["y1"]);
    expect(d["lojas/u1"].modo).toBe("pronta");
    expect(d["precos/u1"].modo).toBe("pronta");
    await expect(page.locator("#modoHint")).toContainText("só a 1 peça marcada");
    await expect(page.getByRole("switch", { name: "No site: Peça 1", exact: true })).toHaveCount(0);
    // marcar outra peça (mesmo que antes estivesse fora do site) coloca ela na loja
    await page.getByPlaceholder("Pesquisar peça").fill("Peça 7");
    await page.getByRole("switch", { name: "Pronta entrega: Peça 7", exact: true }).check();
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
    d = await db(page);
    expect(ids().sort()).toEqual(["y1", "y7"]);
    await page.getByRole("button", { name: "Catálogo todo" }).click();
    await expect(page.locator("#pcStatus")).toHaveText(/Loja atualizada/, { timeout: 6000 });
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
