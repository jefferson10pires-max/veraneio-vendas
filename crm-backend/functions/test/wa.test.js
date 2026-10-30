"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const W = require("../lib/wa");

test("telKey casa celular com e sem o 9", () => {
  assert.strictEqual(W.telKey("5522998478111"), W.telKey("552298478111"));
  assert.strictEqual(W.telKey("(22) 99847-8111"), "2298478111");
  assert.strictEqual(W.telKey("123"), "");
});

test("toWa põe o 55", () => {
  assert.strictEqual(W.toWa("(22) 99847-8111"), "5522998478111");
  assert.strictEqual(W.toWa("5522998478111"), "5522998478111");
});

test("assinatura do webhook", () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }));
  const sig = "sha256=" + crypto.createHmac("sha256", "segredo").update(body).digest("hex");
  assert.ok(W.verifySignature(body, sig, "segredo"));
  assert.ok(!W.verifySignature(body, sig, "outro"));
  assert.ok(!W.verifySignature(body, "sha256=abc", "segredo"));
  assert.ok(!W.verifySignature(body, undefined, "segredo"));
});

test("opt-out", () => {
  ["SAIR", "Sair.", "não quero receber", "Não quero mais receber", "parar", "Me tira da lista por favor"].forEach(t => assert.ok(W.isOptOut(t), t));
  ["quero sair hoje para comprar mais peças da coleção nova que vocês lançaram ontem à noite", "Quero ver", "obrigada", "vou sair agora, depois te chamo", ""].forEach(t => assert.ok(!W.isOptOut(t), t));
});

test("status só anda para frente", () => {
  assert.strictEqual(W.nextStatus("read", "delivered"), "read");
  assert.strictEqual(W.nextStatus("pending", "sent"), "sent");
  assert.strictEqual(W.nextStatus("delivered", "failed"), "failed");
  assert.strictEqual(W.nextStatus("failed", "read"), "failed");
});

const meta = { phone_number_id: "111", display_phone_number: "5522998478111" };
test("webhook: mensagem de texto, foto e botão", () => {
  const ev = W.extractEvents({ entry: [{ changes: [{ field: "messages", value: { metadata: meta, contacts: [{ wa_id: "5521987654321", profile: { name: "Juliana" } }], messages: [
    { from: "5521987654321", id: "wamid.1", timestamp: "1730000000", type: "text", text: { body: "Oi!" } },
    { from: "5521987654321", id: "wamid.2", timestamp: "1730000001", type: "image", image: { id: "MID", mime_type: "image/jpeg", caption: "essa" } },
    { from: "5521987654321", id: "wamid.3", timestamp: "1730000002", type: "button", button: { text: "Não quero receber" }, context: { id: "wamid.T" } },
  ] } }] }] });
  assert.strictEqual(ev.length, 3);
  assert.deepStrictEqual([ev[0].kind, ev[0].wa, ev[0].contactName, ev[0].msg.text, ev[0].msg.ts], ["in", "5521987654321", "Juliana", "Oi!", 1730000000000]);
  assert.strictEqual(ev[1].msg.mediaId, "MID"); assert.strictEqual(ev[1].msg.text, "essa");
  assert.strictEqual(ev[2].msg.replyTo, "wamid.T"); assert.ok(W.isOptOut(ev[2].msg.text));
});

test("webhook: status com erro e cobrança", () => {
  const ev = W.extractEvents({ entry: [{ changes: [{ field: "messages", value: { metadata: meta, statuses: [{ id: "wamid.X", status: "failed", timestamp: "1730000000", recipient_id: "5521987654321", errors: [{ code: 131047, title: "Re-engagement message" }], pricing: { billable: false, category: "service" } }] } }] }] });
  assert.strictEqual(ev[0].kind, "status"); assert.match(ev[0].error, /131047/); assert.strictEqual(ev[0].billable, false);
});

test("webhook híbrida: eco do celular e histórico", () => {
  const echo = W.extractEvents({ entry: [{ changes: [{ field: "smb_message_echoes", value: { metadata: meta, message_echoes: [{ from: "5522998478111", to: "5524999887766", id: "wamid.E", timestamp: "1730000005", type: "text", text: { body: "Mandei pelo celular" } }] } }] }] });
  assert.deepStrictEqual([echo[0].kind, echo[0].wa, echo[0].msg.text], ["echo", "5524999887766", "Mandei pelo celular"]);
  const hist = W.extractEvents({ entry: [{ changes: [{ field: "history", value: { metadata: meta, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 55 }, threads: [{ id: "5524999887766", messages: [
    { from: "5524999887766", id: "h1", timestamp: "1720000000", type: "text", text: { body: "antiga dela" }, history_context: { status: "READ" } },
    { from: "5522998478111", id: "h2", timestamp: "1720000100", type: "text", text: { body: "antiga nossa" }, history_context: { status: "DELIVERED" } },
  ] }] }] } }] }] });
  assert.strictEqual(hist[0].kind, "history"); assert.strictEqual(hist[0].progress, 55);
  assert.deepStrictEqual(hist[0].threads[0].messages.map(m => m.dir), ["in", "out"]);
  const ct = W.extractEvents({ entry: [{ changes: [{ field: "smb_app_state_sync", value: { metadata: meta, state_sync: [{ type: "contact", contact: { full_name: "Mariana Revenda Petrópolis", phone_number: "5522998123456" }, action: "add" }] } }] }] });
  assert.deepStrictEqual([ct[0].kind, ct[0].name], ["contact", "Mariana Revenda Petrópolis"]);
});

test("montagem do envio", () => {
  assert.deepStrictEqual(W.buildSendPayload("22998123456", { kind: "text", text: "oi" }).text, { body: "oi", preview_url: false });
  const img = W.buildSendPayload("22998123456", { kind: "media", media: { url: "https://x/y.jpg", mime: "image/jpeg" }, caption: "Argola" });
  assert.strictEqual(img.type, "image"); assert.strictEqual(img.image.caption, "Argola"); assert.strictEqual(img.to, "5522998123456");
  const doc = W.buildSendPayload("22998123456", { kind: "media", media: { url: "https://x/c.pdf", mime: "application/pdf", name: "catalogo.pdf" } });
  assert.strictEqual(doc.document.filename, "catalogo.pdf");
  const t = W.buildSendPayload("22998123456", { kind: "template", template: "saudades", vars: ["Mariana"], replyTo: "wamid.1" });
  assert.deepStrictEqual(t.template.components[0].parameters, [{ type: "text", text: "Mariana" }]); assert.strictEqual(t.context.message_id, "wamid.1");
  assert.throws(() => W.buildSendPayload("22998123456", { kind: "template", template: "x", vars: [""] }));
  assert.throws(() => W.buildSendPayload("22998123456", { kind: "text", text: "  " }));
});

test("modelos ida e volta", () => {
  const m = W.templateToMeta({ name: "Novidades Semana", category: "MARKETING", body: "Oi {{1}}! Chegou novidade", buttons: ["Quero ver", "Não quero receber"] });
  assert.strictEqual(m.name, "novidades_semana"); assert.deepStrictEqual(m.components[0].example.body_text, [["Mariana"]]);
  const back = W.templateFromMeta({ name: m.name, status: "APPROVED", category: "MARKETING", language: "pt_BR", components: [{ type: "BODY", text: "Oi {{1}}! Chegou novidade" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Quero ver" }] }] });
  assert.deepStrictEqual([back.body, back.buttons, back.vars], ["Oi {{1}}! Chegou novidade", ["Quero ver"], ["primeiroNome"]]);
});
