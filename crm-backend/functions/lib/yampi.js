"use strict";
/**
 * Normaliza pedidos da API da Yampi (api.dooki.com.br/v2/{alias}/orders) para o formato
 * que o CRM usa nos indicadores (recorrência, cupons, promoções e frete).
 * Tolerante a variações de formato: campos ausentes viram 0/"".
 */
const W = require("./wa");

const num = v => { const n = Number(typeof v === "string" ? v.replace(",", ".") : v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const dataOf = x => (x && x.data !== undefined ? x.data : x);
const dateStr = v => { const s = typeof v === "object" && v ? v.date || v.datetime || "" : String(v || ""); return s.replace(" ", "T").slice(0, 19); };

/* Status que NÃO contam como venda */
const NAO_VENDA = /aguardando|waiting|pending|cancel|recus|refus|estorn|refund|chargeback|expir/i;

function normalizeYampiOrder(o) {
  const st = dataOf(o.status) || {};
  const statusNome = typeof st === "string" ? st : st.name || st.alias || "";
  const cust = dataOf(o.customer) || {};
  const phone = cust.phone && typeof cust.phone === "object" ? cust.phone.full_number || cust.phone.formated_number || cust.phone.number : cust.phone || cust.cellphone || "";
  const addr = dataOf(o.shipping_address) || dataOf(o.address) || {};
  const promo = dataOf(o.promocode) || null;
  const items = (dataOf(o.items) || []).map(i => {
    const sku = dataOf(i.sku) || {}; const prod = dataOf(i.product) || {};
    return { nome: sku.title || prod.name || i.name || i.title || "Peça", sku: sku.sku || i.sku_code || "", qtd: num(i.quantity || i.qty || 1), preco: num(i.price || i.price_sale || sku.price_sale) };
  });
  const trans = dataOf(o.transactions) || [];
  const pay = trans.length ? (dataOf(trans[0].payment) || {}) : {};
  const produtos = num(o.value_products) || items.reduce((a, i) => a + i.qtd * i.preco, 0);
  const frete = num(o.value_shipment);
  const desconto = Math.abs(num(o.value_discount));
  const cupom = promo && (promo.code || promo.name) ? String(promo.code || promo.name).toUpperCase() : "";
  const criado = dateStr(o.created_at);
  return {
    id: String(o.id), numero: String(o.number || o.id),
    data: criado.slice(0, 10), t: criado ? new Date(criado + "-03:00").getTime() : 0,
    status: statusNome, pago: !NAO_VENDA.test(statusNome),
    nome: cust.name || [cust.first_name, cust.last_name].filter(Boolean).join(" ") || "", email: cust.email || "",
    tel: W.digits(phone), telKey: W.telKey(phone),
    cidade: addr.city || "", uf: String(addr.uf || addr.state || "").toUpperCase().slice(0, 2),
    total: num(o.value_total) || Math.round((produtos - desconto + frete) * 100) / 100,
    produtos, frete, desconto,
    cupom, cupomDesconto: cupom ? desconto : 0, promocao: cupom ? 0 : desconto,
    envio: o.shipment_service || dataOf(o.shipment)?.service || "",
    pagamento: pay.alias || pay.name || "",
    itens: items,
  };
}

/** Frete: quanto a cliente pagou, o padrão e o desconto dado naquele envio. */
function freteInfo({ frete, envio, padrao = 15.75 }) {
  if (/retirad/i.test(String(envio || ""))) return null; // retirada não tem frete
  const pago = num(frete);
  return { pago, padrao, desconto: Math.max(0, Math.round((padrao - pago) * 100) / 100), acima: Math.max(0, Math.round((pago - padrao) * 100) / 100), gratis: pago === 0 };
}

module.exports = { normalizeYampiOrder, freteInfo, NAO_VENDA };
