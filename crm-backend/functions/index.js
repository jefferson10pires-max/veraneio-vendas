"use strict";
/**
 * Conversas Veraneio — Cloud Functions do WhatsApp (API oficial e híbrida/coexistência)
 * Projeto Firebase: veraneio-vendas · Região: southamerica-east1 · codebase "whatsapp"
 *
 *  waWebhook        recebe mensagens, status, ecos do celular, histórico e contatos da Meta
 *  waEnviar         envia texto, mídia ou modelo (usuário logado do sistema)
 *  waModelos        lista modelos da conta
 *  waCriarModelo    envia modelo novo para aprovação (gestor)
 *  waConectar       conecta número pela tela da Meta (oficial ou híbrida) ou por token (gestor)
 *  waDesconectar    desliga o número do CRM (gestor)
 *  waDisparo        cria campanha e põe na fila (gestor)
 *  waFila           a cada minuto: envia a fila de disparos devagar
 *  waAtribuir       a cada 10 min: liga vendas novas às campanhas (receita atribuída)
 *  waCatalogo       busca peças na Yampi para mandar no chat
 */
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const W = require("./lib/wa");

admin.initializeApp();
const db = admin.firestore();
const bucket = () => admin.storage().bucket();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const META_APP_ID = defineString("META_APP_ID", { default: "" });
const META_APP_SECRET = defineSecret("META_APP_SECRET");
const WA_VERIFY_TOKEN = defineSecret("WA_VERIFY_TOKEN");
const YAMPI_ALIAS = defineString("YAMPI_ALIAS", { default: "" });
const YAMPI_TOKEN = defineSecret("YAMPI_TOKEN");
const YAMPI_SECRET = defineSecret("YAMPI_SECRET");
const GRAPH = "https://graph.facebook.com/v23.0";
const H24 = 24 * 3600 * 1000;

/* ---------------- utilidades ---------------- */
async function graph(path, { method = "GET", token, body, query } = {}) {
  const url = new URL(path.startsWith("http") ? path : GRAPH + path);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const r = await fetch(url, { method, headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    const err = new Error(W.friendlyError(e.code, e.error_user_msg || e.message || "Erro " + r.status));
    err.code = e.code; err.meta = e; throw err;
  }
  return j;
}
async function member(req, needManager) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Entre no sistema primeiro.");
  const s = await db.collection("members").doc(req.auth.uid).get();
  const m = s.exists ? s.data() : null;
  if (!m || m.type === "expedicao") throw new HttpsError("permission-denied", "Seu acesso não pode usar as conversas.");
  if (needManager && m.type !== "manager") throw new HttpsError("permission-denied", "Só o gestor pode fazer isso.");
  return { uid: req.auth.uid, name: m.name || (m.type === "manager" ? "Jefferson" : "Equipe"), type: m.type };
}
async function lineCreds(lineId) {
  if (!lineId) throw new HttpsError("invalid-argument", "Número (linha) não informado.");
  const [l, p] = await Promise.all([db.collection("wa_lines").doc(lineId).get(), db.collection("wa_private").doc(lineId).get()]);
  if (!l.exists || l.data().status !== "conectado" || !p.exists) throw new HttpsError("failed-precondition", "Este número não está conectado. Veja Conexões.");
  return Object.assign({ id: lineId }, l.data(), p.data());
}
const lineByPnid = (() => {
  const cache = {};
  return async pnid => {
    if (!pnid) return null;
    if (cache[pnid] && Date.now() - cache[pnid].at < 60000) return cache[pnid].v;
    const q = await db.collection("wa_lines").where("phoneNumberId", "==", String(pnid)).limit(1).get();
    const v = q.empty ? null : Object.assign({ id: q.docs[0].id }, q.docs[0].data());
    let token = null;
    if (v) { const p = await db.collection("wa_private").doc(v.id).get(); token = p.exists ? p.data().token : null; }
    cache[pnid] = { at: Date.now(), v: v && Object.assign(v, { token }) };
    return cache[pnid].v;
  };
})();
async function settings() { const s = await db.collection("wa_settings").doc("geral").get(); return Object.assign({ precoMarketing: 0.4, precoUtilidade: 0.05, atribuicaoHoras: 72 }, s.exists ? s.data() : {}); }
const convRef = id => db.collection("wa_conversations").doc(id);

