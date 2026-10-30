"use strict";
/**
 * Funções puras do WhatsApp (sem Firebase) — testadas em test/wa.test.js
 * Cobrem: assinatura do webhook, leitura dos eventos da Cloud API
 * (mensagens, status, ecos do celular na API híbrida, histórico importado,
 * contatos), opt-out e montagem do que vai para a Meta.
 */
const crypto = require("crypto");

const digits = s => String(s == null ? "" : s).replace(/\D/g, "");

/** DDD + 8 últimos dígitos: casa número com e sem o 9 (o WhatsApp às vezes manda celular BR sem o 9). */
function telKey(s) {
  let d = digits(s);
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length < 10) return "";
  return d.slice(0, 2) + d.slice(-8);
}

/** Número no formato do WhatsApp (55 + DDD + número). */
function toWa(s) {
  let d = digits(s);
  if (!d) return "";
  if (d.length <= 11) d = "55" + d;
  return d;
}

/** Valida X-Hub-Signature-256 com o App Secret. */
function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret || !rawBody) return false;
  const [algo, sig] = String(header).split("=");
  if (algo !== "sha256" || !sig) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const OPT_OUT = ["sair", "parar", "pare", "stop", "descadastrar", "cancelar inscricao", "nao quero receber", "nao quero mais receber", "nao quero mais", "remover", "me tira da lista", "tirar da lista"];
/** A cliente pediu para sair das campanhas? (texto curto ou botão do modelo) */
function isOptOut(text) {
  const t = norm(text).replace(/[!.?,]+$/g, "");
  if (!t || t.length > 60) return false;
  return OPT_OUT.some(k => t === k || t.startsWith(k + " ") || t.endsWith(" " + k) || (k.length > 8 && t.includes(k)));
}

