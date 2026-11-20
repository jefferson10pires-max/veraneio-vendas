import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { criarAssinaturas, avisoAutentico, conferirAviso, maisMeses, novoPagoAte, DIA, Erro } from "./mp.js";

const AGORA = Date.UTC(2026, 10, 20, 12);
function montar({ docs = {}, respostas = {} } = {}) {
  const banco = structuredClone(docs);
  const chamadas = [];
  const merge = (p, o, opt) => { banco[p] = opt && opt.merge ? { ...(banco[p] || {}), ...o } : { ...o }; };
  const store = {
    get: async (p) => (banco[p] ? structuredClone(banco[p]) : null),
    set: async (p, o, opt) => merge(p, o, opt),
    tx: async (fn) => { const w = []; const r = await fn({ get: store.get, set: (p, o, opt) => w.push([p, o, opt]) }); w.forEach((x) => merge(...x)); return r; },
  };
  const mp = async (method, path, body) => {
    chamadas.push({ method, path, body });
    const r = respostas[`${method} ${path}`];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(body);
    if (!r) throw new Erro("mp_falhou", 502);
    return structuredClone(r);
  };
  const s = criarAssinaturas({ store, mp, agora: () => AGORA, ts: (ms) => ms });
  return { s, banco, chamadas };
}
const base = { "config/planos": { valor: 39.9, valorPix: 35 }, "lojas/u1": { nome: "Loja" } };

test("datas: soma de mês no calendário e validade", () => {
  assert.equal(new Date(maisMeses(Date.UTC(2026, 0, 31))).toISOString().slice(0, 10), "2026-02-28");
  assert.equal(novoPagoAte({ atual: null, tipo: "pix", agora: AGORA }), maisMeses(AGORA));
  const adiantado = AGORA + 10 * DIA; // Pix pago antes de vencer soma a partir do vencimento
  assert.equal(novoPagoAte({ atual: adiantado, tipo: "pix", agora: AGORA }), maisMeses(adiantado));
  assert.equal(novoPagoAte({ atual: AGORA + 60 * DIA, tipo: "cartao", dataPagamento: AGORA, agora: AGORA }), AGORA + 60 * DIA);
});

test("aviso do Mercado Pago: aceita só com a assinatura certa", () => {
  const segredo = "s3gr3d0", ts = "1704908010", rid = "abc-123";
  const v1 = createHmac("sha256", segredo).update(`id:999;request-id:${rid};ts:${ts};`).digest("hex");
  assert.equal(avisoAutentico({ assinatura: `ts=${ts},v1=${v1}`, requestId: rid, dataId: "999", segredo }), true);
  assert.equal(avisoAutentico({ assinatura: `ts=${ts},v1=${v1}`, requestId: rid, dataId: "998", segredo }), false);
  assert.equal(avisoAutentico({ assinatura: `ts=${ts},v1=${v1}`, requestId: "outro", dataId: "999", segredo }), false);
  assert.equal(avisoAutentico({ assinatura: `ts=${ts},v1=${v1}`, requestId: rid, dataId: "999", segredo: "x" }), false);
  assert.equal(avisoAutentico({ assinatura: "", requestId: rid, dataId: "999", segredo }), false);
  assert.equal(avisoAutentico({ assinatura: "ts=1,v1=zz", requestId: rid, dataId: "999", segredo }), false);
});

test("Pix: gera com o valor do banco, reaproveita o pendente, libera 1 mês só depois de aprovado e só uma vez", async () => {
  const { s, banco, chamadas } = montar({ docs: base, respostas: {
    "POST /v1/payments": { id: 555, status: "pending", point_of_interaction: { transaction_data: { qr_code: "000201PIX", qr_code_base64: "iVBOR" } } },
    "GET /v1/payments/555": { id: 555, status: "approved", currency_id: "BRL", transaction_amount: 35, external_reference: "pix:u1", date_approved: new Date(AGORA).toISOString() },
  } });
  const q = await s.gerarPix("u1", "a@b.com");
  assert.equal(q.valor, 35);
  assert.equal(chamadas[0].body.transaction_amount, 35);
  assert.equal(chamadas[0].body.external_reference, "pix:u1");
  assert.equal((await s.gerarPix("u1", "a@b.com")).id, "555"); // reaproveitou
  assert.equal(chamadas.filter((c) => c.method === "POST").length, 1);
  assert.equal(banco["planos/u1"], undefined); // ainda não pagou
  assert.deepEqual(await s.conferirPix("u1", "555"), { pago: true });
  assert.equal(banco["planos/u1"].plano, "assinante");
  assert.equal(banco["planos/u1"].origem, "pix");
  assert.equal(banco["planos/u1"].pagoAte, maisMeses(AGORA));
  assert.equal(await s.aviso("payment", "555"), "ja_aplicado"); // repetido: não soma de novo
  assert.equal(banco["planos/u1"].pagoAte, maisMeses(AGORA));
});

test("Pix de outra revendedora, valor menor ou pendente não libera", async () => {
  const { s, banco } = montar({ docs: { ...base, "assinaturas/u1/pagamentos/7": { tipo: "pix", valor: 35 }, "assinaturas/u2/pagamentos/8": { tipo: "pix", valor: 35 } }, respostas: {
    "GET /v1/payments/7": { id: 7, status: "approved", currency_id: "BRL", transaction_amount: 1, external_reference: "pix:u1" },
    "GET /v1/payments/8": { id: 8, status: "pending", currency_id: "BRL", transaction_amount: 35, external_reference: "pix:u2" },
  } });
  assert.deepEqual(await s.conferirPix("u1", "7"), { pago: false });
  await assert.rejects(s.conferirPix("u1", "8"), /nao_encontrado/); // não é dela
  assert.deepEqual(await s.conferirPix("u2", "8"), { pago: false });
  assert.equal(banco["planos/u1"], undefined);
  assert.equal(banco["planos/u2"], undefined);
  assert.equal(await s.aviso("payment", "8"), "pix_pendente");
});

