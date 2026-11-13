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
  // preço fixo digitado pela revendedora para esta peça: vale como está (sem margem nem arredondamento), nunca abaixo do atacado
  const fx = pr.fixo && Number(pr.fixo[id]);
  if (fx > 0) return Math.max(Math.round(fx * 100) / 100, base);
  const o = pr.over && pr.over[id];
  let m = Math.max(0, (o === undefined || o === null || o === "") ? Number(pr.margem || 0) : Number(o));
  if (!Number.isFinite(m)) m = Math.max(0, Number(pr.margem) || 0);
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

/** peças próprias da revendedora (lojas/{uid}/proprios): só a dona e o ADM leem */
export async function lerProprios(F, db, uid) {
  const s = await F.getDocs(F.collection(db, "lojas", uid, "proprios"));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** opções digitadas pela revendedora ("16, 17, 18") → variação no formato da loja */
export function opcoesProprias(txt, nome = "Tamanhos") {
  const ops = [...new Set(String(txt || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 40);
  return ops.length ? { nome, ops } : null;
}

/**
 * Monta e publica o catálogo público de uma loja (dona ou ADM).
 * Fotos próprias (dataURL) NÃO entram no catálogo (ficam em lojas/{uid}/fotos/{peça}); a peça leva só
 * `fp:{n,v}` (quantas fotos e versão) e a loja busca as fotos quando precisa mostrar.
 */
/* desconto da revendedora (% de 1 a 90) sobre o preço da loja; peça da Veraneio nunca fica abaixo do atacado */
export function pctPromo(v) { const n = Math.round(Number(v) || 0); return n >= 1 && n <= 90 ? n : 0; }
export function comPromo(preco, pct, piso = 0) {
  const p = pctPromo(pct); if (!p || !(preco > 0)) return { preco };
  const novo = Math.max(Math.round(preco * (100 - p)) / 100, Math.round((Number(piso) || 0) * 100) / 100);
  return novo < preco - 0.004 ? { preco: novo, de: preco } : { preco };
}
export async function publicarLoja(F, db, uid, precos, atacado, proprios) {
  // dados da revendedora podem vir malformados: normaliza tudo antes de usar
  const src = precos && typeof precos === "object" ? precos : {};
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  const pr = { margem: 100, arred: "90", ...src, over: obj(src.over), fixo: obj(src.fixo), fotos: obj(src.fotos), nomes: obj(src.nomes), descs: obj(src.descs), promos: obj(src.promos), pronta: arr(src.pronta), ocultas: arr(src.ocultas) };
  if (!Number.isFinite(Number(pr.margem))) pr.margem = 100;
  const pe = new Set(pr.pronta), oc = new Set(pr.ocultas), fo = pr.fotos;
  const nFotos = (n) => Math.min(3, Math.max(0, Math.floor(Number(n) || 0)));
  // "publicados": republicação feita pelo ADM — mantém as peças próprias exatamente como a revendedora publicou
  // (o que ela editou e ainda não publicou não pode ir para a loja)
  const velhas = await F.getDocs(F.collection(db, "catalogos", uid, "partes"));
  let prontos = null;
  if (proprios === "publicados") { prontos = velhas.docs.flatMap((d) => (d.data().itens || []).filter((x) => x && x.proprio)); proprios = []; }
  else if (!proprios) { try { proprios = await lerProprios(F, db, uid); } catch (e) { proprios = []; } }
  const so = pr.modo === "pronta";
  const vale = (id) => !oc.has(id) && (!so || pe.has(id));
  const itens = atacado.filter((p) => vale(p.id)).map((p) => {
    const f = fo[p.id] && nFotos(fo[p.id].n) ? fo[p.id] : null;
    return {
      id: p.id, nome: String(pr.nomes[p.id] || "").trim().slice(0, 80) || p.nome || "", cat: p.cat || "", banho: p.banho || "",
      // descrição: só a que a revendedora escreveu (a da Veraneio/Yampi não vai para a loja)
      descricao: String(pr.descs[p.id] || "").trim().slice(0, 600),
      fotos: f ? [] : (p.fotos || []).slice(0, 4), novo: !!p.novo, ordem: p.ordem ?? 999,
      ...comPromo(precoFinal(p.preco, pr, p.id), pr.promos[p.id], p.preco),
      ...(f ? { fp: { n: nFotos(f.n), v: Number(f.v) || 1 } } : {}),
      ...(p.var ? { var: p.var } : {}), ...(p.rank != null ? { rank: p.rank } : {}),
      ...(pe.has(p.id) ? { pronta: true } : {}),
    };
  });
  // peças próprias: preço de venda que a revendedora digitou, sem margem; aparecem primeiro na vitrine
  const meus = (proprios || []).filter((p) => vale(p.id) && Number(p.preco) > 0).map((p) => ({
    id: p.id, nome: String(p.nome || "").trim(), cat: p.cat || "Outras", banho: p.banho || "", desc: p.desc || "",
    fotos: [], ...(nFotos(p.fotosN) ? { fp: { n: nFotos(p.fotosN), v: Number(p.fotosV) || 1 } } : {}),
    novo: !!p.novo, ordem: 0, ...comPromo(Math.round(Number(p.preco) * 100) / 100, pr.promos[p.id]), proprio: true,
    ...(p.var && p.var.ops && p.var.ops.length ? { var: p.var } : {}),
    ...(pe.has(p.id) ? { pronta: true } : {}),
  }));
  const todos = [...(prontos || meus), ...itens];
  const ps = partes(todos);
  const b = F.writeBatch(db);
  ps.forEach((p, i) => b.set(F.doc(db, "catalogos", uid, "partes", "p" + i), { itens: p, em: F.serverTimestamp() }));
  velhas.docs.forEach((d) => { if (Number(d.id.slice(1)) >= ps.length) b.delete(d.ref); });
  await b.commit();
  return todos.length;
}

/** converte um produto do ADM no formato do catálogo de atacado */
export function paraAtacado(p) {
  return {
    id: p.id, nome: p.nome || "", cat: p.cat || "", banho: p.banho || "",
    desc: String(p.desc || "").slice(0, 220), fotos: (p.fotos || []).slice(0, 4),
    novo: !!p.novo, ordem: p.ordem ?? 999, preco: Number(p.preco) || 0,
    ...(p.var && p.var.ops && p.var.ops.length ? { var: p.var } : {}),
    ...(p.rank != null ? { rank: p.rank } : {}),
  };
}
export const ativoNaLoja = (p) => p.ativo !== false && !p.esgotado && Number(p.preco) > 0;

/* ---------------- Yampi (API pública da loja, sem token) ---------------- */
export const YAMPI_ALIAS = "veraneio";
export const YAMPI_CATEGORIAS = [
  "aneis", "brincos", "colares", "pulseiras", "bracelete", "tornozeleiras",
  "pingentes", "berloques", "conjuntos", "pecas-masculinas", "personalizados", "kits",
  "semi-joias-ouro", "porta-joias", "novidades/piercing", "pecas-para-iniciantes", "ofertas",
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
  // preço atual (com a promoção, se houver) e preço cheio (o "de", sem promoção)
  let preco = Number(pr.price) || Number(pr.price_sale) || 0;
  const disc = Number(pr.price_discount) || 0;
  if (disc > 0 && disc < preco) preco = disc;
  const cheio = Math.max(preco, Number(pr.price_sale) || 0, Number(pr.price) || 0);
  const fotos = [];
  for (const i of [...lista(p.images), ...lista(p.skus).flatMap((s) => lista(s.images))]) {
    const u = i && (i.url || (i.large && i.large.url));
    if (u && !fotos.includes(u)) fotos.push(u);
    if (fotos.length >= 4) break;
  }
  // variações (tamanho, letra, signo…): só as que estão à venda na Yampi
  const skus = lista(p.skus);
  let variacao = null;
  if (p.has_variations && skus.length > 1) {
    const ok = skus.filter((k) => !k.blocked_sale && (k.variations || []).length);
    const nome = ((skus.find((k) => (k.variations || []).length) || {}).variations || []).map((v) => v.name).join(" / ") || "Opção";
    const ops = [...new Set(ok.map((k) => k.variations.map((v) => String(v.value).trim()).join(" / ")))].filter(Boolean);
    if (ops.length) variacao = { nome, ops: ops.slice(0, 60) };
  }
  const cats = lista(p.categories).map((c) => c.name).filter((n) => !/^(novidades|ofertas|lan[çc]amentos|mais vendidos)$/i.test(String(n).trim()));
  return {
    yampiId: String(p.id), slug: p.slug || "", nome: String(p.name || "").trim(),
    cat: catNome || cats[0] || "", preco: Math.round(preco * 100) / 100, precoCheio: Math.round(cheio * 100) / 100,
    emPromocao: cheio - preco > 0.004, fotos,
    desc: semHtml(p.description), banhoSugerido: banho(`${p.name} ${cats.join(" ")}`),
    bloqueado: !!p.blocked_sale || (!!p.has_variations && skus.length > 1 && !variacao),
    var: variacao,
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
  const produtos = new Map(), novidades = new Set(), ranks = new Map();
  const todas = [...categorias, "novidades"];
  for (let ci = 0; ci < todas.length; ci++) {
    const slug = todas[ci];
    const c = await get(`search/products/count?context=category&slug=${encodeURI(slug)}&limit=100`).catch(() => null);
    const pages = (c && c.data && c.data.total_pages) || 1;
    for (let page = 1; page <= pages; page++) {
      progresso(`Buscando ${slug} (${ci + 1}/${todas.length}) · página ${page}/${pages} · ${produtos.size} peças`);
      const j = await get(`search/products?context=category&slug=${encodeURI(slug)}&limit=100&page=${page}&sort_by=best_sellers&include=skus,images,categories`);
      const nome = (j.meta && j.meta.name) || "";
      let pos = (page - 1) * 100;
      for (const p of lista(j)) {
        pos++;
        if (slug !== "novidades") { const r = ranks.get(String(p.id)); if (r == null || pos < r) ranks.set(String(p.id), pos); }
        if (slug === "novidades") { novidades.add(String(p.id)); if (produtos.has(String(p.id))) continue; }
        if (!produtos.has(String(p.id))) produtos.set(String(p.id), mapear(p, slug === "novidades" ? "" : nome));
      }
    }
  }
  for (const [id, r] of ranks) { const m = produtos.get(id); if (m) m.rank = r; }
  return { produtos, novidades };
}
