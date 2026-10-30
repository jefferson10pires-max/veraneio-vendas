"use strict";
/**
 * Teste de ponta a ponta das functions com um Firestore falso em memória e a Meta simulada.
 * Cobre: webhook (assinatura, mensagem, mídia, eco do celular, histórico, contatos, status),
 * envio com janela de 24h, conexão híbrida, disparo pela fila, opt-out e atribuição de venda.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const Module = require("module");

/* ---------- Firestore falso ---------- */
const store = new Map(); // caminho -> dados
const INC = Symbol("inc");
const clone = o => JSON.parse(JSON.stringify(o, (k, v) => v === undefined ? null : v));
function merge(cur, patch) {
  const out = Object.assign({}, cur);
  for (const [k, v] of Object.entries(patch)) {
    if (v && v[INC] !== undefined) out[k] = (Number(out[k]) || 0) + v[INC];
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}
function resolveInc(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = v && v[INC] !== undefined ? v[INC] : v && typeof v === "object" && !Array.isArray(v) ? resolveInc(v) : v; return r; }
const snap = (path, d) => ({ exists: d !== undefined, id: path.split("/").pop(), data: () => d && clone(d), ref: docRef(path) });
function docRef(path) {
  return {
    id: path.split("/").pop(), path,
    get: async () => snap(path, store.get(path)),
    set: async (d, o) => { store.set(path, o && o.merge && store.has(path) ? merge(store.get(path), d) : (o && o.merge ? merge({}, d) : resolveInc(d))); },
    update: async d => { if (!store.has(path)) throw new Error("no doc " + path); store.set(path, merge(store.get(path), d)); },
    delete: async () => { store.delete(path); },
    collection: n => colRef(path + "/" + n),
  };
}
function colRef(path, filters = [], lim = 1e9, order = null) {
  const q = {
    doc: id => docRef(path + "/" + (id || crypto.randomUUID().slice(0, 12))),
    where: (f, op, v) => colRef(path, filters.concat([[f, op, v]]), lim, order),
    orderBy: f => colRef(path, filters, lim, f),
    limit: n => colRef(path, filters, n, order),
    get: async () => {
      const depth = path.split("/").length + 1;
      let docs = [...store.entries()].filter(([p]) => p.startsWith(path + "/") && p.split("/").length === depth)
        .filter(([, d]) => filters.every(([f, op, v]) => op === "==" ? d[f] === v : op === "in" ? v.includes(d[f]) : op === ">" ? d[f] > v : op === "<=" ? d[f] <= v : op === ">=" ? d[f] >= v : true));
      if (order) docs.sort((a, b) => (a[1][order] > b[1][order] ? 1 : -1));
      docs = docs.slice(0, lim).map(([p, d]) => snap(p, d));
      return { empty: !docs.length, docs, size: docs.length, forEach: f => docs.forEach(f) };
    },
  };
  return q;
}
const fakeDb = {
  collection: n => colRef(n),
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; },
  runTransaction: async fn => { let wrote = false; const tx = { get: async r => { if (wrote) throw new Error("leitura depois de gravação na transação"); return r.get(); }, set: (r, d, o) => { wrote = true; return r.set(d, o); }, update: (r, d) => { wrote = true; return r.update(d); } }; return fn(tx); },
};
const files = new Map();
const fakeAdmin = {
  initializeApp() { },
  firestore: Object.assign(() => fakeDb, { FieldValue: { increment: n => ({ [INC]: n }) } }),
  storage: () => ({ bucket: () => ({ name: "bucket-teste", file: p => ({ save: async (buf, o) => files.set(p, { size: buf.length, o }) }) }) }),
};
const origLoad = Module._load;
Module._load = function (req, ...a) { if (req === "firebase-admin") return fakeAdmin; return origLoad.call(this, req, ...a); };

