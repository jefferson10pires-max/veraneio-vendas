/**
 * Testes da vitrine da cliente final (loja pública), no celular (Pixel 7).
 * Rodam no modo demonstração com dados injetados (window.__VRN_DEMO), sem tocar no Firebase real.
 *   npx playwright test
 */
import { test, expect, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const FOTO_OK = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ddd"/></svg>');
const FOTO_QUEBRADA = "http://localhost:5055/foto-que-nao-existe.jpg";

type Item = { id: string; nome: string; cat: string; banho?: string; preco: number; novo?: boolean; ordem?: number; fotos?: string[]; var?: any };
function loja(extra: any = {}) {
  return {
    nome: "Loja Teste", cor: "#043034", frase: "Semijoias", sobre: "Sobre a loja", whats: "(22) 99999-0000", insta: "@teste",
    aviso: "Frete grátis acima de R$ 199", frete: 199, freteRegra: "acima", parcelas: 3, banners: [], status: "ativa",
    barra: { modo: "frete" }, rodape: { horario: "Seg a sáb", info: ["Garantia de 1 ano"] }, ...extra,
  };
}
const base: Item[] = [
  { id: "a1", nome: "Anel Solitário A01", cat: "Anéis", preco: 39.9, fotos: [FOTO_OK], var: { nome: "Tamanhos", ops: ["12", "14", "16"] } },
  { id: "b1", nome: "Brinco Gota Cristal", cat: "Brincos", preco: 59.9, fotos: [FOTO_OK], novo: true },
  { id: "b2", nome: "Argola Pronta", cat: "Brincos", preco: 30, fotos: ["https://images.yampi.me/assets/stores/veraneio/uploads/images/argola-large.jpg"], pronta: true } as any,
  { id: "c1", nome: "Colar Ponto de Luz", cat: "Colares", preco: 89.9, fotos: [FOTO_QUEBRADA, FOTO_OK] },
  { id: "c2", nome: "Colar Novidade Real", cat: "Novidades", preco: 49.9, fotos: [FOTO_OK], novo: true },
  { id: "p1", nome: "Pulseira Riviera 💎 Edição Especial de Fim de Ano com Nome Bem Comprido", cat: "Pulseiras", preco: 119.9, fotos: [FOTO_OK] },
];
const grande = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: "g" + i, nome: `Peça ${i}`, cat: ["Anéis", "Brincos", "Colares"][i % 3], preco: 20 + (i % 50), fotos: [FOTO_OK], ordem: i }));

async function abrir(page: Page, itens: Item[] = base, lojaExtra: any = {}, fotos: any = {}) {
  const erros: string[] = [];
  page.on("pageerror", (e) => erros.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com|gstatic\.com\/firebasejs/, (r) => r.abort());
  await page.addInitScript(([l, i, f]) => { (window as any).__VRN_DEMO = { loja: l, itens: i, fotos: f }; if (!sessionStorage.getItem("limpo")) { localStorage.clear(); sessionStorage.setItem("limpo", "1"); } }, [loja(lojaExtra), itens, fotos] as const);
  await page.goto("/loja-teste?demo");
  await expect(page.locator("#shop")).toBeVisible();
  return erros;
}
const card = (page: Page, nome: string) => page.locator(".card", { hasText: nome }).first();

test.describe("F01 abrir a loja", () => {
  test("F01-H1 abre com nome, sem erros e sem rolagem lateral", async ({ page }) => {
    const erros = await abrir(page);
    await expect(page).toHaveTitle("Loja Teste");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(erros).toEqual([]);
  });
  test("F01-E1 catálogo grande (800 peças) abre rápido e não desenha tudo de uma vez", async ({ page }) => {
    const t = Date.now();
    await abrir(page, grande(800));
    expect(Date.now() - t).toBeLessThan(2500);
    expect(await page.locator("#cat .card").count()).toBeLessThanOrEqual(60);
    await page.getByRole("button", { name: /carregar mais/i }).click();
    expect(await page.locator("#cat .card").count()).toBeGreaterThan(40);
  });
});

