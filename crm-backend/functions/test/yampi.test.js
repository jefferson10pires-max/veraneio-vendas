"use strict";
const test = require("node:test");
const assert = require("node:assert");
const Y = require("../lib/yampi");

const base = {
  id: 177033040, number: 551973314485340, value_total: "516.26", value_products: "540.50", value_shipment: "15.75", value_discount: "-39.99",
  created_at: { date: "2026-10-29 14:39:49.000000" }, status: { data: { alias: "invoiced", name: "Faturado" } },
  customer: { data: { name: "Thais Andrade silva", email: "t@x.com", phone: { full_number: "(47) 99781-2150" } } },
  shipping_address: { data: { city: "Penha", uf: "sc" } }, shipment_service: "FRETE PROMOCIONAL",
  promocode: { data: { code: "volta10" } }, transactions: { data: [{ payment: { data: { alias: "pix", name: "Pix" } } }] },
  items: { data: [{ quantity: 2, price: 22.9, sku: { data: { title: "Colar corrente Masculino C66", sku: "748UTN6JY" } } }] },
};

test("normaliza pedido da Yampi", () => {
  const o = Y.normalizeYampiOrder(base);
  assert.strictEqual(o.numero, "551973314485340"); assert.strictEqual(o.data, "2026-10-29");
  assert.strictEqual(o.total, 516.26); assert.strictEqual(o.frete, 15.75); assert.strictEqual(o.desconto, 39.99);
  assert.strictEqual(o.cupom, "VOLTA10"); assert.strictEqual(o.cupomDesconto, 39.99); assert.strictEqual(o.promocao, 0);
  assert.strictEqual(o.telKey, "4797812150"); assert.strictEqual(o.uf, "SC"); assert.strictEqual(o.pagamento, "pix"); assert.ok(o.pago);
  assert.deepStrictEqual(o.itens[0], { nome: "Colar corrente Masculino C66", sku: "748UTN6JY", qtd: 2, preco: 22.9 });
});
test("desconto sem cupom é promoção; status sem pagamento não conta", () => {
  const o = Y.normalizeYampiOrder(Object.assign({}, base, { promocode: null, status: { data: { name: "Aguardando pagamento" } } }));
  assert.strictEqual(o.cupom, ""); assert.strictEqual(o.promocao, 39.99); assert.strictEqual(o.pago, false);
  assert.strictEqual(Y.normalizeYampiOrder(Object.assign({}, base, { status: { data: { name: "Cancelado" } } })).pago, false);
});
test("pedido sem campos opcionais não quebra", () => {
  const o = Y.normalizeYampiOrder({ id: 1, created_at: "2026-10-01 10:00:00", value_total: 100 });
  assert.strictEqual(o.total, 100); assert.strictEqual(o.frete, 0); assert.deepStrictEqual(o.itens, []);
});
test("frete: padrão 15,75, grátis, acima e retirada", () => {
  assert.deepStrictEqual(Y.freteInfo({ frete: 15.75 }), { pago: 15.75, padrao: 15.75, desconto: 0, acima: 0, gratis: false });
  assert.strictEqual(Y.freteInfo({ frete: 0 }).desconto, 15.75);
  assert.strictEqual(Y.freteInfo({ frete: 0 }).gratis, true);
  assert.strictEqual(Y.freteInfo({ frete: 25.25 }).acima, 9.5);
  assert.strictEqual(Y.freteInfo({ frete: 10, envio: "retirada" }), null);
});