/* ---------- Meta simulada ---------- */
const sent = [];
let failNext = null;
global.fetch = async (url, opt = {}) => {
  const u = new URL(String(url));
  const body = opt.body ? JSON.parse(opt.body) : null;
  const ok = j => ({ ok: true, status: 200, json: async () => j, arrayBuffer: async () => new ArrayBuffer(8) });
  if (u.hostname === "lookaside.example") return ok({});
  if (u.pathname.endsWith("/messages") && opt.method === "POST") {
    if (failNext) { const e = failNext; failNext = null; return { ok: false, status: 400, json: async () => ({ error: e }) }; }
    sent.push(body); return ok({ messaging_product: "whatsapp", contacts: [{ wa_id: body.to }], messages: [{ id: "wamid.OUT" + sent.length }] });
  }
  if (u.pathname.endsWith("/oauth/access_token")) return ok({ access_token: "TOKEN_CLIENTE" });
  if (u.pathname.endsWith("/subscribed_apps")) return ok({ success: true });
  if (u.pathname.endsWith("/smb_app_data")) { sent.push({ sync: body.sync_type }); return ok({ success: true }); }
  if (u.pathname.endsWith("/register")) return ok({ success: true });
  if (u.pathname.endsWith("/message_templates")) return ok({ data: [{ name: "saudades", status: "APPROVED", category: "MARKETING", language: "pt_BR", components: [{ type: "BODY", text: "Oi {{1}}, saudades!" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Não quero receber" }] }] }] });
  if (/\/MID\d*$/.test(u.pathname)) return ok({ url: "https://lookaside.example/m", mime_type: "image/jpeg" });
  if (/\/PNID1$/.test(u.pathname)) return ok({ display_phone_number: "+55 22 99847-8111", verified_name: "Veraneio", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" });
  throw new Error("URL não simulada: " + url);
};

process.env.META_APP_SECRET = "segredo"; process.env.WA_VERIFY_TOKEN = "verifica"; process.env.META_APP_ID = "123";
process.env.GCLOUD_PROJECT = "veraneio-vendas"; process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "veraneio-vendas", storageBucket: "bucket-teste" });
const F = require("../index.js");

const gestor = { auth: { uid: "u_jef" } }, atendente = { auth: { uid: "u_ana" } };
store.set("members/u_jef", { type: "manager", name: "Jefferson" });
store.set("members/u_ana", { type: "attendant", name: "Ana" });
store.set("members/u_exp", { type: "expedicao", name: "Exp" });

async function hook(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const res = { code: 0, sendStatus(c) { this.code = c; return this; }, status(c) { this.code = c; return this; }, send() { return this; } };
  const req = { method: "POST", rawBody: raw, body: payload, query: {}, get: h => h.toLowerCase() === "x-hub-signature-256" ? "sha256=" + crypto.createHmac("sha256", "segredo").update(raw).digest("hex") : undefined, headers: {} };
  await F.waWebhook(req, res); return res.code;
}
const meta = { phone_number_id: "PNID1", display_phone_number: "5522998478111" };
const ch = (field, value) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field, value: Object.assign({ metadata: meta }, value) }] }] });
const call = (fn, data, who = gestor) => F[fn].run(Object.assign({ data }, who));

test("conectar pela API híbrida pede contatos e histórico", async () => {
  const r = await call("waConectar", { line: "ln_revenda", nome: "Revenda", modo: "hibrida", via: "meta", code: "CODE", phoneNumberId: "PNID1", wabaId: "WABA1" });
  assert.ok(r.ok);
  const l = store.get("wa_lines/ln_revenda");
  assert.strictEqual(l.status, "conectado"); assert.strictEqual(l.modo, "hibrida"); assert.strictEqual(l.limite, "1.000 por dia"); assert.strictEqual(l.historico.status, "importando");
  assert.strictEqual(store.get("wa_private/ln_revenda").token, "TOKEN_CLIENTE");
  assert.deepStrictEqual(sent.filter(x => x.sync).map(x => x.sync), ["smb_app_state_sync", "history"]);
  await assert.rejects(call("waConectar", { line: "ln_varejo", modo: "hibrida", phoneNumberId: "PNID1", wabaId: "W" }, atendente), /gestor/);
});

