/**
 * Cloud Functions — Plataforma de lojas Veraneio
 *
 * criarRevendedora   → (ADM) cria login + loja + endereço e devolve o link para ela criar a senha
 * linkDeAcesso       → (ADM) gera de novo o link de criar/trocar senha
 * catalogoDaLoja     → quando a revendedora muda a margem, republica o catálogo dela
 * catalogoGeral      → quando o ADM muda produtos (sistema/catalogo), republica o catálogo de todas
 * importarYampi      → (ADM) botão "Importar da Yampi"
 * yampiAutomatico    → sincroniza com a Yampi a cada 6 horas
 *
 * O catálogo público (catalogos/{uid}) só tem o preço FINAL. O preço de atacado
 * nunca sai do servidor para o navegador da cliente final.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { precoFinal } = require("./preco");
const { sincronizarYampi } = require("./yampi");

// Credenciais da Yampi (configuradas uma vez no deploy — ver README)
const YAMPI_ALIAS = defineString("YAMPI_ALIAS", { description: "Alias da loja na Yampi (ex.: veraneio-semijoias)" });
const YAMPI_TOKEN = defineSecret("YAMPI_TOKEN");
const YAMPI_SECRET = defineSecret("YAMPI_SECRET");

// Mesma região do banco Firestore do projeto (e de window.VERANEIO_REGIAO no config.js)
const REGIAO = "southamerica-east1";
setGlobalOptions({ region: REGIAO, maxInstances: 10 });

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const PADRAO_LOJA = {
  cor: "#043034",
  frase: "Semijoias que acompanham você todos os dias",
  sobre: "Semijoias com banho de ouro 18k e ródio, escolhidas a dedo para você.",
  aviso: "Frete grátis acima de R$ 199 · Até 3x sem juros",
  frete: 199,
  freteRegra: "acima",
  barra: { modo: "frete", meta: 299, premio: "ganhar um brinde", ok: "Parabéns! Você ganhou um brinde 🎁" },
  rodape: { horario: "Segunda a sábado", info: ["Garantia de 1 ano no banho", "Trocas em até 7 dias", "Pedidos finalizados pelo WhatsApp"], copy: "" },
  parcelas: 3,
  insta: "",
  logo: null,
  logoPath: null,
  banners: [],
};

async function exigirAdmin(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Faça login.");
  const a = await db.doc(`admins/${req.auth.uid}`).get();
  if (!a.exists) throw new HttpsError("permission-denied", "Acesso só para ADM.");
}

function slugify(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
const RESERVADOS = new Set(["painel", "adm", "admin", "config", "api", "loja", "login", "veraneio"]);

/* ---------------- criar revendedora ---------------- */
exports.criarRevendedora = onCall(async (req) => {
  await exigirAdmin(req);
  const d = req.data || {};
  const nome = String(d.nome || "").trim().slice(0, 40);
  const resp = String(d.resp || "").trim().slice(0, 60);
  const email = String(d.email || "").trim().toLowerCase();
  const slug = slugify(d.slug || nome);
  if (!nome || !resp) throw new HttpsError("invalid-argument", "Preencha o nome da loja e da responsável.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError("invalid-argument", "E-mail inválido.");
  if (slug.length < 3 || RESERVADOS.has(slug)) throw new HttpsError("invalid-argument", "Escolha outro endereço para a loja.");

  const slugRef = db.doc(`slugs/${slug}`);
  if ((await slugRef.get()).exists) throw new HttpsError("already-exists", "Esse endereço de loja já está em uso.");

  let user;
  try {
    user = await admin.auth().createUser({ email, password: crypto.randomBytes(16).toString("hex"), displayName: resp });
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new HttpsError("already-exists", "Já existe uma conta com esse e-mail.");
    throw new HttpsError("internal", "Não foi possível criar o login.");
  }

  try {
    await db.runTransaction(async (t) => {
      if ((await t.get(slugRef)).exists) throw new HttpsError("already-exists", "Esse endereço de loja já está em uso.");
      t.set(slugRef, { uid: user.uid });
      t.set(db.doc(`lojas/${user.uid}`), {
        ...PADRAO_LOJA,
        nome, resp, slug,
        cidade: String(d.cidade || "").trim().slice(0, 60),
        whats: String(d.whats || "").trim().slice(0, 30),
        status: "ativa",
        criadoEm: FieldValue.serverTimestamp(),
        ultimoAcesso: null,
      });
      t.set(db.doc(`precos/${user.uid}`), { margem: 100, arred: "90", over: {} });
    });
  } catch (e) {
    await admin.auth().deleteUser(user.uid).catch(() => {});
    throw e instanceof HttpsError ? e : new HttpsError("internal", "Não foi possível criar a loja.");
  }

  const link = await admin.auth().generatePasswordResetLink(email);
  return { uid: user.uid, slug, link };
});

/* ---------------- novo link de acesso ---------------- */
exports.linkDeAcesso = onCall(async (req) => {
  await exigirAdmin(req);
  const uid = String((req.data || {}).uid || "");
  const u = await admin.auth().getUser(uid).catch(() => null);
  if (!u || !u.email) throw new HttpsError("not-found", "Revendedora não encontrada.");
  return { link: await admin.auth().generatePasswordResetLink(u.email), email: u.email };
});

/* ---------------- catálogo público ---------------- */
async function carregarProdutos() {
  const s = await db.collection("produtos").where("ativo", "==", true).get();
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => Number(p.preco) > 0 && !p.esgotado)
    .sort((a, b) => (a.ordem ?? 999) - (b.ordem ?? 999) || String(a.nome).localeCompare(String(b.nome), "pt"));
}

