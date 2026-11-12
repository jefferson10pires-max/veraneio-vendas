// Testes das regras do Firestore no emulador oficial (nada toca no banco real).
// Rodar: npx firebase emulators:exec --only firestore --project demo-regras "node --test e2e/regras.test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, increment, deleteField, Timestamp } from "firebase/firestore";
import { readFileSync, existsSync } from "node:fs";
import { test, before, after, beforeEach } from "node:test";

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-regras", firestore: { rules: readFileSync(process.env.REGRAS || "firestore.rules", "utf8") } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, "admins/adm"), { nome: "Jefferson" });
    await setDoc(doc(db, "lojas/rev"), { nome: "Loja Rev", slug: "loja-rev", status: "ativa", criadoEm: 1 });
    await setDoc(doc(db, "lojas/outra"), { nome: "Outra", slug: "outra", status: "ativa", criadoEm: 1 });
    await setDoc(doc(db, "atacado/p0"), { itens: [{ id: "y1", preco: 20 }] });
    await setDoc(doc(db, "produtos/y1"), { nome: "Anel", preco: 20 });
    await setDoc(doc(db, "precos/rev"), { margem: 100 });
    await setDoc(doc(db, "contas/rev"), { email: "rev@x.com", resp: "Maria Silva" });
    await setDoc(doc(db, "lojas/rev/leads/AAAAAAAAAAAAAAAAAAAA"), { nome: "Ana", tel: "1", itens: [], total: 10, status: "abandonado", ts: Timestamp.now(), uid: "rev" });
  });
});
const visitante = () => env.unauthenticatedContext().firestore();
const estranho = () => env.authenticatedContext("estranho").firestore(); // conta criada por qualquer pessoa pela API pública
const rev = () => env.authenticatedContext("rev").firestore();
const adm = () => env.authenticatedContext("adm").firestore();
const lead = (x = {}) => ({ nome: "Cliente", tel: "(22) 99999-0000", itens: [{ id: "y1", nome: "Anel", q: 1, preco: 40 }], total: 40, status: "abandonado", ts: serverTimestamp(), uid: "rev", ...x });

// --- preço de atacado ---
test("R01 visitante não lê o atacado", async () => { await assertFails(getDocs(collection(visitante(), "atacado"))); });
test("R02 conta qualquer (sem loja) NÃO lê o atacado nem produtos", async () => {
  await assertFails(getDocs(collection(estranho(), "atacado")));
  await assertFails(getDoc(doc(estranho(), "produtos/y1")));
});
test("R03 revendedora e ADM leem o atacado", async () => {
  await assertSucceeds(getDocs(collection(rev(), "atacado")));
  await assertSucceeds(getDocs(collection(adm(), "atacado")));
});
test("R04 revendedora não escreve no atacado nem vira ADM", async () => {
  await assertFails(setDoc(doc(rev(), "atacado/p0"), { itens: [] }));
  await assertFails(setDoc(doc(rev(), "admins/rev"), { nome: "eu" }));
  await assertFails(setDoc(doc(estranho(), "admins/estranho"), { nome: "eu" }));
});