test.describe("F02 navegar e buscar", () => {
  test("F02-H1 busca ignora acento", async ({ page }) => {
    await abrir(page);
    await page.locator("#q").fill("solitario");
    await expect(page.locator("#cat .card")).toHaveCount(1);
    await expect(card(page, "Anel Solitário")).toBeVisible();
  });
  test("F02-H2 categoria pelo menu filtra", async ({ page }) => {
    await abrir(page);
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.locator("#dnav").getByRole("button", { name: /^Brincos/ }).click();
    await expect(page.locator("#cat h2")).toHaveText("Brincos");
    await expect(page.locator("#cat .card")).toHaveCount(2);
  });
  test("F02-E1 'Novidades' aparece uma vez só no menu", async ({ page }) => {
    await abrir(page);
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await expect(page.locator("#dnav").getByRole("button", { name: /^Novidades/ })).toHaveCount(1);
  });
  test("F02-E2 busca sem resultado mostra aviso", async ({ page }) => {
    await abrir(page);
    await page.locator("#q").fill("xyzxyz");
    await expect(page.getByText("Nenhum produto encontrado")).toBeVisible();
  });
});

test.describe("F03 ficha do produto", () => {
  test("F03-H1 quantidade e adicionar", async ({ page }) => {
    await abrir(page);
    await card(page, "Brinco Gota").locator(".name").click();
    await page.getByRole("button", { name: "Aumentar" }).first().click();
    await page.getByRole("button", { name: /adicionar ao carrinho/i }).click();
    await expect(page.locator("#badge")).toHaveText("2");
  });
  test("F03-E1 botão voltar do celular fecha a ficha e continua na loja", async ({ page }) => {
    await abrir(page);
    await card(page, "Brinco Gota").locator(".name").click();
    await expect(page.locator("#pSheet")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#pSheet")).toBeHidden();
    await expect(page.locator("#shop")).toBeVisible();
  });
  test("F03-E2 peça com tamanho exige escolher antes de adicionar", async ({ page }) => {
    await abrir(page);
    await card(page, "Anel Solitário").locator(".name").click();
    await page.getByRole("button", { name: /adicionar ao carrinho/i }).click();
    await expect(page.getByText(/escolha o tamanho/i)).toBeVisible();
    await expect(page.locator("#badge")).toHaveText("0");
    await page.getByRole("radio", { name: "16" }).click();
    await page.getByRole("button", { name: /adicionar ao carrinho/i }).click();
    await expect(page.locator("#badge")).toHaveText("1");
  });
  test("F03-E3 botão rápido de carrinho em peça com tamanho abre a ficha", async ({ page }) => {
    await abrir(page);
    await card(page, "Anel Solitário").getByRole("button", { name: /adicionar/i }).click();
    await expect(page.locator("#pSheet")).toBeVisible();
    await expect(page.locator("#badge")).toHaveText("0");
  });
  test("F03-E4 foto quebrada é trocada pela próxima foto", async ({ page }) => {
    await abrir(page);
    const img = card(page, "Colar Ponto de Luz").locator("img");
    await expect(img).toHaveAttribute("src", FOTO_OK);
  });
});

test.describe("F04 carrinho", () => {
  test("F04-H1 carrinho continua depois de recarregar", async ({ page }) => {
    await abrir(page);
    await card(page, "Brinco Gota").getByRole("button", { name: /adicionar/i }).click();
    await page.reload();
    await expect(page.locator("#badge")).toHaveText("1");
  });
  test("F04-H2 remover último item mostra carrinho vazio", async ({ page }) => {
    await abrir(page);
    await card(page, "Brinco Gota").getByRole("button", { name: /adicionar/i }).click();
    await page.getByRole("button", { name: "Abrir carrinho" }).click();
    await page.getByRole("button", { name: "Remover" }).click();
    await expect(page.getByText("Seu carrinho está vazio")).toBeVisible();
  });
  test("F04-H3 barra de frete mostra quanto falta", async ({ page }) => {
    await abrir(page);
    await card(page, "Brinco Gota").getByRole("button", { name: /adicionar/i }).click();
    await page.getByRole("button", { name: "Abrir carrinho" }).click();
    await expect(page.locator("#ship")).toContainText("Faltam R$ 139,10");
  });
  test("F04-E1 tamanhos diferentes da mesma peça viram linhas separadas", async ({ page }) => {
    await abrir(page);
    for (const t of ["12", "16"]) {
      await card(page, "Anel Solitário").locator(".name").click();
      await page.getByRole("radio", { name: t }).click();
      await page.getByRole("button", { name: /adicionar ao carrinho/i }).click();
    }
    await page.getByRole("button", { name: "Abrir carrinho" }).click();
    await expect(page.locator("#lines .line")).toHaveCount(2);
    await expect(page.locator("#lines")).toContainText("Tamanhos: 16");
  });
});

test.describe("F05 finalizar pelo WhatsApp", () => {
  async function comItem(page: Page) {
    await abrir(page);
    await card(page, "Brinco Gota").getByRole("button", { name: /adicionar/i }).click();
    await page.getByRole("button", { name: "Abrir carrinho" }).click();
  }
  test("F05-N1 sem nome não finaliza", async ({ page }) => {
    await comItem(page);
    await page.locator("#bTel").fill("22999990000");
    await page.locator("#finish").click();
    await expect(page.locator("#coErr")).toContainText("nome");
  });
  test("F05-N2 telefone incompleto não finaliza", async ({ page }) => {
    await comItem(page);
    await page.locator("#bNome").fill("Maria Silva");
    await page.locator("#bTel").fill("2299999");
    await page.locator("#finish").click();
    await expect(page.locator("#coErr")).toContainText("WhatsApp");
  });
  test("F05-H1 mensagem do pedido vai completa para o WhatsApp da loja", async ({ page, context }) => {
    await comItem(page);
    await page.locator("#bNome").fill("Maria Ção 😊");
    await page.locator("#bTel").fill("22988887777");
    const href = await page.locator("#finish").getAttribute("href");
    const u = new URL(href!);
    expect(u.hostname).toBe("wa.me");
    expect(u.pathname).toBe("/5522999990000");
    const msg = u.searchParams.get("text")!;
    expect(msg).toContain("1x Brinco Gota Cristal");
    expect(msg).toContain("Total: R$");
    expect(msg).toContain("Maria Ção 😊");
    expect(msg).toContain("(22) 98888-7777");
    const [popup] = await Promise.all([context.waitForEvent("page"), page.locator("#finish").click()]);
    await popup.close();
    await expect(page.locator("#badge")).toHaveText("0");
  });
});

test.describe("A11y", () => {
  for (const [nome, passo] of [
    ["início", async (_p: Page) => {}],
    ["ficha", async (p: Page) => { await card(p, "Brinco Gota").locator(".name").click(); }],
    ["carrinho", async (p: Page) => { await card(p, "Brinco Gota").getByRole("button", { name: /adicionar/i }).click(); await p.getByRole("button", { name: "Abrir carrinho" }).click(); }],
  ] as const) {
    test(`A11Y ${nome} sem problemas graves`, async ({ page }) => {
      await abrir(page);
      await passo(page);
      const r = await new AxeBuilder({ page }).analyze();
      const graves = r.violations.filter((v) => ["serious", "critical"].includes(v.impact || "")).map((v) => `${v.id}: ${v.nodes.length}`);
      expect(graves).toEqual([]);
    });
  }
});

test.describe("F06 pronta entrega", () => {
  test("F06-H1 categoria fixa no menu, selo e aviso na mensagem", async ({ page }) => {
    await abrir(page);
    await expect(page.locator(".coll h2", { hasText: "Pronta entrega" })).toBeVisible();
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.locator("#dnav").getByRole("button", { name: /^Pronta entrega/ }).click();
    await expect(page.locator("#cat .card")).toHaveCount(1);
    await expect(page.locator("#cat .card .flag")).toHaveText("Pronta entrega");
    await page.locator("#cat .card").getByRole("button", { name: /adicionar/i }).click();
    await page.getByRole("button", { name: "Abrir carrinho" }).click();
    await page.locator("#bNome").fill("Ana");
    await page.locator("#bTel").fill("22988887777");
    const msg = new URL((await page.locator("#finish").getAttribute("href"))!).searchParams.get("text")!;
    expect(msg).toContain("Argola Pronta");
    expect(msg).toContain("pronta entrega");
  });
  test("F06-E1 sem peças a pronta entrega a categoria continua no menu com aviso", async ({ page }) => {
    await abrir(page, base.filter((p: any) => !p.pronta));
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.locator("#dnav").getByRole("button", { name: /^Pronta entrega/ }).click();
    await expect(page.getByText("No momento não há peças a pronta entrega")).toBeVisible();
  });
});

test.describe("F07 baixar foto", () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });
  test("F07-H1 baixa a foto da peça em JPEG", async ({ page }) => {
    await page.route(/wsrv\.nl/, (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }));
    await abrir(page);
    await card(page, "Argola Pronta").locator(".name").click();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar foto" }).click()]);
    expect(dl.suggestedFilename()).toBe("argola-pronta.jpg");
  });
  test("F07-N1 se o serviço de foto falhar, abre a foto para salvar", async ({ page, context }) => {
    await context.route(/wsrv\.nl/, (r) => r.fulfill({ status: 500, body: "erro" }));
    await context.route(/^https:\/\/images\.yampi\.me\//, (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }));
    await abrir(page);
    await card(page, "Argola Pronta").locator(".name").click();
    await page.evaluate(() => { (window as any).__abriu = []; window.open = ((u: string) => { (window as any).__abriu.push(u); return null; }) as any; });
    await page.getByRole("button", { name: "Baixar foto" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__abriu)).toEqual([expect.stringContaining("argola-large.jpg")]);
    await expect(page.locator("#toast")).toContainText("Salvar imagem");
  });
});

