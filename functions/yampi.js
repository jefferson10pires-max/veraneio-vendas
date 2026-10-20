/**
 * Sincronização Yampi → Firestore (produtos/)
 *
 * Lê o catálogo pela API da Yampi (https://api.dooki.com.br/v2/{alias}/catalog/products)
 * e grava cada produto em produtos/y{idYampi} com o preço de atacado.
 *
 * O que vem da Yampi (sobrescreve a cada sincronização): nome, categoria, preço, fotos,
 * descrição, ativo.
 * O que fica com você no ADM (nunca é sobrescrito): novo, ordem, esgotado, e o banho
 * depois que você editar.
 *
 * Produtos que sumirem da Yampi ficam inativos aqui (não são apagados).
 */
const BASE = "https://api.dooki.com.br/v2";
const POR_PAGINA = 50;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function semHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, 400);
}
const lista = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.data) ? x.data : []);
const num = (v) => { const n = Number(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };

function detectarBanho(texto) {
  const t = String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/rodio negro|rodio preto|grafite/.test(t)) return "Ródio negro";
  if (/rodio|prateado/.test(t)) return "Ródio branco";
  if (/rose/.test(t)) return "Ouro rosé";
  if (/\bprata\b|925/.test(t)) return "Prata";
  if (/ouro|dourad|18k/.test(t)) return "Ouro 18k";
  return "";
}

function urlImagem(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  return (img.large && img.large.url) || (img.medium && img.medium.url) || img.url || (img.original && img.original.url) || null;
}

/** Converte um produto da Yampi no formato da plataforma */
function mapear(p) {
  const skus = lista(p.skus);
  const sku = skus.find((s) => s.active !== false && s.blocked_sale !== true) || skus[0] || {};
  const venda = num(sku.price_sale ?? p.price_sale ?? p.price);
  const promo = num(sku.price_discount ?? p.price_discount);
  const preco = promo > 0 && (venda === 0 || promo < venda) ? promo : venda;

  const fotos = [];
  for (const img of [...lista(p.images), ...skus.flatMap((s) => lista(s.images))]) {
    const u = urlImagem(img);
    if (u && !fotos.includes(u)) fotos.push(u);
    if (fotos.length >= 6) break;
  }
  const cats = lista(p.categories);
  const cat = (cats[0] && cats[0].name) || (p.category && p.category.name) || "";
  const nome = String(p.name || p.title || "").trim();

  return {
    yampiId: String(p.id),
    yampiSku: sku.sku || sku.id ? String(sku.sku || sku.id) : null,
    nome,
    cat,
    preco: Math.round(preco * 100) / 100,
    fotos,
    desc: semHtml(p.description),
    ativo: p.active !== false && preco > 0,
    banhoSugerido: detectarBanho(`${nome} ${p.description || ""}`),
  };
}

async function buscarPagina(alias, token, secret, page) {
  const url = `${BASE}/${encodeURIComponent(alias)}/catalog/products?include=skus,images,categories&limit=${POR_PAGINA}&page=${page}&skipCache=true`;
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    const r = await fetch(url, {
      headers: { "User-Token": token, "User-Secret-Key": secret, "Content-Type": "application/json", Accept: "application/json" },
    });
    if (r.status === 429 || r.status >= 500) { await espera(1500 * tentativa); continue; }
    if (r.status === 401 || r.status === 403) throw new Error("A Yampi recusou o acesso. Confira o token e a chave secreta.");
    if (r.status === 404) throw new Error("Loja não encontrada na Yampi. Confira o alias.");
    if (!r.ok) throw new Error(`A Yampi respondeu com erro ${r.status}.`);
    return r.json();
  }
  throw new Error("A Yampi não respondeu depois de várias tentativas. Tente de novo em alguns minutos.");
}

/**
 * Roda a sincronização completa.
 * @returns {{total:number, novos:number, atualizados:number, desativados:number, semPreco:number}}
 */
async function sincronizarYampi({ db, FieldValue, alias, token, secret }) {
  if (!alias || !token || !secret) throw new Error("Faltam as credenciais da Yampi (alias, token e chave secreta).");

  const vistos = new Map();
  let page = 1, totalPages = 1, amostra = null;
  do {
    const resp = await buscarPagina(alias, token, secret, page);
    const itens = lista(resp);
    if (!amostra && itens[0]) amostra = Object.keys(itens[0]);
    for (const p of itens) { const m = mapear(p); if (m.nome) vistos.set(m.yampiId, m); }
    const pg = resp.meta && resp.meta.pagination;
    totalPages = pg ? Number(pg.total_pages) || 1 : (itens.length === POR_PAGINA ? page + 1 : page);
    page++;
    await espera(350);
  } while (page <= totalPages && page < 400);

  // produtos que já estão no Firestore e vieram da Yampi
  const atuais = new Map();
  const snap = await db.collection("produtos").where("yampiId", "!=", null).get();
  snap.docs.forEach((d) => atuais.set(String(d.get("yampiId")), d));

  let batch = db.batch(), ops = 0, novos = 0, atualizados = 0, desativados = 0, semPreco = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const [id, m] of vistos) {
    const ref = db.doc(`produtos/y${id}`);
    const existe = atuais.get(id);
    const { banhoSugerido, ...dados } = m;
    if (!m.ativo && m.preco <= 0) semPreco++;
    const doc = { ...dados, origem: "yampi", sincronizadoEm: FieldValue.serverTimestamp() };
    if (!existe) {
      Object.assign(doc, { banho: banhoSugerido, novo: false, esgotado: false, ordem: 999, fotosPath: [] });
      novos++;
    } else {
      if (!existe.get("banho")) doc.banho = banhoSugerido;
      atualizados++;
    }
    batch.set(ref, doc, { merge: true });
    if (++ops >= 400) await flush();
  }
  for (const [id, d] of atuais) {
    if (!vistos.has(id) && d.get("ativo") !== false) {
      batch.update(d.ref, { ativo: false, sincronizadoEm: FieldValue.serverTimestamp() });
      desativados++;
      if (++ops >= 400) await flush();
    }
  }
  await flush();

  const resumo = { total: vistos.size, novos, atualizados, desativados, semPreco };
  await db.doc("sistema/yampi").set({ ...resumo, campos: amostra || [], em: FieldValue.serverTimestamp(), erro: null });
  await db.doc("sistema/catalogo").set({ versao: FieldValue.increment(1), em: FieldValue.serverTimestamp() }, { merge: true });
  return resumo;
}

module.exports = { sincronizarYampi, mapear };