// --- dados de outra revendedora ---
test("R05 revendedora não lê nem muda preços, catálogo, peças ou pedidos de outra loja", async () => {
  await assertFails(getDoc(doc(rev(), "precos/outra")));
  await assertFails(setDoc(doc(rev(), "precos/outra"), { margem: 0 }));
  await assertFails(setDoc(doc(rev(), "catalogos/outra/partes/p0"), { itens: [] }));
  await assertFails(setDoc(doc(rev(), "lojas/outra/proprios/r1"), { nome: "x" }));
  await assertFails(setDoc(doc(rev(), "lojas/outra/fotos/y1"), { fotos: ["data:"], v: 1 }));
  await assertFails(getDocs(collection(rev(), "lojas/outra/leads")));
  await assertFails(updateDoc(doc(rev(), "lojas/outra"), { nome: "Hackeada" }));
});
test("R06 conta qualquer não grava catálogo, fotos, banners nem peças (nem com o próprio uid)", async () => {
  const db = estranho();
  await assertFails(setDoc(doc(db, "catalogos/estranho/partes/p0"), { itens: [] }));
  await assertFails(setDoc(doc(db, "banners/estranho"), { itens: [] }));
  await assertFails(setDoc(doc(db, "lojas/estranho/fotos/a"), { fotos: ["x"], v: 1 }));
  await assertFails(setDoc(doc(db, "lojas/estranho/proprios/a"), { nome: "x" }));
  await assertFails(setDoc(doc(db, "precos/estranho"), { margem: 1 }));
  await assertFails(setDoc(doc(db, "lojas/estranho"), { nome: "Loja falsa", slug: "x" }));
  await assertFails(setDoc(doc(db, "slugs/loja-falsa"), { uid: "estranho" }));
});
test("R07 revendedora mexe na própria loja, mas não no endereço, situação ou dados pessoais", async () => {
  const db = rev();
  await assertSucceeds(updateDoc(doc(db, "lojas/rev"), { nome: "Novo nome", cor: "#000000" }));
  await assertFails(updateDoc(doc(db, "lojas/rev"), { slug: "outra-coisa" }));
  await assertFails(updateDoc(doc(db, "lojas/rev"), { status: "ativa2" }));
  await assertFails(updateDoc(doc(db, "lojas/rev"), { resp: "Maria" }));
  await assertSucceeds(setDoc(doc(db, "precos/rev"), { margem: 50, fixo: { y1: 30 } }));
  await assertSucceeds(setDoc(doc(db, "catalogos/rev/partes/p0"), { itens: [] }));
  await assertFails(setDoc(doc(db, "catalogos/rev/partes/qualquer"), { itens: [] }));
  await assertSucceeds(setDoc(doc(db, "lojas/rev/fotos/y1"), { fotos: ["data:image/jpeg;base64,AA"], v: 1 }));
  await assertFails(setDoc(doc(db, "lojas/rev/fotos/y2"), { fotos: ["a", "b", "c", "d"], v: 1 }));
  await assertSucceeds(setDoc(doc(db, "lojas/rev/proprios/r1"), { nome: "Brinco", preco: 10 }));
});

// --- dados pessoais ---
test("R08 visitante e revendedora não leem contas (e-mail, nome) nem acessos", async () => {
  await assertFails(getDoc(doc(visitante(), "contas/rev")));
  await assertFails(getDoc(doc(rev(), "contas/rev")));
  await assertFails(getDoc(doc(rev(), "acessos/rev")));
  await assertSucceeds(getDoc(doc(adm(), "contas/rev")));
});
test("R09 revendedora registra o próprio acesso só com a hora do servidor", async () => {
  await assertSucceeds(setDoc(doc(rev(), "acessos/rev"), { em: serverTimestamp() }));
  await assertFails(setDoc(doc(rev(), "acessos/rev"), { em: Timestamp.fromDate(new Date(2020, 0, 1)) }));
  await assertFails(setDoc(doc(rev(), "acessos/outra"), { em: serverTimestamp() }));
  await assertFails(setDoc(doc(estranho(), "acessos/estranho"), { em: serverTimestamp() }));
});