test("cartão: cria assinatura recorrente com valor do banco, libera provisório e a cobrança aprovada vira 1 mês", async () => {
  const { s, banco, chamadas } = montar({ docs: base, respostas: {
    "POST /preapproval": (b) => ({ id: "pre1", status: "authorized", external_reference: b.external_reference }),
    "GET /authorized_payments/77": { id: 77, preapproval_id: "pre1", transaction_amount: 39.9, currency_id: "BRL", debit_date: new Date(AGORA).toISOString(), payment: { id: 9001, status: "approved" } },
    "GET /preapproval/pre1": { id: "pre1", status: "authorized", external_reference: "u1", next_payment_date: new Date(AGORA + 30 * DIA).toISOString() },
  } });
  await s.assinarCartao("u1", "a@b.com", { token: "abcdef0123456789abcdef" });
  const pre = chamadas.find((c) => c.path === "/preapproval").body;
  assert.equal(pre.auto_recurring.transaction_amount, 39.9);
  assert.equal(pre.auto_recurring.frequency_type, "months");
  assert.equal(pre.external_reference, "u1");
  assert.equal(banco["planos/u1"].pagoAte, AGORA + 2 * DIA);
  await assert.rejects(s.assinarCartao("u1", "a@b.com", { token: "abcdef0123456789abcdef" }), /ja_tem_cartao/);
  await assert.rejects(s.gerarPix("u1", "a@b.com"), /ja_tem_cartao/);
  assert.equal(await s.aviso("subscription_authorized_payment", "77"), "cartao_aplicado");
  assert.equal(banco["planos/u1"].pagoAte, maisMeses(AGORA) + DIA);
  assert.equal(await s.aviso("subscription_authorized_payment", "77"), "cartao_aplicado");
  assert.equal(banco["planos/u1"].pagoAte, maisMeses(AGORA) + DIA); // mesma cobrança não soma
  assert.equal(banco["assinaturas/u1/pagamentos/9001"].aplicado, true);
});

test("cobrança de assinatura que não é a guardada para a revendedora é ignorada", async () => {
  const { s, banco } = montar({ docs: { ...base, "assinaturas/u1": { cartao: { id: "preX", status: "authorized" } } }, respostas: {
    "GET /authorized_payments/5": { id: 5, preapproval_id: "preY", transaction_amount: 39.9, payment: { id: 1, status: "approved" } },
    "GET /preapproval/preY": { id: "preY", status: "authorized", external_reference: "u1" },
  } });
  assert.equal(await s.aviso("subscription_authorized_payment", "5"), "desconhecido");
  assert.equal(banco["planos/u1"], undefined);
});

test("assinante manual sem vencimento continua sem vencimento se pagar", async () => {
  const { s, banco } = montar({ docs: { ...base, "planos/u1": { plano: "assinante", pagoAte: null, origem: "manual" }, "assinaturas/u1/pagamentos/9": { tipo: "pix", valor: 35 } }, respostas: {
    "GET /v1/payments/9": { id: 9, status: "approved", currency_id: "BRL", transaction_amount: 35, external_reference: "pix:u1" },
  } });
  assert.deepEqual(await s.conferirPix("u1", "9"), { pago: true });
  assert.equal(banco["planos/u1"].pagoAte, null);
  assert.equal(banco["planos/u1"].origem, "manual");
});

test("sem valor configurado, token inválido ou cancelamento sem cartão: recusa", async () => {
  const { s } = montar({ docs: { "lojas/u1": {} } });
  await assert.rejects(s.gerarPix("u1", "a@b.com"), /sem_valor/);
  await assert.rejects(s.assinarCartao("u1", "a@b.com", { token: "<script>" }), /cartao_invalido/);
  await assert.rejects(s.cancelarCartao("u1"), /sem_cartao/);
});

test("conferir aviso: id da URL ou do corpo, com ou sem request-id; sempre exige o segredo", () => {
  const segredo = "abc", ts = "1700000000";
  const sig = (m) => `ts=${ts},v1=` + createHmac("sha256", segredo).update(m).digest("hex");
  assert.deepEqual(conferirAviso({ assinatura: sig(`id:55;request-id:r1;ts:${ts};`), requestId: "r1", idUrl: "55", idCorpo: "55", segredo }), { dataId: "55", variante: "url+rid" });
  assert.deepEqual(conferirAviso({ assinatura: sig(`id:55;ts:${ts};`), requestId: "r1", idUrl: "55", segredo }), { dataId: "55", variante: "url" });
  assert.deepEqual(conferirAviso({ assinatura: sig(`id:77;request-id:r1;ts:${ts};`), requestId: "r1", idUrl: "", idCorpo: "77", segredo }), { dataId: "77", variante: "corpo+rid" });
  assert.equal(conferirAviso({ assinatura: sig(`id:55;ts:${ts};`), requestId: "r1", idUrl: "55", segredo: "outro" }), null);
  assert.equal(conferirAviso({ assinatura: sig(`id:55;ts:${ts};`), requestId: "r1", idUrl: "56", segredo }), null);
});