test("webhook recusa assinatura errada e aceita a certa", async () => {
  const res = { code: 0, sendStatus(c) { this.code = c; return this; } };
  await F.waWebhook({ method: "POST", rawBody: Buffer.from("{}"), body: {}, get: () => "sha256=00" }, res);
  assert.strictEqual(res.code, 401);
  const r2 = { code: 0, status(c) { this.code = c; return this; }, send(x) { this.body = x; return this; }, sendStatus(c) { this.code = c; } };
  await F.waWebhook({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "verifica", "hub.challenge": "42" } }, r2);
  assert.strictEqual(r2.body, "42");
});

test("histórico importado cria conversas encerradas sem contar não lidas", async () => {
  await hook(ch("smb_app_state_sync", { state_sync: [{ type: "contact", action: "add", contact: { full_name: "Mariana Petrópolis", phone_number: "5522998123456" } }] }));
  const code = await hook(ch("history", { history: [{ metadata: { phase: 2, chunk_order: 1, progress: 100 }, threads: [{ id: "5522998123456", messages: [
    { from: "5522998123456", id: "h1", timestamp: "1720000000", type: "text", text: { body: "Oi, tem argola?" } },
    { from: "5522998478111", id: "h2", timestamp: "1720000060", type: "text", text: { body: "Tem sim!" }, history_context: { status: "READ" } },
  ] }] }] }));
  assert.strictEqual(code, 200);
  const c = store.get("wa_conversations/5522998123456");
  assert.strictEqual(c.name, "Mariana Petrópolis"); assert.strictEqual(c.status, "encerrada"); assert.strictEqual(c.unread, 0); assert.strictEqual(c.lastDir, "out");
  assert.strictEqual(store.get("wa_conversations/5522998123456/messages/h2").status, "read");
  const h = store.get("wa_lines/ln_revenda").historico;
  assert.strictEqual(h.status, "concluido"); assert.strictEqual(h.conversas, 1); assert.strictEqual(h.mensagens, 2);
});

test("mensagem nova reabre, conta não lida, abre janela e baixa a foto", async () => {
  await hook(ch("messages", { contacts: [{ wa_id: "552298123456", profile: { name: "Mari" } }], messages: [
    { from: "552298123456", id: "wamid.IN1", timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: { id: "MID1", mime_type: "image/jpeg", caption: "quero essa" } },
  ] }));
  // número veio SEM o 9: tem que cair na mesma conversa
  assert.ok(!store.has("wa_conversations/552298123456"));
  const c = store.get("wa_conversations/5522998123456");
  assert.strictEqual(c.status, "aberta"); assert.strictEqual(c.unread, 1); assert.strictEqual(c.lastDir, "in"); assert.ok(c.windowUntil > Date.now() + 23 * 3600e3);
  assert.strictEqual(c.name, "Mariana Petrópolis", "nome da agenda vence o nome do perfil");
  const m = store.get("wa_conversations/5522998123456/messages/wamid.IN1");
  assert.match(m.media.url, /firebasestorage.*token=/); assert.strictEqual(m.text, "quero essa");
  // a Meta reenviou o mesmo webhook: não duplica
  await hook(ch("messages", { messages: [{ from: "552298123456", id: "wamid.IN1", timestamp: "1", type: "text", text: { body: "x" } }] }));
  assert.strictEqual(store.get("wa_conversations/5522998123456").unread, 1);
});

test("eco do celular aparece na conversa como enviada pelo celular", async () => {
  await hook(ch("smb_message_echoes", { message_echoes: [{ from: "5522998478111", to: "5522998123456", id: "wamid.ECHO1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Te mando já!" } }] }));
  const m = store.get("wa_conversations/5522998123456/messages/wamid.ECHO1");
  assert.strictEqual(m.origin, "celular"); assert.strictEqual(m.dir, "out");
  const c = store.get("wa_conversations/5522998123456");
  assert.strictEqual(c.lastDir, "out"); assert.strictEqual(c.waitingSince, null);
});