// --- carrinhos/pedidos da loja pública ---
test("R10 cliente cria carrinho e finaliza", async () => {
  const db = visitante(), r = doc(db, "lojas/rev/leads/abcdefghijABCDEFGHIJ");
  await assertSucceeds(setDoc(r, lead()));
  await assertSucceeds(updateDoc(r, { itens: [], total: 0, ts: serverTimestamp() }));
  await assertSucceeds(updateDoc(r, { status: "enviado", ts: serverTimestamp() }));
  await assertFails(updateDoc(r, { status: "abandonado", ts: serverTimestamp() })); // depois de enviado, não muda mais
});
test("R11 carrinho falso com id malicioso, data falsa, total em texto ou loja inexistente é recusado", async () => {
  const db = visitante();
  await assertFails(setDoc(doc(db, 'lojas/rev/leads/x" onmouseover="alert(1)'), lead()));
  await assertFails(setDoc(doc(db, "lojas/rev/leads/abcdefghijABCDEFGHI2"), lead({ ts: Timestamp.fromDate(new Date(2030, 0, 1)) })));
  await assertFails(setDoc(doc(db, "lojas/rev/leads/abcdefghijABCDEFGHI3"), lead({ total: "<img src=x>" })));
  await assertFails(setDoc(doc(db, "lojas/rev/leads/abcdefghijABCDEFGHI4"), lead({ status: "enviado" })));
  await assertFails(setDoc(doc(db, "lojas/rev/leads/abcdefghijABCDEFGHI5"), lead({ admin: true })));
  await assertFails(setDoc(doc(db, "lojas/rev/leads/abcdefghijABCDEFGHI6"), lead({ uid: "outra" })));
  await assertFails(setDoc(doc(db, "lojas/naoexiste/leads/abcdefghijABCDEFGHI7"), lead({ uid: "naoexiste" })));
  await assertFails(setDoc(doc(db, "lojas/rev/leads/abcdefghijABCDEFGHI8"), lead({ nome: "x".repeat(101) })));
});
test("R12 visitante não lê pedidos de ninguém", async () => {
  await assertFails(getDocs(collection(visitante(), "lojas/rev/leads")));
  await assertFails(getDoc(doc(visitante(), "lojas/rev/leads/AAAAAAAAAAAAAAAAAAAA")));
  await assertFails(getDocs(collection(estranho(), "lojas/rev/leads")));
  await assertSucceeds(getDocs(collection(rev(), "lojas/rev/leads")));
});

// --- contadores de acesso ---
const dk = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
test("R13 contador: +1 visita e +1 peça vista funcionam; inflar não", async () => {
  const db = visitante(), d = dk(), r = doc(db, `lojas/rev/dias/${d}`);
  await assertSucceeds(setDoc(r, { data: d, uid: "rev", visitas: increment(1) }, { merge: true }));
  await assertSucceeds(setDoc(r, { data: d, uid: "rev", ultima: "y1", views: { y1: increment(1) } }, { merge: true }));
  await assertSucceeds(setDoc(r, { data: d, uid: "rev", ultima: "y1", views: { y1: increment(1) } }, { merge: true }));
  await assertSucceeds(setDoc(r, { data: d, uid: "rev", visitas: increment(1) }, { merge: true }));
  await assertFails(setDoc(r, { visitas: 999 }, { merge: true }));
  await assertFails(setDoc(r, { views: { a: 1, b: 1, c: 1 } }, { merge: true }));
  await assertFails(setDoc(doc(db, `lojas/rev/dias/${dk(1)}`), { data: dk(1), uid: "rev", visitas: 1, views: { a: 1, b: 1 } }));
  await assertFails(setDoc(doc(db, "lojas/rev/dias/lixo"), { data: "lixo", uid: "rev", visitas: 1 }));
  await assertFails(getDoc(r));
});
test("R13b contador: não diminui, não troca valor de peça, não aceita data futura nem loja inexistente", async () => {
  const db = visitante(), d = dk(), r = doc(db, `lojas/rev/dias/${d}`);
  await assertSucceeds(setDoc(r, { data: d, uid: "rev", visitas: increment(1), ultima: "y1", views: { y1: increment(1) } }, { merge: true }));
  await assertFails(setDoc(r, { visitas: -1000000000 }, { merge: true }));
  await assertFails(setDoc(r, { ultima: "y1", views: { y1: 1e15 } }, { merge: true }));
  await assertFails(setDoc(r, { views: { y1: 1e15 } }, { merge: true }));
  await assertFails(setDoc(doc(db, "lojas/rev/dias/9999-12-31"), { data: "9999-12-31", uid: "rev", visitas: 1 }));
  await assertFails(setDoc(doc(db, "lojas/rev/dias/2020-01-01"), { data: "2020-01-01", uid: "rev", visitas: 1 }));
  await assertFails(setDoc(doc(db, `lojas/rev/dias/${dk(5)}`), { data: dk(5), uid: "rev", visitas: 1 }));
  await assertFails(setDoc(doc(db, `lojas/rev/dias/${dk()}x`), { data: d, uid: "rev", visitas: 1 }));
  await assertFails(setDoc(doc(db, `lojas/naoexiste/dias/${d}`), { data: d, uid: "naoexiste", visitas: 1 }));
  await assertFails(setDoc(doc(db, `lojas/outra/dias/${d}`), { data: d, uid: "outra", visitas: -5 }));
  await assertFails(setDoc(doc(db, `lojas/outra/dias/${d}`), { data: d, uid: "outra", ultima: "y3", views: { y3: 1e15 } }));
});

