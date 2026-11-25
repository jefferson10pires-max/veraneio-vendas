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
  await assertFails(setDoc(doc(db, "lojas/rev/proprios/r1"), { nome: "Brinco", preco: 10 })); // sem plano assinante
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
  await assertSucceeds(setDoc(doc(db, "precos/rev"), { margem: 100, promos: { y1: 20 } }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 100, promos: [20] }));
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

test("R23 plano: revendedora registra o 1º acesso como gratuito; só o ADM vira assinante", async () => {
  await assertFails(setDoc(doc(rev(), "planos/rev"), { plano: "assinante", primeiroAcesso: serverTimestamp() }));
  await assertFails(setDoc(doc(rev(), "planos/rev"), { plano: "gratuito", primeiroAcesso: Timestamp.fromMillis(0) }));
  await assertSucceeds(setDoc(doc(rev(), "planos/rev"), { plano: "gratuito", primeiroAcesso: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(rev(), "planos/rev")));
  await assertFails(updateDoc(doc(rev(), "planos/rev"), { plano: "assinante" }));
  await assertFails(updateDoc(doc(rev(), "planos/rev"), { primeiroAcesso: serverTimestamp() }));
  await assertFails(getDoc(doc(visitante(), "planos/rev")));
  await assertFails(getDoc(doc(estranho(), "planos/rev")));
  await assertFails(setDoc(doc(estranho(), "planos/estranho"), { plano: "gratuito", primeiroAcesso: serverTimestamp() }));
  await assertFails(getDoc(doc(rev(), "planos/outra")));
  await assertSucceeds(setDoc(doc(adm(), "planos/rev"), { plano: "assinante", mudadoEm: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(adm(), "planos/rev"), { plano: "vip" }, { merge: true }));
  // ADM marcou antes do 1º acesso: a revendedora só completa a data
  await assertSucceeds(setDoc(doc(adm(), "planos/outra"), { plano: "assinante" }));
  const c = env.authenticatedContext("outra").firestore();
  await assertSucceeds(updateDoc(doc(c, "planos/outra"), { primeiroAcesso: serverTimestamp() }));
  await assertFails(updateDoc(doc(c, "planos/outra"), { primeiroAcesso: serverTimestamp() }));
});

test("R24 prazo do período gratuito: só o ADM define; revendedora lê", async () => {
  await assertSucceeds(setDoc(doc(adm(), "config/planos"), { diasGratis: 30, em: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(rev(), "config/planos")));
  await assertFails(getDoc(doc(visitante(), "config/planos")));
  await assertFails(getDoc(doc(estranho(), "config/planos")));
  await assertFails(setDoc(doc(rev(), "config/planos"), { diasGratis: 9999 }));
  await assertFails(setDoc(doc(adm(), "config/planos"), { diasGratis: -1 }));
  await assertFails(setDoc(doc(adm(), "config/planos"), { diasGratis: "30" }));
  await assertFails(setDoc(doc(adm(), "config/outro"), { diasGratis: 30 }));
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

// --- planos: gratuito x assinante ---
const dia = 864e5;
const plano = (plano, diasAtras, diasGratis) => env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  await setDoc(doc(db, "planos/rev"), { plano, primeiroAcesso: Timestamp.fromMillis(Date.now() - diasAtras * dia) });
  if (diasGratis != null) await setDoc(doc(db, "config/planos"), { diasGratis });
  await setDoc(doc(db, "lojas/rev/proprios/velha"), { nome: "Velha", preco: 10 });
});
test("R25 peças próprias só no plano assinante; gratuita ainda apaga as que já tinha", async () => {
  await plano("gratuito", 1, 30);
  await assertFails(setDoc(doc(rev(), "lojas/rev/proprios/r1"), { nome: "Brinco", preco: 10 }));
  await assertFails(updateDoc(doc(rev(), "lojas/rev/proprios/velha"), { preco: 1 }));
  await assertSucceeds(getDoc(doc(rev(), "lojas/rev/proprios/velha")));
  await assertSucceeds(deleteDoc(doc(rev(), "lojas/rev/proprios/velha")));
  await assertSucceeds(setDoc(doc(adm(), "lojas/rev/proprios/r2"), { nome: "Do ADM", preco: 10 }));
  await plano("assinante", 400, 30);
  await assertSucceeds(setDoc(doc(rev(), "lojas/rev/proprios/r1"), { nome: "Brinco", preco: 10 }));
  await assertSucceeds(updateDoc(doc(rev(), "lojas/rev/proprios/velha"), { preco: 12 }));
});
test("R26 período gratuito vencido: painel não muda nada; loja continua lida; pedidos seguem; ADM ainda grava", async () => {
  await plano("gratuito", 31, 30);
  const db = rev();
  await assertFails(updateDoc(doc(db, "lojas/rev"), { nome: "Novo" }));
  await assertFails(setDoc(doc(db, "precos/rev"), { margem: 50 }));
  await assertFails(setDoc(doc(db, "rascunhos/rev/docs/mudou"), { em: serverTimestamp() }));
  await assertFails(setDoc(doc(db, "catalogos/rev/partes/p0"), { itens: [] }));
  await assertFails(setDoc(doc(db, "banners/rev"), { itens: [] }));
  await assertFails(setDoc(doc(db, "lojas/rev/fotos/y1"), { fotos: ["data:image/jpeg;base64,AA"], v: 1 }));
  await assertFails(deleteDoc(doc(db, "lojas/rev/proprios/velha")));
  await assertSucceeds(getDoc(doc(visitante(), "lojas/rev")));
  await assertSucceeds(getDoc(doc(db, "precos/rev")));
  await assertSucceeds(updateDoc(doc(db, "lojas/rev/leads/AAAAAAAAAAAAAAAAAAAA"), { status: "enviado" }));
  await assertSucceeds(setDoc(doc(db, "acessos/rev"), { em: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(adm(), "catalogos/rev/partes/p0"), { itens: [] }));
  await assertSucceeds(updateDoc(doc(adm(), "lojas/rev"), { nome: "Pelo ADM" }));
});
test("R27 dentro do prazo, sem prazo (0) ou assinante: painel grava normal", async () => {
  await plano("gratuito", 29, 30);
  await assertSucceeds(setDoc(doc(rev(), "precos/rev"), { margem: 50 }));
  await assertSucceeds(updateDoc(doc(rev(), "lojas/rev"), { nome: "A" }));
  await plano("gratuito", 400, 0);
  await assertSucceeds(setDoc(doc(rev(), "precos/rev"), { margem: 60 }));
  await plano("assinante", 400, 30);
  await assertSucceeds(setDoc(doc(rev(), "precos/rev"), { margem: 70 }));
  await assertSucceeds(setDoc(doc(rev(), "catalogos/rev/partes/p0"), { itens: [] }));
});

// --- assinatura paga: validade (pagoAte + tolerância), quem grava, config de valores ---
const assin = (pagoAteDias, tolerancia, extra = {}) => env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  await setDoc(doc(db, "planos/rev"), { plano: "assinante", primeiroAcesso: Timestamp.fromMillis(Date.now() - 400 * dia),
    pagoAte: pagoAteDias == null ? null : Timestamp.fromMillis(Date.now() + pagoAteDias * dia), origem: "pix", ...extra });
  await setDoc(doc(db, "config/planos"), { diasGratis: 30, tolerancia });
});
test("R28 assinatura em dia, na tolerância ou sem vencimento: tudo liberado; passou da tolerância: trava como gratuito vencido", async () => {
  await assin(5, 3);
  await assertSucceeds(setDoc(doc(rev(), "lojas/rev/proprios/a1"), { nome: "A", preco: 1 }));
  await assin(-2, 3); // venceu há 2 dias, tolerância 3
  await assertSucceeds(setDoc(doc(rev(), "lojas/rev/proprios/a2"), { nome: "A", preco: 1 }));
  await assertSucceeds(setDoc(doc(rev(), "precos/rev"), { margem: 50 }));
  await assin(null, 0); // manual sem vencimento
  await assertSucceeds(setDoc(doc(rev(), "lojas/rev/proprios/a3"), { nome: "A", preco: 1 }));
  await assin(-4, 3); // passou da tolerância
  await assertFails(setDoc(doc(rev(), "lojas/rev/proprios/a4"), { nome: "A", preco: 1 }));
  await assertFails(setDoc(doc(rev(), "precos/rev"), { margem: 60 }));
  await assertSucceeds(getDoc(doc(rev(), "planos/rev")));
});
test("R29 revendedora não se dá assinatura nem mexe no pagoAte; só o ADM (ou o servidor)", async () => {
  await plano("gratuito", 1, 30);
  const r = rev();
  await assertFails(updateDoc(doc(r, "planos/rev"), { plano: "assinante" }));
  await assertFails(updateDoc(doc(r, "planos/rev"), { pagoAte: Timestamp.fromMillis(Date.now() + 99 * dia) }));
  await assertFails(setDoc(doc(r, "assinaturas/rev"), { cartao: { status: "authorized" } }));
  await assertFails(setDoc(doc(r, "assinaturas/rev/pagamentos/1"), { aplicado: true }));
  await assertSucceeds(getDoc(doc(r, "assinaturas/rev")));
  await assertFails(getDoc(doc(env.authenticatedContext("outra").firestore(), "assinaturas/rev")));
  const a = adm();
  await assertSucceeds(setDoc(doc(a, "planos/rev"), { plano: "assinante", origem: "manual", pagoAte: null }, { merge: true }));
  await assertSucceeds(setDoc(doc(a, "planos/rev"), { plano: "assinante", origem: "manual", pagoAte: Timestamp.fromMillis(Date.now() + 90 * dia) }, { merge: true }));
  await assertFails(setDoc(doc(a, "planos/rev"), { origem: "boleto" }, { merge: true }));
  await assertFails(setDoc(doc(a, "planos/rev"), { pagoAte: "amanhã" }, { merge: true }));
});
test("R30 config dos planos: só ADM, valores e chave pública válidos", async () => {
  const ok = { diasGratis: 30, tolerancia: 3, valor: 39.9, valorPix: 35, mpPublicKey: "TEST-1234abcd-5678-90ef" };
  await assertSucceeds(setDoc(doc(adm(), "config/planos"), ok));
  await assertSucceeds(setDoc(doc(adm(), "config/planos"), { ...ok, mpPublicKey: "APP_USR-abcdef12-3456-7890-abcd-ef1234567890" }));
  await assertFails(setDoc(doc(rev(), "config/planos"), ok));
  await assertFails(setDoc(doc(adm(), "config/planos"), { ...ok, valor: -1 }));
  await assertFails(setDoc(doc(adm(), "config/planos"), { ...ok, tolerancia: 90 }));
  await assertFails(setDoc(doc(adm(), "config/planos"), { ...ok, mpPublicKey: "APP_USR-x<script>" }));
  await assertFails(setDoc(doc(adm(), "config/planos"), { ...ok, accessToken: "APP_USR-segredo" }));
  await assertSucceeds(getDoc(doc(rev(), "config/planos")));
});

// --- avaliações das clientes
const aval = (x = {}) => ({ produto: "y1", nome: "Ana", nota: 5, texto: "Linda", status: "pendente", ts: serverTimestamp(), ...x });
test("R31 cliente sem login envia avaliação pendente, no formato certo; só a dona lê e apaga", async () => {
  const r = (id = "BBBBBBBBBBBBBBBBBBBB") => doc(visitante(), "lojas/rev/avaliacoes/" + id);
  await assertSucceeds(setDoc(r(), aval()));
  await assertSucceeds(setDoc(r("CCCCCCCCCCCCCCCCCCCC"), aval({ texto: "" })));
  for (const ruim of [{ status: "aprovada" }, { nota: 0 }, { nota: 6 }, { nota: 4.5 }, { nome: "" }, { nome: "x".repeat(61) }, { texto: "x".repeat(501) }, { produto: "" }, { ts: Timestamp.fromMillis(1) }, { extra: 1 }])
    await assertFails(setDoc(r("DDDDDDDDDDDDDDDDDDDD"), aval(ruim)));
  await assertFails(setDoc(doc(visitante(), "lojas/rev/avaliacoes/curto"), aval()));
  await assertFails(getDoc(r()));
  await assertFails(getDoc(doc(estranho(), "lojas/rev/avaliacoes/BBBBBBBBBBBBBBBBBBBB")));
  await assertFails(getDoc(doc(env.authenticatedContext("outra").firestore(), "lojas/rev/avaliacoes/BBBBBBBBBBBBBBBBBBBB")));
  await assertFails(updateDoc(r(), { status: "aprovada" }));
  await assertFails(deleteDoc(r()));
  await assertSucceeds(getDoc(doc(rev(), "lojas/rev/avaliacoes/BBBBBBBBBBBBBBBBBBBB")));
  await assertSucceeds(deleteDoc(doc(rev(), "lojas/rev/avaliacoes/BBBBBBBBBBBBBBBBBBBB")));
});
test("R32 loja pausada não recebe avaliação", async () => {
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), "lojas/rev"), { nome: "x", status: "pausada" }); });
  await assertFails(setDoc(doc(visitante(), "lojas/rev/avaliacoes/BBBBBBBBBBBBBBBBBBBB"), aval()));
});
test("R33 aprovadas e resumo: todo mundo lê; só a dona (ou ADM) grava, com teto", async () => {
  const pub = { n: 1, media: 5, itens: [{ nome: "Ana", nota: 5, texto: "", ts: 1 }], em: serverTimestamp() };
  await assertSucceeds(setDoc(doc(rev(), "lojas/rev/avaliacoesPub/y1"), pub));
  await assertSucceeds(setDoc(doc(rev(), "lojas/rev/pub/resumoAvaliacoes"), { y1: { n: 1, media: 5 } }, { merge: true }));
  await assertSucceeds(getDoc(doc(visitante(), "lojas/rev/avaliacoesPub/y1")));
  await assertSucceeds(getDoc(doc(visitante(), "lojas/rev/pub/resumoAvaliacoes")));
  await assertFails(setDoc(doc(visitante(), "lojas/rev/avaliacoesPub/y1"), pub));
  await assertFails(setDoc(doc(estranho(), "lojas/rev/pub/resumoAvaliacoes"), { y1: { n: 99, media: 5 } }));
  await assertFails(setDoc(doc(env.authenticatedContext("outra").firestore(), "lojas/rev/avaliacoesPub/y1"), pub));
  await assertFails(setDoc(doc(rev(), "lojas/rev/avaliacoesPub/y1"), { ...pub, media: 6 }));
  await assertFails(setDoc(doc(rev(), "lojas/rev/avaliacoesPub/y1"), { ...pub, itens: Array(501).fill({ nota: 5 }) }));
  await assertFails(setDoc(doc(rev(), "lojas/rev/avaliacoesPub/y1"), { ...pub, outro: 1 }));
  await assertFails(setDoc(doc(rev(), "lojas/rev/pub/outroDoc"), { a: 1 }));
  await assertSucceeds(setDoc(doc(adm(), "lojas/rev/avaliacoesPub/y1"), pub));
  await assertFails(deleteDoc(doc(visitante(), "lojas/rev/avaliacoesPub/y1")));
  await assertSucceeds(deleteDoc(doc(rev(), "lojas/rev/avaliacoesPub/y1")));
});
test("R34 precos aceita 'juntos' (mapa) e recusa outro tipo", async () => {
  await assertSucceeds(setDoc(doc(rev(), "precos/rev"), { margem: 100, juntos: { y1: ["y2", "y3"] } }));
  await assertFails(setDoc(doc(rev(), "precos/rev"), { margem: 100, juntos: ["y2"] }));
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