/** Acha a conversa da cliente (com ou sem o 9) — evita duas conversas para a mesma pessoa. */
async function findConvId(wa) {
  const d = W.digits(wa);
  const direct = await convRef(d).get();
  if (direct.exists) return d;
  const k = W.telKey(d);
  if (k) { const q = await db.collection("wa_conversations").where("telKey", "==", k).limit(1).get(); if (!q.empty) return q.docs[0].id; }
  return d;
}

/** Baixa a mídia da Meta e guarda no Storage (os links da Meta expiram em minutos). */
async function storeMedia(mediaId, token, convId, msgId) {
  if (!mediaId || !token) return null;
  try {
    const info = await graph("/" + mediaId, { token });
    const r = await fetch(info.url, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error("download " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (info.mime_type || "").split("/")[1] ? info.mime_type.split("/")[1].split(";")[0].replace("mpeg", "mp3") : "bin";
    const path = `wa_in/${convId}/${msgId.replace(/[^\w.-]/g, "_")}.${ext}`;
    const dl = crypto.randomUUID();
    await bucket().file(path).save(buf, { contentType: info.mime_type, metadata: { metadata: { firebaseStorageDownloadTokens: dl } } });
    return { url: `https://firebasestorage.googleapis.com/v0/b/${bucket().name}/o/${encodeURIComponent(path)}?alt=media&token=${dl}`, mime: info.mime_type, size: buf.length, path };
  } catch (e) { logger.warn("mídia não baixada", mediaId, e.message); return null; }
}

/* ---------------- gravação ---------------- */
async function saveInbound(line, wa, contactName, msg, origin = "crm") {
  const convId = await findConvId(wa);
  const mref = convRef(convId).collection("messages").doc(msg.id);
  if ((await mref.get()).exists) return; // a Meta reenvia webhooks: idempotente
  if (msg.mediaId) { const st = await storeMedia(msg.mediaId, line && line.token, convId, msg.id); msg.media = Object.assign(msg.media || {}, st || {}); }
  if (msg.type === "reaction") { // reação vira marca na mensagem original
    const idx = msg.reactTo ? await db.collection("wa_index").doc(msg.reactTo).get() : null;
    if (idx && idx.exists) await convRef(idx.data().convId).collection("messages").doc(msg.reactTo).set({ reacao: msg.text || null }, { merge: true });
    return;
  }
  const doc = { dir: "in", type: msg.type, text: msg.text || "", ts: msg.ts, origin };
  ["media", "replyTo", "location"].forEach(k => msg[k] && (doc[k] = msg[k]));
  delete (doc.media || {}).path;
  await mref.set(doc);
  const optOut = W.isOptOut(msg.text);
  await db.runTransaction(async tx => {
    // Firestore: todas as leituras antes das gravações
    const cref = convRef(convId); const c = await tx.get(cref); const cur = c.exists ? c.data() : {};
    const camp = cur.lastCampaign && msg.ts - cur.lastCampaign.ts < 7 * 24 * 3600 * 1000 && origin !== "historico" ? cur.lastCampaign : null;
    const dref = camp ? db.collection("wa_campaigns").doc(camp.id).collection("dest").doc(camp.destId || convId) : null;
    const d = dref ? await tx.get(dref) : null;
    const newer = !cur.lastTs || msg.ts >= cur.lastTs;
    const patch = { phone: cur.phone || wa, telKey: W.telKey(wa), line: (line && line.id) || cur.line || null, windowUntil: Math.max(cur.windowUntil || 0, msg.ts + H24) };
    if (!cur.name && contactName) patch.name = contactName;
    if (contactName) patch.perfilNome = contactName;
    if (newer) Object.assign(patch, { lastTs: msg.ts, lastText: W.previewText(msg), lastDir: "in", status: "aberta", waitingSince: cur.lastDir === "in" && cur.waitingSince ? cur.waitingSince : msg.ts });
    if (origin !== "historico") patch.unread = admin.firestore.FieldValue.increment(1);
    if (optOut) Object.assign(patch, { optOut: true, optOutEm: msg.ts, optOutMotivo: msg.text });
    if (!c.exists) Object.assign(patch, { tags: [], notes: "", criadoEm: Date.now() });
    tx.set(cref, patch, { merge: true });
    // campanha: conta resposta e saída uma vez por cliente
    if (d && d.exists && !d.data().respondeuEm) {
      tx.set(dref, { respondeuEm: msg.ts, saiu: optOut || null }, { merge: true });
      tx.set(db.collection("wa_campaigns").doc(camp.id), { respondidas: admin.firestore.FieldValue.increment(1), sairam: admin.firestore.FieldValue.increment(optOut ? 1 : 0) }, { merge: true });
    }
  });
}
async function saveOutbound(convId, wa, wamid, doc, convPatch) {
  const id = wamid || "local_" + crypto.randomUUID();
  await convRef(convId).collection("messages").doc(id).set(Object.assign({ dir: "out", ts: Date.now() }, doc), { merge: true });
  if (wamid) await db.collection("wa_index").doc(wamid).set({ convId, campaignId: doc.campanhaId || null, ts: Date.now() });
  const patch = Object.assign({ phone: wa, telKey: W.telKey(wa) }, convPatch || {});
  if (doc.status !== "failed") Object.assign(patch, { lastTs: doc.ts || Date.now(), lastText: W.previewText(doc), lastDir: "out", waitingSince: null, unread: 0 });
  await convRef(convId).set(patch, { merge: true });
  return id;
}
async function applyStatus(ev, prices) {
  const idx = await db.collection("wa_index").doc(ev.id).get();
  if (!idx.exists) return;
  const { convId, campaignId } = idx.data();
  const mref = convRef(convId).collection("messages").doc(ev.id);
  await db.runTransaction(async tx => {
    const m = await tx.get(mref); if (!m.exists) return;
    const cur = m.data().status;
    const nx = W.nextStatus(cur, ev.status);
    if (nx === cur) return;
    const patch = { status: nx }; if (nx === "failed") patch.error = ev.error || "Não entregue";
    tx.set(mref, patch, { merge: true });
    if (campaignId) {
      const inc = admin.firestore.FieldValue.increment;
      const c = {};
      if (nx === "failed") c.falhas = inc(1);
      if (["delivered", "read"].includes(nx) && !["delivered", "read"].includes(cur)) c.entregues = inc(1);
      if (nx === "read" && cur !== "read") c.lidas = inc(1);
      if (ev.billable && !m.data().cobrada) { c.custo = inc(ev.category === "utility" ? prices.precoUtilidade : prices.precoMarketing); tx.set(mref, { cobrada: true }, { merge: true }); }
      if (Object.keys(c).length) tx.set(db.collection("wa_campaigns").doc(campaignId), c, { merge: true });
    }
  });
}

/* ================= WEBHOOK ================= */
exports.waWebhook = onRequest({ secrets: [META_APP_SECRET, WA_VERIFY_TOKEN], timeoutSeconds: 300, memory: "512MiB", invoker: "public" }, async (req, res) => {
  if (req.method === "GET") {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WA_VERIFY_TOKEN.value()) return res.status(200).send(String(req.query["hub.challenge"]));
    return res.sendStatus(403);
  }
  if (req.method !== "POST") return res.sendStatus(405);
  if (!W.verifySignature(req.rawBody, req.get("x-hub-signature-256"), META_APP_SECRET.value())) { logger.warn("assinatura inválida"); return res.sendStatus(401); }
  const events = W.extractEvents(req.body);
  let prices = null;
  for (const ev of events) {
    try {
      const line = ev.pnid ? await lineByPnid(ev.pnid) : null;
      if (ev.kind === "in") await saveInbound(line, ev.wa, ev.contactName, ev.msg);
      else if (ev.kind === "echo") { // mandada pelo app do celular (API híbrida)
        const convId = await findConvId(ev.wa);
        if (ev.msg.mediaId) { const st = await storeMedia(ev.msg.mediaId, line && line.token, convId, ev.msg.id); ev.msg.media = Object.assign(ev.msg.media || {}, st || {}); delete ev.msg.media.path; }
        const exists = (await convRef(convId).collection("messages").doc(ev.msg.id).get()).exists;
        if (!exists) await saveOutbound(convId, ev.wa, ev.msg.id, { type: ev.msg.type, text: ev.msg.text || "", media: ev.msg.media || null, ts: ev.msg.ts, status: "sent", origin: "celular", by: "Celular" }, { line: line && line.id });
      } else if (ev.kind === "status") { prices = prices || await settings(); await applyStatus(ev, prices); }
      else if (ev.kind === "history") await saveHistory(line, ev);
      else if (ev.kind === "contact") {
        const convId = await findConvId(ev.wa);
        const c = await convRef(convId).get();
        if (c.exists) { if (!c.data().name || c.data().name === c.data().perfilNome) await convRef(convId).set({ name: ev.name, agendaNome: ev.name }, { merge: true }); }
        else await db.collection("wa_contacts").doc(convId).set({ name: ev.name, telKey: W.telKey(ev.wa), em: Date.now() }, { merge: true });
      } else if (ev.kind === "quality") {
        const q = await db.collection("wa_lines").get();
        for (const d of q.docs) if (W.telKey(d.data().numero) === W.telKey(ev.display)) await d.ref.set({ qualidade: ev.quality, limite: ev.limit || d.data().limite || null }, { merge: true });
      } else if (ev.kind === "template") logger.info("modelo", ev);
    } catch (e) { logger.error("evento falhou", ev.kind, e); }
  }
  res.sendStatus(200);
});

/** Histórico importado do celular (API híbrida): grava sem contar como não lida. */
async function saveHistory(line, ev) {
  if (!line) return;
  let convs = 0, msgs = 0;
  for (const t of ev.threads) {
    if (!t.wa || !t.messages.length) continue;
    const convId = await findConvId(t.wa); convs++;
    const batch = db.batch();
    let last = null, lastIn = 0;
    for (const { dir, msg, status } of t.messages) {
      const doc = { dir, type: msg.type, text: msg.text || "", ts: msg.ts, origin: "historico" };
      if (msg.media) doc.media = msg.media; // mídia antiga pode não vir: aparece como "não veio na importação"
      if (dir === "out") { doc.status = { READ: "read", DELIVERED: "delivered", SENT: "sent", ERROR: "failed" }[String(status || "").toUpperCase()] || "sent"; doc.by = "Celular"; }
      batch.set(convRef(convId).collection("messages").doc(msg.id), doc, { merge: true }); msgs++;
      if (!last || msg.ts > last.ts) last = Object.assign({ dir }, msg);
      if (dir === "in" && msg.ts > lastIn) lastIn = msg.ts;
    }
    await batch.commit();
    await db.runTransaction(async tx => {
      const cref = convRef(convId); const c = await tx.get(cref); const cur = c.exists ? c.data() : {};
      const patch = { phone: cur.phone || t.wa, telKey: W.telKey(t.wa), line: cur.line || line.id };
      if (!c.exists) Object.assign(patch, { tags: [], notes: "", status: "encerrada", unread: 0, criadoEm: Date.now() });
      if (last && (!cur.lastTs || last.ts > cur.lastTs)) Object.assign(patch, { lastTs: last.ts, lastText: W.previewText(last), lastDir: last.dir });
      if (lastIn) patch.windowUntil = Math.max(cur.windowUntil || 0, lastIn + H24);
      const w = await tx.get(db.collection("wa_contacts").doc(convId)); if (!cur.name && w.exists) patch.name = w.data().name;
      tx.set(cref, patch, { merge: true });
    });
  }
  const inc = admin.firestore.FieldValue.increment;
  const status = ev.error ? "erro" : ev.progress >= 100 ? "concluido" : "importando";
  await db.collection("wa_lines").doc(line.id).set({ historico: { status, pct: ev.progress || 0, conversas: inc(convs), mensagens: inc(msgs), erro: ev.error || null, em: Date.now() } }, { merge: true });
}

/* ================= ENVIO ================= */
exports.waEnviar = onCall({ timeoutSeconds: 60 }, async req => {
  const me = await member(req);
  const d = req.data || {};
  const line = await lineCreds(d.line);
  const wa = W.toWa(d.to);
  if (!wa || wa.length < 12) throw new HttpsError("invalid-argument", "Número inválido.");
  const convId = d.convId || await findConvId(wa);
  const cs = await convRef(convId).get(); const conv = cs.exists ? cs.data() : {};
  if (d.kind !== "template" && !((conv.windowUntil || 0) > Date.now())) throw new HttpsError("failed-precondition", W.friendlyError(131047));
  let payload;
  try { payload = W.buildSendPayload(wa, d); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
  const doc = { type: d.kind === "text" ? "text" : d.kind === "template" ? "template" : payload.type, text: d.kind === "text" ? d.text : d.kind === "template" ? (d.preview || "") : (d.caption || ""), by: me.name, byUid: me.uid, origin: d.teste ? "teste" : "crm", ts: Date.now() };
  if (d.kind === "media") doc.media = { url: d.media.url, mime: d.media.mime, name: d.media.name || "" };
  if (d.kind === "template") doc.template = { name: d.template, vars: d.vars || [] };
  if (d.replyTo) doc.replyTo = d.replyTo;
  const convPatch = { line: line.id, status: "aberta" };
  if (!cs.exists) Object.assign(convPatch, { name: d.name || "", tags: [], notes: "", criadoEm: Date.now(), windowUntil: 0 });
  try {
    const r = await graph(`/${line.phoneNumberId}/messages`, { method: "POST", token: line.token, body: payload });
    const wamid = r.messages && r.messages[0] && r.messages[0].id;
    await saveOutbound(convId, wa, wamid, Object.assign(doc, { status: "pending" }), convPatch);
    return { ok: true, id: wamid, convId };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    await saveOutbound(convId, wa, null, Object.assign(doc, { status: "failed", error: e.message }), convPatch);
    throw new HttpsError("aborted", e.message);
  }
});

/* ================= MODELOS ================= */
exports.waModelos = onCall(async req => {
  await member(req);
  const line = await lineCreds(req.data && req.data.line);
  const out = []; let next = `/${line.wabaId}/message_templates`; let q = { fields: "name,status,category,language,components", limit: 100 };
  for (let i = 0; i < 5 && next; i++) { const r = await graph(next, { token: line.token, query: q }); (r.data || []).forEach(t => out.push(W.templateFromMeta(t))); next = r.paging && r.paging.next; q = null; }
  return { items: out.sort((a, b) => (a.status === "APPROVED" ? 0 : 1) - (b.status === "APPROVED" ? 0 : 1) || a.name.localeCompare(b.name)) };
});
exports.waCriarModelo = onCall(async req => {
  await member(req, true);
  const d = req.data || {};
  if (!d.name || !d.body) throw new HttpsError("invalid-argument", "Preencha nome e texto.");
  const line = await lineCreds(d.line);
  try { const r = await graph(`/${line.wabaId}/message_templates`, { method: "POST", token: line.token, body: W.templateToMeta(d) }); return { ok: true, id: r.id, status: r.status }; }
  catch (e) { throw new HttpsError("aborted", e.message); }
});

/* ================= CONEXÃO (oficial ou híbrida) ================= */
exports.waConectar = onCall({ secrets: [META_APP_SECRET], timeoutSeconds: 120 }, async req => {
  await member(req, true);
  const d = req.data || {};
  if (!["ln_revenda", "ln_varejo"].includes(d.line) && !/^ln_[a-z0-9_]{2,30}$/.test(d.line || "")) throw new HttpsError("invalid-argument", "Linha inválida.");
  if (!["oficial", "hibrida"].includes(d.modo)) throw new HttpsError("invalid-argument", "Modo inválido.");
  if (!d.phoneNumberId || !d.wabaId) throw new HttpsError("invalid-argument", "A Meta não informou o número.");
  const dup = await db.collection("wa_lines").where("phoneNumberId", "==", String(d.phoneNumberId)).get();
  if (dup.docs.some(x => x.id !== d.line && x.data().status === "conectado")) throw new HttpsError("already-exists", "Esse número já está conectado em outra linha.");
  await db.collection("wa_lines").doc(d.line).set({ nome: d.nome || d.line, status: "conectando", modo: d.modo }, { merge: true });
  try {
    let token = d.token;
    if (d.via !== "manual") {
      if (!META_APP_ID.value()) throw new Error("Configure META_APP_ID nas variáveis das functions.");
      const r = await graph("/oauth/access_token", { query: { client_id: META_APP_ID.value(), client_secret: META_APP_SECRET.value(), code: d.code } });
      token = r.access_token;
    }
    if (!token) throw new Error("Sem token.");
    await graph(`/${d.wabaId}/subscribed_apps`, { method: "POST", token });
    let pin = null;
    if (d.modo === "oficial" && d.via !== "manual") { // número novo na Cloud API precisa ser registrado
      pin = String(crypto.randomInt(100000, 999999));
      await graph(`/${d.phoneNumberId}/register`, { method: "POST", token, body: { messaging_product: "whatsapp", pin } });
    }
    const info = await graph(`/${d.phoneNumberId}`, { token, query: { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier" } });
    await db.collection("wa_private").doc(d.line).set({ token, phoneNumberId: String(d.phoneNumberId), wabaId: String(d.wabaId), pin, em: Date.now() });
    const LIM = { TIER_250: "250 por dia", TIER_1K: "1.000 por dia", TIER_10K: "10.000 por dia", TIER_100K: "100.000 por dia", TIER_UNLIMITED: "sem limite" };
    await db.collection("wa_lines").doc(d.line).set({ nome: d.nome || d.line, modo: d.modo, status: "conectado", phoneNumberId: String(d.phoneNumberId), wabaId: String(d.wabaId), numero: info.display_phone_number || "", nomeVerificado: info.verified_name || "", qualidade: info.quality_rating || null, limite: LIM[info.messaging_limit_tier] || info.messaging_limit_tier || null, conectadoEm: Date.now(), ultimaAberturaApp: d.modo === "hibrida" ? Date.now() : null, historico: d.modo === "hibrida" ? { status: "importando", pct: 0, conversas: 0, mensagens: 0 } : null }, { merge: true });
    if (d.modo === "hibrida") { // pede contatos e histórico do app do celular (só uma vez, nas primeiras 24h)
      try { await graph(`/${d.phoneNumberId}/smb_app_data`, { method: "POST", token, body: { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" } }); } catch (e) { logger.warn("contatos", e.message); }
      try { await graph(`/${d.phoneNumberId}/smb_app_data`, { method: "POST", token, body: { messaging_product: "whatsapp", sync_type: "history" } }); }
      catch (e) { logger.warn("histórico", e.message); await db.collection("wa_lines").doc(d.line).set({ historico: { status: "erro", erro: e.message } }, { merge: true }); }
    }
    return { ok: true, numero: info.display_phone_number };
  } catch (e) {
    await db.collection("wa_lines").doc(d.line).set({ status: "desconectado", erro: e.message }, { merge: true });
    throw new HttpsError("aborted", e.message);
  }
});
exports.waDesconectar = onCall(async req => {
  await member(req, true);
  const line = req.data && req.data.line; if (!line) throw new HttpsError("invalid-argument", "Linha?");
  await db.collection("wa_private").doc(line).delete();
  await db.collection("wa_lines").doc(line).set({ status: "desconectado", desconectadoEm: Date.now() }, { merge: true });
  return { ok: true };
});

/* ================= DISPAROS ================= */
exports.waDisparo = onCall({ timeoutSeconds: 120 }, async req => {
  const me = await member(req, true);
  const d = req.data || {};
  await lineCreds(d.line);
  if (!d.nome || !d.modelo) throw new HttpsError("invalid-argument", "Falta nome ou modelo.");
  const list = Array.isArray(d.destinatarios) ? d.destinatarios.slice(0, 5000) : [];
  const blocked = new Set((await db.collection("wa_conversations").where("optOut", "==", true).get()).docs.map(x => x.data().telKey || W.telKey(x.id)));
  const seen = new Set(); const dest = [];
  for (const x of list) { const wa = W.toWa(x.tel); const k = W.telKey(wa); if (!k || seen.has(k) || blocked.has(k)) continue; seen.add(k); dest.push({ wa, name: String(x.name || "").slice(0, 80) }); }
  if (!dest.length) throw new HttpsError("failed-precondition", "Ninguém para enviar (todos sem telefone ou fora da lista).");
  const ref = db.collection("wa_campaigns").doc();
  await ref.set({ nome: d.nome, modelo: d.modelo, language: d.language || "pt_BR", categoria: d.categoria || "MARKETING", line: d.line, publico: d.publico || "", total: dest.length, status: d.agendarPara ? "agendada" : "enviando", agendarPara: d.agendarPara || null, criadoEm: Date.now(), criadoPor: me.name, enviadas: 0, entregues: 0, lidas: 0, respondidas: 0, falhas: 0, sairam: 0, pedidos: 0, receita: 0, custo: 0, custoEstimado: d.custoEstimado || 0 });
  for (let i = 0; i < dest.length; i += 400) {
    const b = db.batch();
    dest.slice(i, i + 400).forEach((x, j) => b.set(ref.collection("dest").doc(x.wa), { wa: x.wa, name: x.name, status: "fila", ordem: i + j }));
    await b.commit();
  }
  return { ok: true, id: ref.id, total: dest.length };
});

/** Fila: envia aos poucos (por minuto) e respeita o limite diário do número. */
exports.waFila = onSchedule({ schedule: "every 1 minutes", timeoutSeconds: 120, memory: "512MiB" }, async () => {
  const now = Date.now();
  const q = await db.collection("wa_campaigns").where("status", "in", ["enviando", "agendada"]).get();
  for (const cdoc of q.docs) {
    const c = cdoc.data();
    if (c.status === "agendada") { if (!(c.agendarPara <= now)) continue; await cdoc.ref.update({ status: "enviando" }); }
    let line; try { line = await lineCreds(c.line); } catch (e) { await cdoc.ref.update({ status: "pausada", motivo: "Número desconectado" }); continue; }
    const tpl = await graph(`/${line.wabaId}/message_templates`, { token: line.token, query: { name: c.modelo, fields: "name,status,components,language" } }).then(r => (r.data || []).map(W.templateFromMeta).find(t => t.name === c.modelo)).catch(() => null);
    if (!tpl || tpl.status !== "APPROVED") { await cdoc.ref.update({ status: "pausada", motivo: "Modelo não aprovado ou pausado pela Meta" }); continue; }
    const nVars = (tpl.body.match(/\{\{\d+\}\}/g) || []).length;
    const batch = await cdoc.ref.collection("dest").where("status", "==", "fila").orderBy("ordem").limit(60).get();
    if (batch.empty) { await cdoc.ref.update({ status: "concluida", concluidaEm: now }); continue; }
    for (const dd of batch.docs) {
      const x = dd.data();
      const vars = nVars ? [W.firstName(x.name) || "querida"].concat(Array(nVars - 1).fill("")) : [];
      if (vars.slice(1).some(v => !v)) { await cdoc.ref.update({ status: "pausada", motivo: "O modelo tem mais de uma variável; disparo só preenche o {{1}}" }); break; }
      try {
        const r = await graph(`/${line.phoneNumberId}/messages`, { method: "POST", token: line.token, body: W.buildSendPayload(x.wa, { kind: "template", template: c.modelo, language: c.language, vars }) });
        const wamid = r.messages[0].id;
        const convId = await findConvId(x.wa);
        const exists = (await convRef(convId).get()).exists;
        await saveOutbound(convId, x.wa, wamid, { type: "template", template: { name: c.modelo, buttons: tpl.buttons || null }, text: tpl.body.replace(/\{\{(\d+)\}\}/g, (m, i) => vars[i - 1] || m), status: "pending", origin: "campanha", campanha: c.nome, campanhaId: cdoc.id, ts: Date.now() },
          Object.assign({ line: line.id, lastCampaign: { id: cdoc.id, ts: Date.now(), destId: dd.id } }, exists ? {} : { name: x.name, tags: [], notes: "", status: "encerrada", criadoEm: Date.now(), windowUntil: 0 }));
        await dd.ref.set({ status: "enviada", wamid, convId, em: Date.now() }, { merge: true });
        await cdoc.ref.update({ enviadas: admin.firestore.FieldValue.increment(1) });
      } catch (e) {
        await dd.ref.set({ status: "falha", erro: e.message }, { merge: true });
        await cdoc.ref.update({ falhas: admin.firestore.FieldValue.increment(1) });
        if ([131048, 131031, 190, 368].includes(e.code)) { await cdoc.ref.update({ status: "pausada", motivo: e.message }); break; } // proteger o número
        if (e.code === 130429) break; // limite por segundo: continua no próximo minuto
      }
    }
  }
});

/** Receita atribuída: venda nova da cliente até X horas depois de uma mensagem de campanha. */
exports.waAtribuir = onSchedule({ schedule: "every 10 minutes", timeoutSeconds: 120 }, async () => {
  const st = await settings(); const janela = (st.atribuicaoHoras || 72) * 3600 * 1000;
  const mark = db.collection("wa_index").doc("_atribuicao");
  const m = await mark.get(); const since = m.exists ? m.data().ate : new Date(Date.now() - 3600 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const sales = await db.collection("sales").where("created_at", ">", since).where("created_at", "<=", nowIso).get();
  for (const s of sales.docs) {
    const v = s.data(); if (v.status === "cancelado") continue;
    const k = W.telKey((v.shipping_data || {}).tel || v.phone); if (!k) continue;
    const cq = await db.collection("wa_conversations").where("telKey", "==", k).limit(1).get(); if (cq.empty) continue;
    const lc = cq.docs[0].data().lastCampaign; const t = new Date(v.created_at).getTime();
    if (!lc || t < lc.ts || t - lc.ts > janela) continue;
    const aref = db.collection("wa_index").doc("venda_" + s.id);
    await db.runTransaction(async tx => {
      if ((await tx.get(aref)).exists) return;
      tx.set(aref, { campaignId: lc.id, valor: Number(v.value) || 0 });
      tx.set(db.collection("wa_campaigns").doc(lc.id), { pedidos: admin.firestore.FieldValue.increment(1), receita: admin.firestore.FieldValue.increment(Number(v.value) || 0) }, { merge: true });
    });
  }
  await mark.set({ ate: nowIso });
});

/* ================= CATÁLOGO (Yampi) ================= */
exports.waCatalogo = onCall({ secrets: [YAMPI_TOKEN, YAMPI_SECRET] }, async req => {
  await member(req);
  if (!YAMPI_ALIAS.value()) throw new HttpsError("failed-precondition", "Configure a Yampi (YAMPI_ALIAS, YAMPI_TOKEN, YAMPI_SECRET).");
  const q = String((req.data && req.data.q) || "").slice(0, 60);
  const url = new URL(`https://api.dooki.com.br/v2/${YAMPI_ALIAS.value()}/catalog/products`);
  url.searchParams.set("include", "images,skus"); url.searchParams.set("limit", "24");
  if (q) url.searchParams.set("q", q);
  const r = await fetch(url, { headers: { "User-Token": YAMPI_TOKEN.value(), "User-Secret-Key": YAMPI_SECRET.value(), Accept: "application/json" } });
  if (!r.ok) throw new HttpsError("unavailable", "Yampi respondeu " + r.status);
  const j = await r.json();
  const items = (j.data || []).filter(p => p.active !== false).map(p => {
    const img = ((p.images || {}).data || [])[0] || {};
    const sku = ((p.skus || {}).data || [])[0] || {};
    return { id: String(p.id), nome: p.name, preco: Number(sku.price_sale || sku.price_discount || p.price || 0), foto: img.large && img.large.url || img.url || "", url: p.url || (p.slug ? `https://veraneiojoias.com.br/${p.slug}` : "") };
  });
  return { items };
});

/* ================= PEDIDOS DA YAMPI (para recorrência, cupons e frete) ================= */
const Y = require("./lib/yampi");
async function yampiPage(page, extra = {}) {
  const url = new URL(`https://api.dooki.com.br/v2/${YAMPI_ALIAS.value()}/orders`);
  url.searchParams.set("include", "items,customer,shipping_address,promocode,transactions");
  url.searchParams.set("limit", "50"); url.searchParams.set("page", String(page));
  url.searchParams.set("orderBy", "id"); url.searchParams.set("sortedBy", "desc");
  Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { "User-Token": YAMPI_TOKEN.value(), "User-Secret-Key": YAMPI_SECRET.value(), Accept: "application/json" } });
  if (r.status === 429) { await new Promise(x => setTimeout(x, 3000)); return yampiPage(page, extra); }
  if (!r.ok) throw new Error("Yampi respondeu " + r.status);
  return r.json();
}
/** Lê da mais nova para a mais antiga até passar da data limite e grava em yampi_orders. */
async function yampiSync(desdeMs, maxPaginas) {
  let page = 1, gravados = 0, fim = false;
  while (!fim && page <= maxPaginas) {
    const j = await yampiPage(page);
    const list = (j.data || []).map(Y.normalizeYampiOrder);
    if (!list.length) break;
    const b = db.batch();
    list.forEach(o => { if (o.t >= desdeMs) { b.set(db.collection("yampi_orders").doc(o.id), Object.assign(o, { sincronizadoEm: Date.now() })); gravados++; } });
    await b.commit();
    if (list[list.length - 1].t < desdeMs) fim = true;
    const tp = j.meta && j.meta.pagination && j.meta.pagination.total_pages; if (tp && page >= tp) fim = true;
    page++;
  }
  await db.collection("wa_settings").doc("yampi").set({ ultimaSync: Date.now(), gravados, paginas: page - 1 }, { merge: true });
  return { gravados, paginas: page - 1 };
}
// a cada hora revisa os últimos 10 dias (pedidos novos e mudanças de status)
exports.waYampiSync = onSchedule({ schedule: "every 60 minutes", timeoutSeconds: 300, secrets: [YAMPI_TOKEN, YAMPI_SECRET] }, async () => {
  if (!YAMPI_ALIAS.value()) return;
  await yampiSync(Date.now() - 10 * 864e5, 40);
});
// importação inicial: gestor escolhe quantos meses (até 13)
exports.waYampiImportar = onCall({ timeoutSeconds: 540, memory: "512MiB", secrets: [YAMPI_TOKEN, YAMPI_SECRET] }, async req => {
  await member(req, true);
  if (!YAMPI_ALIAS.value()) throw new HttpsError("failed-precondition", "Configure a Yampi (YAMPI_ALIAS, YAMPI_TOKEN, YAMPI_SECRET).");
  const meses = Math.min(13, Math.max(1, Number(req.data && req.data.meses) || 3));
  return yampiSync(Date.now() - meses * 31 * 864e5, 400);
});