// --- correções da auditoria de segurança ---
test("R15 revendedora não grava 'uid' nem campos fora da lista na própria loja; cor só #RRGGBB", async () => {
  const db = rev();
  await assertFails(updateDoc(doc(db, "lojas/rev"), { uid: "outra" }));
  await assertFails(updateDoc(doc(db, "lojas/rev"), { qualquer: 1 }));
  await assertFails(updateDoc(doc(db, "lojas/rev"), { cor: "red;background-image:url(https://x)" }));
  await assertFails(updateDoc(doc(db, "lojas/rev"), { logo: "javascript:alert(1)" }));
  await assertSucceeds(updateDoc(doc(db, "lojas/rev"), { cor: "#a1B2c3", logo: "data:image/png;base64,AAAA", modo: "pronta", rodape: { horario: "x" } }));
  await assertSucceeds(updateDoc(doc(db, "lojas/rev"), { logo: null }));
  await assertFails(updateDoc(doc(estranho(), "lojas/rev"), { nome: "x" }));
});
test("R16 preços da revendedora só no formato do painel", async () => {
  const db = rev();
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 0, arred: "", over: {}, pronta: 1 }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 0, ocultas: { a: 1 } }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: "100" }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 100, extra: true }));
  await assertSucceeds(setDoc(doc(db, "precos/rev"), { margem: 100, arred: "90", over: {}, fixo: {}, pronta: ["y1"], ocultas: [], fotos: {}, nomes: {}, modo: "todo", atualizadoEm: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(adm(), "precos/rev"), { margem: 100, arred: "90", over: {} }));
  await assertSucceeds(setDoc(doc(db, "precos/rev"), { margem: 100, ocultas: ["y1"], excluidas: ["y1"] }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 100, excluidas: "y1" }));
  await assertSucceeds(setDoc(doc(db, "precos/rev"), { margem: 100, descs: { y1: "Anel lindo" } }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 100, descs: "texto" }));
});
test("R17 fotos próprias só imagem embutida ou https (nunca javascript:)", async () => {
  const db = rev();
  await assertFails(setDoc(doc(db, "lojas/rev/fotos/y1"), { fotos: ["javascript:alert(1)"], v: 1 }));
  await assertFails(setDoc(doc(db, "lojas/rev/fotos/y1"), { fotos: ["data:image/jpeg;base64,AA", "data:text/html,<script>"], v: 1 }));
  await assertFails(setDoc(doc(db, "lojas/rev/fotos/y1"), { fotos: [1], v: 1 }));
  await assertSucceeds(setDoc(doc(db, "lojas/rev/fotos/y1"), { fotos: ["data:image/jpeg;base64,AA", "https://images.yampi.me/a.jpg"], v: 1 }));
});
test("R18 catálogo tem no máximo 40 partes", async () => {
  await assertSucceeds(setDoc(doc(rev(), "catalogos/rev/partes/p39"), { itens: [] }));
  await assertFails(setDoc(doc(rev(), "catalogos/rev/partes/p40"), { itens: [] }));
  await assertFails(setDoc(doc(rev(), "catalogos/rev/partes/p999"), { itens: [] }));
});
test("R19 loja pausada não recebe carrinho novo", async () => {
  await env.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), "lojas/outra"), { status: "pausada" }); });
  await assertFails(setDoc(doc(visitante(), "lojas/outra/leads/abcdefghijABCDEFGHIJ"), lead({ uid: "outra" })));
  await assertSucceeds(setDoc(doc(visitante(), "lojas/rev/leads/abcdefghijABCDEFGHIK"), lead()));
});