async function publicar(uid, precos, produtos) {
  const pr = { margem: 100, arred: "90", over: {}, ...(precos || {}) };
  const itens = produtos.map((p) => ({
    id: p.id,
    nome: p.nome || "",
    cat: p.cat || "",
    banho: p.banho || "",
    desc: p.desc || "",
    fotos: (p.fotos || []).slice(0, 6),
    novo: !!p.novo,
    ordem: p.ordem ?? 999,
    preco: precoFinal(p.preco, pr, p.id),
  }));
  await db.doc(`catalogos/${uid}`).set({ itens, atualizadoEm: FieldValue.serverTimestamp() });
}

exports.catalogoDaLoja = onDocumentWritten("precos/{uid}", async (event) => {
  const depois = event.data.after.exists ? event.data.after.data() : null;
  if (!depois) return db.doc(`catalogos/${event.params.uid}`).delete();
  return publicar(event.params.uid, depois, await carregarProdutos());
});

exports.catalogoGeral = onDocumentWritten({ document: "sistema/catalogo", timeoutSeconds: 300, memory: "512MiB" }, async () => {
  const [produtos, precos] = await Promise.all([carregarProdutos(), db.collection("precos").get()]);
  for (const d of precos.docs) await publicar(d.id, d.data(), produtos);
});

/* ---------------- Yampi ---------------- */
async function rodarYampi() {
  try {
    return await sincronizarYampi({ db, FieldValue, alias: YAMPI_ALIAS.value(), token: YAMPI_TOKEN.value(), secret: YAMPI_SECRET.value() });
  } catch (e) {
    await db.doc("sistema/yampi").set({ erro: e.message, em: FieldValue.serverTimestamp() }, { merge: true });
    throw e;
  }
}
const OPC_YAMPI = { secrets: [YAMPI_TOKEN, YAMPI_SECRET], timeoutSeconds: 540, memory: "1GiB" };

exports.importarYampi = onCall(OPC_YAMPI, async (req) => {
  await exigirAdmin(req);
  try { return await rodarYampi(); }
  catch (e) { throw new HttpsError("internal", e.message || "Falha ao importar da Yampi."); }
});

exports.yampiAutomatico = onSchedule({ ...OPC_YAMPI, schedule: "every 6 hours", timeZone: "America/Sao_Paulo" }, async () => {
  await rodarYampi();
});