test("envio: texto com janela aberta, bloqueio sem janela, status e erro", async () => {
  const r = await call("waEnviar", { convId: "5522998123456", to: "5522998123456", line: "ln_revenda", kind: "text", text: "Segue o link 💛" }, atendente);
  assert.ok(r.ok);
  const wamid = r.id; const m = store.get("wa_conversations/5522998123456/messages/" + wamid);
  assert.deepStrictEqual([m.status, m.by], ["pending", "Ana"]);
  await hook(ch("messages", { statuses: [{ id: wamid, status: "read", timestamp: "1", recipient_id: "5522998123456" }] }));
  await hook(ch("messages", { statuses: [{ id: wamid, status: "delivered", timestamp: "1", recipient_id: "5522998123456" }] }));
  assert.strictEqual(store.get("wa_conversations/5522998123456/messages/" + wamid).status, "read");
  // sem janela
  store.set("wa_conversations/5521900000000", { windowUntil: Date.now() - 1000, phone: "5521900000000" });
  await assert.rejects(call("waEnviar", { convId: "5521900000000", to: "5521900000000", line: "ln_revenda", kind: "text", text: "oi" }), /24h/);
  // erro da Meta vira mensagem com falha na conversa
  failNext = { code: 131026, message: "Undeliverable" };
  await assert.rejects(call("waEnviar", { convId: "5522998123456", to: "5522998123456", line: "ln_revenda", kind: "text", text: "vai falhar" }), /não ter WhatsApp/);
  const fails = [...store.entries()].filter(([p, d]) => p.startsWith("wa_conversations/5522998123456/messages/local_") && d.status === "failed");
  assert.strictEqual(fails.length, 1);
  await assert.rejects(call("waEnviar", { to: "5522998123456", line: "ln_revenda", kind: "text", text: "x" }, { auth: { uid: "u_exp" } }), /não pode/);
});

test("disparo: tira quem saiu, envia pela fila, conta resposta, opt-out e venda", async () => {
  store.set("wa_conversations/5531988776655", { optOut: true, telKey: "3188776655", phone: "5531988776655" });
  const r = await call("waDisparo", { nome: "Saudades", modelo: "saudades", line: "ln_revenda", destinatarios: [{ tel: "22998123456", name: "Mariana Souza" }, { tel: "(22) 99812-3456", name: "Dup" }, { tel: "31988776655", name: "Renata" }, { tel: "21987654321", name: "" }] });
  assert.strictEqual(r.total, 2, "duplicada e quem saiu ficam fora");
  await assert.rejects(call("waDisparo", { nome: "x", modelo: "saudades", line: "ln_revenda", destinatarios: [] }, atendente), /gestor/);
  const n0 = sent.length;
  await F.waFila.run({});
  const msgs = sent.slice(n0);
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(msgs.map(x => x.template.components[0].parameters[0].text).sort(), ["Mariana", "querida"]);
  const camp = [...store.entries()].find(([p]) => /^wa_campaigns\/[^/]+$/.test(p));
  assert.strictEqual(camp[1].enviadas, 2);
  const nova = store.get("wa_conversations/5521987654321");
  assert.strictEqual(nova.status, "encerrada", "contato novo do disparo não polui Aguardando");
  // cliente toca no botão "Não quero receber"
  await hook(ch("messages", { messages: [{ from: "5521987654321", id: "wamid.BTN", timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "Não quero receber" } }] }));
  const c2 = store.get("wa_conversations/5521987654321");
  assert.strictEqual(c2.optOut, true);
  const campNow = store.get(camp[0]);
  assert.strictEqual(campNow.respondidas, 1); assert.strictEqual(campNow.sairam, 1);
  // próxima rodada termina a campanha
  await F.waFila.run({});
  assert.strictEqual(store.get(camp[0]).status, "concluida");
  // venda da Mariana logo depois do disparo é atribuída
  store.set("wa_index/_atribuicao", { ate: new Date(Date.now() - 60000).toISOString() });
  store.set("sales/v1", { client: "Mariana Souza", value: 742.3, status: "aprovado", created_at: new Date().toISOString(), shipping_data: { tel: "22998123456" } });
  await F.waAtribuir.run({});
  await F.waAtribuir.run({}); // não conta duas vezes
  const fin = store.get(camp[0]);
  assert.strictEqual(fin.pedidos, 1); assert.strictEqual(fin.receita, 742.3);
});
