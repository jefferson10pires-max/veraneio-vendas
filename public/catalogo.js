/**
 * Regras de catálogo e preço compartilhadas pelo painel da revendedora e pelo ADM.
 *
 *  atacado/{parte}                 → catálogo com PREÇO DE ATACADO (só usuários logados leem; o ADM escreve)
 *  catalogos/{uid}/partes/{parte}  → catálogo PÚBLICO da loja, já com o preço final
 *
 * Os dois ficam divididos em partes de até 250 peças para nunca passar do limite de 1 MB por documento.
 */
export const POR_PARTE = 250;

/** preço final da loja: margem (padrão ou por peça) sobre o atacado, com arredondamento; nunca abaixo do atacado */
export function precoFinal(base, pr, id) {
  base = Number(base) || 0;
  const o = pr.over && pr.over[id];
  const m = Math.max(0, (o === undefined || o === null || o === "") ? Number(pr.margem || 0) : Number(o));
  let v = base * (1 + m / 100);
  if (pr.arred === "90") { let r = Math.floor(v) + 0.9; if (r < v - 0.005) r += 1; v = r; }
  else if (pr.arred === "int") v = Math.ceil(v - 0.005);
  else v = Math.round(v * 100) / 100;
  return Math.max(Math.round(v * 100) / 100, base);
}

const partes = (arr) => { const out = []; for (let i = 0; i < arr.length; i += POR_PARTE) out.push(arr.slice(i, i + POR_PARTE)); return out.length ? out : [[]]; };

/** lê o catálogo de atacado (todas as partes) */
export async function lerAtacado(F, db) {
  const s = await F.getDocs(F.collection(db, "atacado"));
  return s.docs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).flatMap((d) => d.data().itens || []);
}

/** grava o catálogo de atacado em partes e apaga partes antigas (só ADM) */
export async function gravarAtacado(F, db, itens) {
  const ps = partes(itens), velhas = await F.getDocs(F.collection(db, "atacado"));
  const b = F.writeBatch(db);
  ps.forEach((p, i) => b.set(F.doc(db, "atacado", "p" + i), { itens: p, em: F.serverTimestamp() }));
  velhas.docs.forEach((d) => { if (Number(d.id.slice(1)) >= ps.length) b.delete(d.ref); });
  await b.commit();
}

/** monta e publica o catálogo público de uma loja (dona ou ADM) */
export async function publicarLoja(F, db, uid, precos, atacado) {
  const pr = { margem: 100, arred: "90", over: {}, ...(precos || {}) };
  const itens = atacado.map((p) => ({
    id: p.id, nome: p.nome || "", cat: p.cat || "", banho: p.banho || "", desc: p.desc || "",
    fotos: (p.fotos || []).slice(0, 4), novo: !!p.novo, ordem: p.ordem ?? 999,
    preco: precoFinal(p.preco, pr, p.id),
  }));
  const ps = partes(itens), velhas = await F.getDocs(F.collection(db, "catalogos", uid, "partes"));
  const b = F.writeBatch(db);
  ps.forEach((p, i) => b.set(F.doc(db, "catalogos", uid, "partes", "p" + i), { itens: p, em: F.serverTimestamp() }));
  velhas.docs.forEach((d) => { if (Number(d.id.slice(1)) >= ps.length) b.delete(d.ref); });
  await b.commit();
  return itens.length;
}

/** converte um produto do ADM no formato do catálogo de atacado */
export function paraAtacado(p) {
  return {
    id: p.id, nome: p.nome || "", cat: p.cat || "", banho: p.banho || "",
    desc: String(p.desc || "").slice(0, 220), fotos: (p.fotos || []).slice(0, 4),
    novo: !!p.novo, ordem: p.ordem ?? 999, preco: Number(p.preco) || 0,
  };
}
export const ativoNaLoja = (p) => p.ativo !== false && !p.esgotado && Number(p.preco) > 0;

/* ---------------- Yampi (API pública da loja, sem token) ---------------- */
export const YAMPI_ALIAS = "veraneio";
export const YAMPI_CATEGORIAS = [
  "aneis", "brincos", "colares", "pulseiras", "bracelete", "tornozeleiras",
  "pingentes", "berloques", "conjuntos", "pecas-masculinas", "personalizados", "kits",
];

const semHtml = (s) => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim().slice(0, 220);
const lista = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.data) ? x.data : []);
function banho(t) {
  t = String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/rodio negro|rodio preto|grafite/.test(t)) return "Ródio negro";
  if (/rodio|prateado|prata/.test(t)) return "Ródio branco";
  if (/rose/.test(t)) return "Ouro rosé";
  if (/ouro|dourad|18k/.test(t)) return "Ouro 18k";
  return "";
}
function mapear(p, catNome) {
  const pr = (p.prices && p.prices.data) || {};
  let preco = Number(pr.price) || Number(pr.price_sale) || 0;
  const disc = Number(pr.price_discount) || 0;
  if (disc > 0 && disc < preco) preco = disc;
  const fotos = [];
  for (const i of [...lista(p.images), ...lista(p.skus).flatMap((s) => lista(s.images))]) {
    const u = i && (i.url || (i.large && i.large.url));
    if (u && !fotos.includes(u)) fotos.push(u);
    if (fotos.length >= 4) break;
  }
  const cats = lista(p.categories).map((c) => c.name).filter((n) => !/^(novidades|ofertas|lan[çc]amentos|mais vendidos)$/i.test(String(n).trim()));
  return {
    yampiId: String(p.id), slug: p.slug || "", nome: String(p.name || "").trim(),
    cat: catNome || cats[0] || "", preco: Math.round(preco * 100) / 100, fotos,
    desc: semHtml(p.description), banhoSugerido: banho(`${p.name} ${cats.join(" ")}`),
    bloqueado: !!p.blocked_sale,
  };
}

/**
 * Busca o catálogo na Yampi, categoria por categoria.
 * @param {(msg:string)=>void} progresso
 * @returns {Promise<{produtos:Map<string,object>, novidades:Set<string>}>}
 */
export async function buscarYampi(categorias, progresso = () => {}) {
  const B = `https://api.dooki.com.br/v2/${YAMPI_ALIAS}/public/`;
  const get = async (u) => {
    for (let t = 1; t <= 4; t++) {
      try { const r = await fetch(B + u); if (r.ok) return r.json(); if (r.status < 500 && r.status !== 429) throw new Error(`Yampi respondeu ${r.status}`); }
      catch (e) { if (t === 4) throw e; }
      await new Promise((r) => setTimeout(r, 1500 * t));
    }
  };
  const produtos = new Map(), novidades = new Set();
  const todas = [...categorias, "novidades"];
  for (let ci = 0; ci < todas.length; ci++) {
    const slug = todas[ci];
    const c = await get(`search/products/count?context=category&slug=${encodeURIComponent(slug)}&limit=100`).catch(() => null);
    const pages = (c && c.data && c.data.total_pages) || 1;
    for (let page = 1; page <= pages; page++) {
      progresso(`Buscando ${slug} (${ci + 1}/${todas.length}) · página ${page}/${pages} · ${produtos.size} peças`);
      const j = await get(`search/products?context=category&slug=${encodeURIComponent(slug)}&limit=100&page=${page}&include=skus,images,categories`);
      const nome = (j.meta && j.meta.name) || "";
      for (const p of lista(j)) {
        if (slug === "novidades") { novidades.add(String(p.id)); if (produtos.has(String(p.id))) continue; }
        if (!produtos.has(String(p.id))) produtos.set(String(p.id), mapear(p, slug === "novidades" ? "" : nome));
      }
    }
  }
  return { produtos, novidades };
}