/** Converte uma mensagem da Cloud API para o formato salvo no Firestore. */
function parseMessage(m) {
  const out = { id: m.id, type: m.type, text: "", ts: (Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000 };
  if (m.context && m.context.id) out.replyTo = m.context.id;
  switch (m.type) {
    case "text": out.text = (m.text && m.text.body) || ""; break;
    case "image": case "video": case "audio": case "document": case "sticker": {
      const md = m[m.type] || {};
      out.text = md.caption || "";
      out.mediaId = md.id || null;
      out.media = { mime: md.mime_type || "", name: md.filename || "", voice: !!md.voice };
      break;
    }
    case "button": out.text = (m.button && (m.button.text || m.button.payload)) || ""; break;
    case "interactive": {
      const i = m.interactive || {};
      out.text = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || (i.nfm_reply && "Formulário respondido") || "";
      break;
    }
    case "reaction": out.text = (m.reaction && m.reaction.emoji) || ""; out.reactTo = m.reaction && m.reaction.message_id; break;
    case "location": out.location = { latitude: m.location && m.location.latitude, longitude: m.location && m.location.longitude, name: m.location && m.location.name }; out.text = (m.location && (m.location.name || m.location.address)) || "Localização"; break;
    case "contacts": out.text = "Contato: " + (((m.contacts || [])[0] || {}).name || {}).formatted_name; break;
    case "order": out.text = "Pedido pelo catálogo do WhatsApp (" + ((m.order && m.order.product_items) || []).length + " itens)"; break;
    default: out.type = "unsupported"; out.text = ""; break;
  }
  return out;
}

const PREVIEW = { image: "📷 Foto", video: "🎬 Vídeo", audio: "🎤 Áudio", document: "📄 Documento", sticker: "Figurinha", location: "📍 Localização", reaction: "Reação", template: "Modelo", unsupported: "Mensagem" };
const previewText = m => (m.text ? m.text : PREVIEW[m.type] || "").slice(0, 160);

const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
/** Status só anda para frente (read não volta para delivered). Falha sempre vence. */
function nextStatus(cur, incoming) {
  if (incoming === "failed") return "failed";
  if (cur === "failed") return cur;
  return (STATUS_RANK[incoming] || 0) > (STATUS_RANK[cur] || 0) ? incoming : cur;
}

/**
 * Lê o corpo do webhook e devolve eventos normalizados:
 *  {kind:"in", pnid, contactName, msg}            mensagem da cliente
 *  {kind:"echo", pnid, to, msg}                   enviada pelo app do celular (API híbrida)
 *  {kind:"status", pnid, id, status, to, error, billable, category}
 *  {kind:"history", pnid, phase, progress, threads:[{wa:"55…", messages:[{dir, msg}]}]}
 *  {kind:"contact", pnid, wa, name}               agenda do celular (API híbrida)
 *  {kind:"quality", wabaOrPnid, quality, limit}
 *  {kind:"template", name, status, reason}
 */
function extractEvents(body) {
  const ev = [];
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const pnid = v.metadata && v.metadata.phone_number_id;
      const business = digits(v.metadata && v.metadata.display_phone_number);
      if (ch.field === "messages") {
        const names = {};
        (v.contacts || []).forEach(c => { names[c.wa_id] = c.profile && c.profile.name; });
        (v.messages || []).forEach(m => ev.push({ kind: "in", pnid, wa: digits(m.from), contactName: names[m.from] || "", msg: parseMessage(m) }));
        (v.statuses || []).forEach(s => {
          const e = (s.errors || [])[0];
          ev.push({ kind: "status", pnid, id: s.id, status: s.status, to: digits(s.recipient_id), ts: (Number(s.timestamp) || 0) * 1000, error: e ? `${e.code || ""} ${e.title || ""}${e.error_data && e.error_data.details ? " — " + e.error_data.details : ""}`.trim() : "", billable: !!(s.pricing && s.pricing.billable), category: s.pricing && s.pricing.category });
        });
      } else if (ch.field === "smb_message_echoes") {
        (v.message_echoes || []).forEach(m => ev.push({ kind: "echo", pnid, wa: digits(m.to), msg: parseMessage(m) }));
      } else if (ch.field === "history") {
        for (const h of v.history || []) {
          const meta = h.metadata || {};
          const threads = (h.threads || []).map(t => ({
            wa: digits(t.id),
            messages: (t.messages || []).map(m => ({ dir: business && digits(m.from) === business ? "out" : (digits(m.from) === digits(t.id) ? "in" : "out"), msg: parseMessage(m), status: m.history_context && m.history_context.status })),
          }));
          ev.push({ kind: "history", pnid, phase: meta.phase, chunk: meta.chunk_order, progress: Number(meta.progress) || 0, threads, error: (h.errors || [])[0] ? h.errors[0].message || h.errors[0].title : "" });
        }
      } else if (ch.field === "smb_app_state_sync") {
        (v.state_sync || []).forEach(s => { if (s.type === "contact" && s.contact) ev.push({ kind: "contact", pnid, wa: digits(s.contact.phone_number), name: s.contact.full_name || s.contact.first_name || "", action: s.action }); });
      } else if (ch.field === "phone_number_quality_update") {
        ev.push({ kind: "quality", display: digits(v.display_phone_number), quality: v.event, limit: v.current_limit });
      } else if (ch.field === "message_template_status_update") {
        ev.push({ kind: "template", name: v.message_template_name, status: v.event, reason: v.reason });
      }
    }
  }
  return ev;
}

