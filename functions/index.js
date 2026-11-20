/* Servidor de pagamentos das lojas (Cloud Functions, região São Paulo).
 * Chega pelo próprio site: /api/assinatura (painel, com login) e /api/mp-webhook (avisos do Mercado Pago). */
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { criarAssinaturas, avisoAutentico, Erro } from "./mp.js";

initializeApp();
const db = getFirestore();
const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");

const limpa = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Timestamp ? { __ts: v.toMillis() } : v)));
const volta = (o) => {
  if (o == null || typeof o !== "object") return o;
  if (o instanceof Timestamp) return o;
  if (Array.isArray(o)) return o.map(volta);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, volta(v)]));
};
const store = {
  async get(p) { const s = await db.doc(p).get(); return s.exists ? s.data() : null; },
  async set(p, o, opt) { await db.doc(p).set(volta(o), opt || {}); },
  async tx(fn) {
    return db.runTransaction(async (t) => {
      const escritas = [];
      const r = await fn({
        get: async (p) => { const s = await t.get(db.doc(p)); return s.exists ? s.data() : null; },
        set: (p, o, opt) => escritas.push([p, o, opt]),
      });
      escritas.forEach(([p, o, opt]) => t.set(db.doc(p), volta(o), opt || {}));
      return r;
    });
  },
};

function cliente() {
  const token = MP_ACCESS_TOKEN.value();
  return async function mp(method, path, body, headers = {}) {
    const r = await fetch("https://api.mercadopago.com" + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.warn("mercado pago recusou", { path: path.replace(/\d{6,}/g, "#"), status: r.status, msg: j.message, causa: j.cause });
      throw new Erro(r.status === 400 ? "mp_recusou" : "mp_falhou", r.status === 400 ? 400 : 502, j.message);
    }
    return j;
  };
}
const servico = () => criarAssinaturas({ store, mp: cliente(), agora: () => Date.now(), ts: (ms) => Timestamp.fromMillis(ms) });

async function quem(req) {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!m) throw new Erro("sem_login", 401);
  let u;
  try { u = await getAuth().verifyIdToken(m[1], true); } catch (e) { throw new Erro("sem_login", 401); }
  const [loja, admin] = await Promise.all([db.doc(`lojas/${u.uid}`).get(), db.doc(`admins/${u.uid}`).get()]);
  return { uid: u.uid, email: u.email || "", loja: loja.exists, admin: admin.exists };
}

async function rotaAssinatura(req, res) {
  if (req.method !== "POST") throw new Erro("metodo", 405);
  const eu = await quem(req);
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const s = servico();
  // o ADM pode cancelar o cartão de uma revendedora; o resto é sempre da própria loja
  if (b.acao === "cancelar" && eu.admin && typeof b.uid === "string" && /^[A-Za-z0-9]{6,64}$/.test(b.uid)) return res.json(await s.cancelarCartao(b.uid));
  if (!eu.loja) throw new Erro("sem_loja", 403);
  if (!eu.email) throw new Erro("sem_email", 400);
  switch (b.acao) {
    case "cartao": return res.json(await s.assinarCartao(eu.uid, eu.email, { token: b.token }));
    case "pix": return res.json(await s.gerarPix(eu.uid, eu.email));
    case "conferir": return res.json(await s.conferirPix(eu.uid, b.id));
    case "cancelar": return res.json(await s.cancelarCartao(eu.uid));
    case "sincronizar": return res.json({ cartao: limpa(await s.sincronizarCartao(eu.uid)) });
    default: throw new Erro("acao", 400);
  }
}

async function rotaWebhook(req, res) {
  if (req.method !== "POST") throw new Erro("metodo", 405);
  const dataId = String(req.query["data.id"] || (req.body && req.body.data && req.body.data.id) || "");
  const tipo = String(req.query.type || (req.body && req.body.type) || "");
  const ok = avisoAutentico({ assinatura: req.get("x-signature"), requestId: req.get("x-request-id"), dataId, segredo: MP_WEBHOOK_SECRET.value() });
  if (!ok) { logger.warn("aviso sem assinatura válida", { tipo }); return res.status(401).json({ erro: "assinatura" }); }
  const r = await servico().aviso(tipo, dataId);
  logger.info("aviso do mercado pago", { tipo, resultado: r });
  return res.json({ ok: true });
}

export const api = onRequest(
  { region: "southamerica-east1", secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET], maxInstances: 5, memory: "256MiB", timeoutSeconds: 30, invoker: "public" },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (req.path.endsWith("/assinatura")) return await rotaAssinatura(req, res);
      if (req.path.endsWith("/mp-webhook")) return await rotaWebhook(req, res);
      return res.status(404).json({ erro: "rota" });
    } catch (e) {
      if (e instanceof Erro) return res.status(e.status).json({ erro: e.codigo });
      logger.error("erro no servidor de pagamentos", e);
      return res.status(500).json({ erro: "interno" });
    }
  },
);