test("R20 aviso do ADM: revendedora lê, visitante não; só ADM grava, com link https", async () => {
  await assertSucceeds(setDoc(doc(adm(), "avisos/geral"), { ativo: true, titulo: "Oi", texto: "Novidade", img: "data:image/jpeg;base64,AAAA", link: "https://veraneio.com.br", botao: "Ver", em: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(rev(), "avisos/geral")));
  await assertFails(getDoc(doc(visitante(), "avisos/geral")));
  await assertFails(getDoc(doc(estranho(), "avisos/geral")));
  await assertFails(setDoc(doc(rev(), "avisos/geral"), { ativo: false }));
  await assertFails(setDoc(doc(adm(), "avisos/geral"), { ativo: true, link: "javascript:alert(1)" }));
  await assertFails(setDoc(doc(adm(), "avisos/outro"), { ativo: true }));
});

test("R21 revendedora edita a faixa de destaques (lista de até 4)", async () => {
  await assertSucceeds(updateDoc(doc(rev(), "lojas/rev"), { destaques: [{ t: "Entrega 24h", s: "x", off: false }, { off: true }] }));
  await assertFails(updateDoc(doc(rev(), "lojas/rev"), { destaques: "texto" }));
  await assertFails(updateDoc(doc(rev(), "lojas/rev"), { destaques: [{}, {}, {}, {}, {}] }));
  await assertFails(updateDoc(doc(rev(), "lojas/outra"), { destaques: [] }));
});

test("R22 rascunho: só a dona (e o ADM) lê e grava, no formato certo", async () => {
  await assertSucceeds(setDoc(doc(rev(), "rascunhos/rev/docs/loja"), { nome: "Nova", cor: "#aabbcc", em: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(rev(), "rascunhos/rev/docs/precos"), { margem: 80, arred: "90", over: {}, fixo: {}, pronta: [], ocultas: ["y1"], excluidas: [], fotos: {}, nomes: {}, modo: "catalogo", em: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(rev(), "rascunhos/rev/docs/banners"), { itens: [{ m: "data:image/jpeg;base64,AA" }], em: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(rev(), "rascunhos/rev/docs/mudou"), { em: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(rev(), "rascunhos/rev/docs/loja")));
  await assertSucceeds(getDoc(doc(adm(), "rascunhos/rev/docs/loja")));
  await assertFails(getDoc(doc(visitante(), "rascunhos/rev/docs/loja")));
  await assertFails(getDoc(doc(rev(), "rascunhos/outra/docs/loja")));
  await assertFails(setDoc(doc(rev(), "rascunhos/outra/docs/loja"), { nome: "x" }));
  await assertFails(setDoc(doc(rev(), "rascunhos/rev/docs/loja"), { cor: "red;x" }));
  await assertFails(setDoc(doc(rev(), "rascunhos/rev/docs/loja"), { status: "ativa" }));
  await assertFails(setDoc(doc(rev(), "rascunhos/rev/docs/precos"), { margem: 0, pronta: 1 }));
  await assertFails(setDoc(doc(rev(), "rascunhos/rev/docs/outro"), { em: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(rev(), "rascunhos/rev/docs/loja")));
});

// --- ADM ---
test("R14 ADM gerencia tudo; sistema só ADM", async () => {
  await assertSucceeds(setDoc(doc(adm(), "atacado/p0"), { itens: [] }));
  await assertSucceeds(setDoc(doc(adm(), "sistema/config"), { promo: "nao" }));
  await assertFails(getDoc(doc(rev(), "sistema/config")));
  await assertFails(getDoc(doc(visitante(), "sistema/yampi")));
  await assertSucceeds(updateDoc(doc(adm(), "lojas/rev"), { status: "pausada" }));
  await assertSucceeds(setDoc(doc(adm(), "catalogos/rev/partes/p0"), { itens: [] }));
});

// --- R99: tudo que o app gravou nos testes do painel/ADM (e2e/escritas-gravadas.json, gerado por `npm test`)
// é reproduzido aqui com as regras reais. Pega casos em que o app grava algo que as regras recusam.
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const vivo = (v) => {
  if (Array.isArray(v)) return v.map(vivo);
  if (v && typeof v === "object") {
    if ("__ts" in v && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
    const o = {}; for (const k in v) o[k] = vivo(v[k]); return o;
  }
  return v;
};
const gravar = (v) => {
  if (Array.isArray(v)) return v.map(gravar);
  if (v && typeof v === "object") {
    if ("__ts" in v && Object.keys(v).length === 1) return serverTimestamp();
    if ("__inc" in v) return increment(v.__inc);
    if ("__del" in v) return deleteField();
    const o = {}; for (const k in v) o[k] = gravar(v[k]); return o;
  }
  return v;
};
const GRAV = existsSync("e2e/escritas-gravadas.json") ? JSON.parse(readFileSync("e2e/escritas-gravadas.json", "utf8")) : [];
test(`R99 as ${GRAV.reduce((n, g) => n + g.log.length, 0)} gravações feitas pelo app nos testes são aceitas pelas regras`, async () => {
  const falhas = [];
  for (const g of GRAV) {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (c) => { const db = c.firestore(); for (const [p, v] of Object.entries(g.seed)) await setDoc(doc(db, p), vivo(v)); });
    const ids = {};
    for (const w of g.log) {
      let p = w.path.replace(/\/dias\/\d{4}-\d{2}-\d{2}$/, `/dias/${hoje()}`);
      p = p.replace(/(\/leads\/)([^/]+)$/, (m, a, id) => a + (ids[id] ||= (id + "A".repeat(20)).replace(/[^A-Za-z0-9]/g, "A").slice(0, 20)));
      let data = w.data ? gravar(w.data) : null;
      if (data && /\/dias\//.test(p) && data.data) data.data = hoje();
      const db = w.uid ? env.authenticatedContext(w.uid).firestore() : env.unauthenticatedContext().firestore();
      const r = doc(db, p);
      try { await (w.op === "delete" ? deleteDoc(r) : w.op === "update" ? updateDoc(r, data) : setDoc(r, data, w.merge ? { merge: true } : undefined)); }
      catch (e) {
        falhas.push(`[${g.teste}] ${w.op} ${p} como ${w.uid || "visitante"} (${w.pagina}): ${String(e.code || e.message).slice(0, 80)}`);
        await env.withSecurityRulesDisabled(async (c) => { const d2 = c.firestore(), r2 = doc(d2, p); try { await (w.op === "delete" ? deleteDoc(r2) : w.op === "update" ? updateDoc(r2, data) : setDoc(r2, data, w.merge ? { merge: true } : undefined)); } catch (e2) {} });
      }
    }
  }
  if (falhas.length) throw new Error(`${falhas.length} gravação(ões) recusada(s):\n` + [...new Set(falhas)].slice(0, 40).join("\n"));
});