/** Monta o JSON de envio para POST /{phone-number-id}/messages */
function buildSendPayload(to, p) {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: toWa(to) };
  if (p.replyTo) base.context = { message_id: p.replyTo };
  if (p.kind === "text") {
    const body = String(p.text || "").slice(0, 4096);
    if (!body.trim()) throw new Error("Mensagem vazia");
    return Object.assign(base, { type: "text", text: { body, preview_url: /https?:\/\//.test(body) } });
  }
  if (p.kind === "media") {
    const mime = (p.media && p.media.mime) || "";
    const type = /^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "document";
    const obj = { link: p.media.url };
    if (p.caption && type !== "audio") obj.caption = String(p.caption).slice(0, 1024);
    if (type === "document") obj.filename = p.media.name || "arquivo";
    return Object.assign(base, { type, [type]: obj });
  }
  if (p.kind === "template") {
    const t = { name: p.template, language: { code: p.language || "pt_BR" } };
    const vars = (p.vars || []).map(v => String(v == null ? "" : v).trim());
    if (vars.length) {
      if (vars.some(v => !v)) throw new Error("Preencha todas as variáveis do modelo");
      t.components = [{ type: "body", parameters: vars.map(text => ({ type: "text", text })) }];
    }
    return Object.assign(base, { type: "template", template: t });
  }
  throw new Error("Tipo de envio desconhecido: " + p.kind);
}

/** Converte um modelo vindo da Meta para o formato usado no CRM. */
function templateFromMeta(t) {
  const comps = t.components || [];
  const body = (comps.find(c => c.type === "BODY") || {}).text || "";
  const btn = comps.find(c => c.type === "BUTTONS");
  const n = (body.match(/\{\{\d+\}\}/g) || []).length;
  return {
    name: t.name, status: t.status, category: t.category, language: t.language, body,
    header: (comps.find(c => c.type === "HEADER") || {}).text || "",
    footer: (comps.find(c => c.type === "FOOTER") || {}).text || "",
    buttons: btn ? (btn.buttons || []).map(b => b.text) : undefined,
    vars: n ? ["primeiroNome"].concat(Array(Math.max(0, n - 1)).fill("")) : [],
  };
}

/** Componentes para criar modelo na Meta. */
function templateToMeta({ name, category, body, buttons, language }) {
  const comps = [];
  const nVars = (body.match(/\{\{\d+\}\}/g) || []).length;
  const bodyC = { type: "BODY", text: body };
  if (nVars) bodyC.example = { body_text: [Array.from({ length: nVars }, (_, i) => (i === 0 ? "Mariana" : "exemplo"))] };
  comps.push(bodyC);
  if (buttons && buttons.length) comps.push({ type: "BUTTONS", buttons: buttons.slice(0, 3).map(text => ({ type: "QUICK_REPLY", text: String(text).slice(0, 25) })) });
  return { name: String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 512), language: language || "pt_BR", category: category === "UTILITY" ? "UTILITY" : "MARKETING", components: comps };
}

const firstName = s => (String(s || "").trim().split(/\s+/)[0] || "");
/** Mensagem amigável para erros comuns da Cloud API. */
function friendlyError(code, fallback) {
  const map = {
    131047: "Janela de 24h fechada: envie um modelo aprovado.",
    131026: "Mensagem não entregue: o número pode não ter WhatsApp.",
    131049: "A Meta segurou a mensagem para não cansar a cliente (limite de marketing por pessoa).",
    131050: "A cliente parou de receber mensagens de marketing deste número.",
    131056: "Muitas mensagens seguidas para a mesma pessoa. Espere um pouco.",
    132001: "Modelo não existe ou ainda não foi aprovado.",
    132000: "Número de variáveis diferente do modelo.",
    131031: "Conta bloqueada pela Meta. Veja o Gerenciador do WhatsApp.",
    190: "Token da Meta expirou. Reconecte o número em Conexões.",
    130429: "Limite de envio por segundo atingido. Tentando de novo em instantes.",
    131048: "Limite de envio atingido por denúncias/bloqueios. Pause os disparos.",
  };
  return map[code] || fallback || "Erro da Meta " + code;
}

module.exports = { digits, telKey, toWa, verifySignature, isOptOut, parseMessage, previewText, nextStatus, extractEvents, buildSendPayload, templateFromMeta, templateToMeta, firstName, friendlyError, norm };