test.describe("F08 loja só pronta entrega", () => {
  test("F08-H1 sem categoria 'Pronta entrega' repetida e título 'Pronta entrega'", async ({ page }) => {
    await abrir(page, base.filter((p: any) => p.pronta), { modo: "pronta" });
    await expect(page.locator("#cat h2")).toHaveText("Pronta entrega");
    await page.getByRole("button", { name: /menu/i }).first().click().catch(() => {});
    expect(await page.locator('#dnav button[data-cat="Pronta entrega"]').count()).toBe(0);
  });
  test("F08-E1 loja sem peças mostra aviso", async ({ page }) => {
    await abrir(page, [], { modo: "pronta" });
    await expect(page.locator(".nores")).toContainText("chegando em breve");
  });
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMDAwAAA7rAQBn6dO5QAAAABJRU5ErkJggg==";
test.describe("F09 fotos e peças próprias da revendedora", () => {
  test("F09-H1 peça com foto trocada mostra a foto da revendedora no card e na ficha, e baixa", async ({ page }) => {
    const itens = [{ ...base[0], fotos: [], fp: { n: 1, v: 1 } }, { id: "r1", nome: "Brinco Próprio Lua", cat: "Brincos", banho: "", desc: "Peça da revendedora", fotos: [], fp: { n: 2, v: 1 }, preco: 89.9, proprio: true, pronta: true, ordem: 0 }, ...base.slice(1)];
    await abrir(page, itens as any, {}, { [base[0].id]: [PNG], r1: [PNG, PNG] });
    await expect.poll(() => card(page, base[0].nome).locator("img").getAttribute("src")).toMatch(/^data:image\/png/);
    await expect.poll(() => card(page, "Brinco Próprio Lua").locator("img").getAttribute("src")).toMatch(/^data:image\/png/);
    await card(page, "Brinco Próprio Lua").locator("[data-open]").first().click();
    await expect(page.locator("#gal img")).toHaveCount(2);
    await expect.poll(() => page.locator("#gal img").first().getAttribute("src")).toMatch(/^data:image/);
    await expect(page.getByRole("button", { name: "Baixar foto" })).toBeVisible();
  });
  test("F09-E1 foto própria que não existe mais vira o desenho da categoria, sem erro", async ({ page }) => {
    const erros = await abrir(page, [{ ...base[0], fotos: [], fp: { n: 1, v: 1 } }, ...base.slice(1)] as any, {}, {});
    await expect(card(page, base[0].nome).locator(".ph")).toBeVisible();
    expect(erros.filter((e) => !/ERR_UNKNOWN_URL_SCHEME|vrn:/.test(e))).toEqual([]);
  });
});

test.describe("F10 peça própria no carrinho", () => {
  test("F10-H1 peça própria com tamanho: exige escolher, vai para o carrinho e para a mensagem do WhatsApp", async ({ page }) => {
    const itens = [{ id: "rA", nome: "Anel Próprio Lua", cat: "Anéis", banho: "", desc: "", fotos: [], preco: 89.9, proprio: true, pronta: true, ordem: 0, var: { nome: "Tamanhos", ops: ["14", "16"] } }, ...base];
    await abrir(page, itens as any);
    await card(page, "Anel Próprio Lua").locator(".name").click();
    await page.getByRole("button", { name: /adicionar ao carrinho/i }).click();
    await expect(page.getByText(/escolha o tamanho/i)).toBeVisible();
    await expect(page.locator("#badge")).toHaveText("0");
    await page.getByRole("radio", { name: "16" }).click();
    await page.getByRole("button", { name: /adicionar ao carrinho/i }).click();
    await expect(page.locator("#badge")).toHaveText("1");
    await page.getByRole("button", { name: "Abrir carrinho" }).click();
    await page.locator("#bNome").fill("Maria Teste");
    await page.locator("#bTel").fill("22999990000");
    const href = await page.locator("#finish").getAttribute("href");
    const msg = decodeURIComponent(href!.split("text=")[1]).replace(/\u00a0/g, " ");
    expect(msg).toContain("1x Anel Próprio Lua — Tamanhos: 16 — R$ 89,90");
    expect(msg).toContain("✅ pronta entrega");
  });
});

test.describe("F11 nome trocado pela revendedora na loja", () => {
  test("F11-S1 nome com código aparece como texto e não executa; vai para carrinho e WhatsApp", async ({ page }) => {
    await page.addInitScript(() => { (window as any).__xss = 0; });
    const itens = [{ ...base[0], nome: '<img src=x onerror="window.__xss=1">Brinco Lua' }, ...base.slice(1)];
    await abrir(page, itens as any);
    await expect(page.getByText('<img src=x onerror="window.__xss=1">Brinco Lua').first()).toBeVisible();
    expect(await page.evaluate(() => (window as any).__xss)).toBe(0);
  });
});

test.describe("S03 auditoria de segurança — vitrine", () => {
  const JS = "javascript:localStorage.setItem('S03',1)";
  test("S03-1 'Baixar foto' nunca abre endereço javascript: (catálogo nem foto própria)", async ({ page }) => {
    const itens = [
      { id: "x1", nome: "Peca Catalogo", cat: "Anéis", preco: 30, fotos: [JS] },
      { id: "x2", nome: "Peca Propria", cat: "Anéis", preco: 30, fp: { n: 1, v: 1 } } as any,
    ];
    await abrir(page, itens, {}, { x2: [JS] });
    await page.evaluate(() => { (window as any).__abriu = []; window.open = ((u: string) => { (window as any).__abriu.push(u); return null; }) as any; });
    for (const nome of ["Peca Catalogo", "Peca Propria"]) {
      await card(page, nome).locator(".name").click();
      await page.getByRole("button", { name: "Baixar foto" }).click();
      await expect(page.locator("#toast")).toContainText("Não foi possível baixar");
      await page.keyboard.press("Escape");
    }
    expect(await page.evaluate(() => (window as any).__abriu)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("S03"))).toBeNull();
  });

  test("S03-2 quantidade de fotos absurda (fp.n) não trava a ficha", async ({ page }) => {
    const erros = await abrir(page, [{ id: "x3", nome: "Peca Muitas", cat: "Anéis", preco: 30, fp: { n: 1e7, v: 1 } } as any], {}, { x3: [FOTO_OK] });
    await card(page, "Peca Muitas").locator(".name").click();
    await expect(page.getByRole("button", { name: "Baixar foto" })).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll("img").length)).toBeLessThan(20);
    expect(erros.filter((e) => !/'vrn:/.test(e))).toEqual([]);
  });
});

test.describe("H01 faixa de destaques editável", () => {
  test("H01-1 sem edição mostra o texto automático", async ({ page }) => {
    await abrir(page, base, { freteRegra: "acima", frete: 199, parcelas: 3 });
    const hl = page.locator("#hl");
    await expect(hl).toContainText("Frete grátis acima de R$ 199,00");
    await expect(hl).toContainText("Em até 3x sem juros");
    await expect(hl.locator(".hl-item")).toHaveCount(4);
  });
  test("H01-2 texto trocado, item escondido e HTML aparece como texto", async ({ page }) => {
    const erros = await abrir(page, base, { destaques: [{ t: "Entrega em 24h", s: "para Nova Friburgo" }, { off: true }, {}, { t: '<img src=x onerror="window.__h=1">', s: "" }] });
    const hl = page.locator("#hl");
    await expect(hl.locator(".hl-item")).toHaveCount(3);
    await expect(hl).toContainText("Entrega em 24h");
    await expect(hl).toContainText("para Nova Friburgo");
    await expect(hl).not.toContainText("Parcele");
    await expect(hl).toContainText("qualidade Premium");
    await expect(hl).toContainText('<img src=x onerror="window.__h=1">');
    await expect(hl).toContainText("no banho das peças");
    expect(await page.evaluate(() => (window as any).__h)).toBeUndefined();
    expect(erros).toEqual([]);
  });
  test("H01-3 todos escondidos some a faixa", async ({ page }) => {
    await abrir(page, base, { destaques: [{ off: true }, { off: true }, { off: true }, { off: true }] });
    await expect(page.locator("#hl")).toBeHidden();
  });
});

test("S04 só aparece o selo de Pronta entrega (sem 'Garantia' nem 'Novidade' nas peças)", async ({ page }) => {
  await abrir(page, [
    { id: "a1", nome: "Anel Comum", cat: "Anéis", preco: 30, fotos: [FOTO_OK] },
    { id: "a2", nome: "Anel Novo", cat: "Anéis", preco: 30, fotos: [FOTO_OK], novo: true },
    { id: "a3", nome: "Anel Pronto", cat: "Anéis", preco: 30, fotos: [FOTO_OK], pronta: true } as any,
  ]);
  await expect(page.locator("#grid .flag")).toHaveCount(1);
  await expect(card(page, "Anel Pronto").locator(".flag")).toHaveText("Pronta entrega");
  await expect(page.locator("#grid")).not.toContainText("Garantia de 1 ANO");
  await card(page, "Anel Comum").locator(".name").click();
  await expect(page.locator(".pinfo .flag")).toHaveCount(0);
});

test("S05 descrição: peça da Veraneio só mostra a descrição escrita pela revendedora", async ({ page }) => {
  await abrir(page, [
    { id: "d1", nome: "Anel Sem", cat: "Anéis", preco: 30, fotos: [FOTO_OK], desc: "Texto antigo da Yampi" },
    { id: "d2", nome: "Anel Com", cat: "Anéis", preco: 30, fotos: [FOTO_OK], desc: "Texto antigo da Yampi", descricao: "Anel regulável <b>lindo</b>\nÓtimo presente" } as any,
    { id: "d3", nome: "Anel Meu", cat: "Anéis", preco: 30, fotos: [FOTO_OK], proprio: true, desc: "Descrição da peça própria" } as any,
  ]);
  await card(page, "Anel Sem").locator(".name").click();
  await expect(page.locator(".pdesc")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Texto antigo da Yampi");
  await page.keyboard.press("Escape");
  await card(page, "Anel Com").locator(".name").click();
  await expect(page.locator(".pdesc p")).toHaveText("Anel regulável <b>lindo</b>\nÓtimo presente");
  await page.keyboard.press("Escape");
  await card(page, "Anel Meu").locator(".name").click();
  await expect(page.locator(".pdesc p")).toHaveText("Descrição da peça própria");
});
