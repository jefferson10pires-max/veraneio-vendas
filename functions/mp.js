/* Lógica de assinatura das revendedoras com o Mercado Pago (sem dependência do Firebase, para dar para testar).
 *
 * Segurança:
 *  - a chave secreta (access token) e o segredo do webhook vêm do cofre do Google (Secret Manager), nunca do navegador;
 *  - valores sempre lidos do banco (config/planos), nunca do que o navegador manda;
 *  - o aviso (webhook) só é aceito com a assinatura HMAC do Mercado Pago, e mesmo assim o pagamento é
 *    consultado direto na API do Mercado Pago antes de liberar qualquer coisa;
 *  - Pix só é aceito se foi criado por nós para aquela revendedora; cartão só se a assinatura é a que guardamos para ela;
 *  - cada pagamento é aplicado uma vez só (transação + marca "aplicado").
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export const DIA = 864e5;
const MP = "https://api.mercadopago.com";
const URL_PAINEL = "https://vitrine-de-semijoias.web.app/painel";
export const URL_WEBHOOK = "https://vitrine-de-semijoias.web.app/api/mp-webhook";

export class Erro extends Error {
  constructor(codigo, status = 400, msg) { super(msg || codigo); this.codigo = codigo; this.status = status; }
}

export const emMs = (t) => {
  if (t == null) return null;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  if (t instanceof Date) return t.getTime();
  return null;
};
/** soma meses no calendário (31/01 + 1 mês = último dia de fevereiro) */
export function maisMeses(ms, n = 1) {
  const d = new Date(ms), dia = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.getTime();
}
/** até quando fica pago depois de um pagamento aprovado.
 *  Pix: mês somado a partir do que já estava pago (pagar adiantado não perde dias).
 *  Cartão: um mês a partir da data da cobrança (+1 dia de folga para a próxima cobrança cair), sem nunca diminuir. */
export function novoPagoAte({ atual, tipo, dataPagamento, agora }) {
  const a = emMs(atual);
  if (tipo === "pix") return maisMeses(Math.max(agora, a || 0), 1);
  const base = maisMeses(emMs(dataPagamento) || agora, 1) + DIA;
  return Math.max(base, a || 0);
}

/** confere a assinatura do aviso do Mercado Pago (cabeçalho x-signature: "ts=...,v1=...") */
export function avisoAutentico({ assinatura, requestId, dataId, segredo }) {
  if (!assinatura || !segredo || !dataId) return false;
  const partes = Object.fromEntries(String(assinatura).split(",").map((p) => p.trim().split("=").map((x) => x.trim())));
  if (!partes.ts || !partes.v1 || !/^[a-f0-9]{64}$/i.test(partes.v1)) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : String(dataId);
  let manifesto = `id:${id};`;
  if (requestId) manifesto += `request-id:${requestId};`;
  manifesto += `ts:${partes.ts};`;
  const esperado = createHmac("sha256", segredo).update(manifesto).digest();
  const veio = Buffer.from(partes.v1, "hex");
  return veio.length === esperado.length && timingSafeEqual(veio, esperado);
}

/** confere o aviso tentando as variações que o Mercado Pago usa (id na URL ou no corpo; com ou sem request-id).
 *  Todas exigem o HMAC com o nosso segredo; devolve qual bateu (para o log) ou null. */
export function conferirAviso({ assinatura, requestId, idUrl, idCorpo, segredo }) {
  const ids = [...new Set([idUrl, idCorpo].filter(Boolean).map(String))];
  for (const dataId of ids) {
    if (requestId && avisoAutentico({ assinatura, requestId, dataId, segredo })) return { dataId, variante: dataId === idUrl ? "url+rid" : "corpo+rid" };
    if (avisoAutentico({ assinatura, requestId: "", dataId, segredo })) return { dataId, variante: dataId === idUrl ? "url" : "corpo" };
  }
  return null;
}

const valorOk = (v) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 10000;
const dinheiro = (v) => Math.round(v * 100) / 100;

/**
 * deps: {
 *   store: { get(path), set(path, obj, {merge}), tx(fn(t: {get,set})) , list(colPath) },
 *   mp(method, path, body, extraHeaders) → resposta JSON (lança Erro em falha),
 *   agora(): ms, ts(ms): valor de data para o banco
 * }
 */
export function criarAssinaturas(deps) {
  const { store, mp } = deps;
  const agora = () => deps.agora();
  const ts = (ms) => deps.ts(ms);

  async function config() {
    const c = (await store.get("config/planos")) || {};
    const valor = valorOk(c.valor) ? dinheiro(c.valor) : 0;
    const valorPix = valorOk(c.valorPix) ? dinheiro(c.valorPix) : valor;
    return { valor, valorPix };
  }

  /** aplica um pagamento aprovado uma vez só */
  async function aplicar(uid, pagId, tipo, { valor, dataPagamento, extra = {} } = {}) {
    return store.tx(async (t) => {
      const pPath = `assinaturas/${uid}/pagamentos/${pagId}`;
      const pag = (await t.get(pPath)) || {};
      if (pag.aplicado) return false;
      const plano = (await t.get(`planos/${uid}`)) || {};
      const semVenc = plano.plano === "assinante" && plano.pagoAte == null && (plano.origem || "manual") === "manual";
      const novo = semVenc ? null : novoPagoAte({ atual: plano.pagoAte, tipo, dataPagamento, agora: agora() });
      t.set(`planos/${uid}`, { plano: "assinante", origem: semVenc ? "manual" : tipo, pagoAte: novo == null ? null : ts(novo), mudadoEm: ts(agora()) }, { merge: true });
      t.set(pPath, { ...extra, tipo, valor: valor ?? pag.valor ?? null, status: "approved", aplicado: true, aplicadoEm: ts(agora()) }, { merge: true });
      return true;
    });
  }

  async function lojaExiste(uid) { return !!(await store.get(`lojas/${uid}`)); }

  /* ---------- ações pedidas pelo painel (revendedora logada) ---------- */

  async function assinarCartao(uid, email, { token }) {
    if (typeof token !== "string" || !/^[A-Za-z0-9]{16,64}$/.test(token)) throw new Erro("cartao_invalido");
    const { valor } = await config();
    if (!valor) throw new Erro("sem_valor", 409);
    const a = (await store.get(`assinaturas/${uid}`)) || {};
    if (a.cartao && ["authorized", "pending"].includes(a.cartao.status)) throw new Erro("ja_tem_cartao", 409);
    const r = await mp("POST", "/preapproval", {
      reason: "Assinatura do painel da loja",
      external_reference: uid,
      payer_email: email,
      card_token_id: token,
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: valor, currency_id: "BRL" },
      back_url: URL_PAINEL,
      status: "authorized",
    }, { "X-Idempotency-Key": randomUUID() });
    if (!r || !r.id) throw new Erro("mp_falhou", 502);
    await store.set(`assinaturas/${uid}`, { cartao: { id: String(r.id), status: r.status || "pending", valor, desde: ts(agora()) }, atualizadoEm: ts(agora()) }, { merge: true });
    if (r.status === "authorized") {
      // a 1ª cobrança cai em até ~1 hora: libera já, por 2 dias; quando a cobrança aprovar, vira 1 mês
      await store.tx(async (t) => {
        const pl = (await t.get(`planos/${uid}`)) || {};
        const atual = emMs(pl.pagoAte);
        const semVenc = pl.plano === "assinante" && pl.pagoAte == null && (pl.origem || "manual") === "manual";
        if (semVenc) return;
        t.set(`planos/${uid}`, { plano: "assinante", origem: "cartao", pagoAte: ts(Math.max(atual || 0, agora() + 2 * DIA)), mudadoEm: ts(agora()) }, { merge: true });
      });
    }
    return { status: r.status };
  }

  async function gerarPix(uid, email) {
    const { valorPix } = await config();
    if (!valorPix) throw new Erro("sem_valor", 409);
    const a = (await store.get(`assinaturas/${uid}`)) || {};
    if (a.cartao && a.cartao.status === "authorized") throw new Erro("ja_tem_cartao", 409);
    // reaproveita um Pix pendente que ainda vale por mais de 5 minutos (e com o mesmo valor)
    const pend = a.pixPendente;
    if (pend && emMs(pend.expira) > agora() + 5 * 60e3 && pend.valor === valorPix) {
      const p = await store.get(`assinaturas/${uid}/pagamentos/${pend.id}`);
      if (p && !p.aplicado && p.qr) return { id: pend.id, qr: p.qr, qrImg: p.qrImg, valor: p.valor, expira: emMs(pend.expira) };
    }
    const expira = agora() + 30 * 60e3;
    const r = await mp("POST", "/v1/payments", {
      transaction_amount: valorPix,
      description: "Mensalidade do painel da loja",
      payment_method_id: "pix",
      payer: { email },
      external_reference: `pix:${uid}`,
      notification_url: URL_WEBHOOK,
      date_of_expiration: new Date(expira).toISOString().replace("Z", "+00:00"),
    }, { "X-Idempotency-Key": randomUUID() });
    const td = r && r.point_of_interaction && r.point_of_interaction.transaction_data;
    if (!r || !r.id || !td || !td.qr_code) throw new Erro("mp_falhou", 502);
    const id = String(r.id);
    await store.set(`assinaturas/${uid}/pagamentos/${id}`, { tipo: "pix", valor: valorPix, status: r.status || "pending", qr: td.qr_code, qrImg: td.qr_code_base64 || null, criadoEm: ts(agora()), expira: ts(expira) });
    await store.set(`assinaturas/${uid}`, { pixPendente: { id, valor: valorPix, expira: ts(expira) }, atualizadoEm: ts(agora()) }, { merge: true });
    return { id, qr: td.qr_code, qrImg: td.qr_code_base64 || null, valor: valorPix, expira };
  }

  /** confere um Pix no Mercado Pago (o painel chama enquanto mostra o QR; o webhook faz o mesmo) */
  async function conferirPix(uid, id) {
    if (!/^\d{1,20}$/.test(String(id || ""))) throw new Erro("id_invalido");
    const meu = await store.get(`assinaturas/${uid}/pagamentos/${id}`);
    if (!meu || meu.tipo !== "pix") throw new Erro("nao_encontrado", 404);
    if (meu.aplicado) return { pago: true };
    const p = await mp("GET", `/v1/payments/${id}`);
    return { pago: await aplicarSePixAprovado(uid, String(id), meu, p) };
  }

  async function aplicarSePixAprovado(uid, id, meu, p) {
    if (!p || String(p.id) !== id || p.external_reference !== `pix:${uid}`) return false;
    if (p.status !== "approved" || p.currency_id !== "BRL") {
      await store.set(`assinaturas/${uid}/pagamentos/${id}`, { status: p.status || "?" }, { merge: true });
      return false;
    }
    if (!(Number(p.transaction_amount) >= Number(meu.valor) - 0.01)) return false;
    await aplicar(uid, id, "pix", { valor: Number(p.transaction_amount), dataPagamento: Date.parse(p.date_approved) || agora() });
    await store.set(`assinaturas/${uid}`, { pixPendente: null, atualizadoEm: ts(agora()) }, { merge: true });
    return true;
  }

  async function cancelarCartao(uid) {
    const a = (await store.get(`assinaturas/${uid}`)) || {};
    if (!a.cartao || !a.cartao.id || a.cartao.status === "cancelled") throw new Erro("sem_cartao", 409);
    const r = await mp("PUT", `/preapproval/${a.cartao.id}`, { status: "cancelled" });
    await store.set(`assinaturas/${uid}`, { cartao: { ...a.cartao, status: (r && r.status) || "cancelled", canceladoEm: ts(agora()) }, atualizadoEm: ts(agora()) }, { merge: true });
    return { status: (r && r.status) || "cancelled" };
  }

  /** atualiza o status do cartão consultando o Mercado Pago */
  async function sincronizarCartao(uid) {
    const a = (await store.get(`assinaturas/${uid}`)) || {};
    if (!a.cartao || !a.cartao.id) return null;
    const r = await mp("GET", `/preapproval/${a.cartao.id}`);
    if (!r || r.external_reference !== uid) return a.cartao;
    const cartao = { ...a.cartao, status: r.status, proxima: r.next_payment_date ? ts(Date.parse(r.next_payment_date)) : null };
    await store.set(`assinaturas/${uid}`, { cartao, atualizadoEm: ts(agora()) }, { merge: true });
    return cartao;
  }

  /* ---------- aviso do Mercado Pago (webhook) — já autenticado pela assinatura HMAC ---------- */
  async function aviso(tipo, dataId) {
    const id = String(dataId || "");
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return "ignorado";
    if (tipo === "payment") {
      const p = await mp("GET", `/v1/payments/${id}`);
      const ref = String((p && p.external_reference) || "");
      if (!ref.startsWith("pix:")) return "ignorado"; // cobranças do cartão chegam pelo tópico de assinatura
      const uid = ref.slice(4);
      const meu = await store.get(`assinaturas/${uid}/pagamentos/${id}`);
      if (!meu || meu.tipo !== "pix") return "desconhecido";
      if (meu.aplicado) return "ja_aplicado";
      return (await aplicarSePixAprovado(uid, id, meu, p)) ? "pix_aplicado" : "pix_pendente";
    }
    if (tipo === "subscription_preapproval") {
      const r = await mp("GET", `/preapproval/${id}`);
      const uid = String((r && r.external_reference) || "");
      const a = uid && (await store.get(`assinaturas/${uid}`));
      if (!a || !a.cartao || a.cartao.id !== id) return "desconhecido";
      await store.set(`assinaturas/${uid}`, { cartao: { ...a.cartao, status: r.status, proxima: r.next_payment_date ? ts(Date.parse(r.next_payment_date)) : null }, atualizadoEm: ts(agora()) }, { merge: true });
      return "cartao_" + r.status;
    }
    if (tipo === "subscription_authorized_payment") {
      const f = await mp("GET", `/authorized_payments/${id}`);
      const preId = String((f && f.preapproval_id) || "");
      if (!preId) return "desconhecido";
      const r = await mp("GET", `/preapproval/${preId}`);
      const uid = String((r && r.external_reference) || "");
      const a = uid && (await store.get(`assinaturas/${uid}`));
      if (!a || !a.cartao || a.cartao.id !== preId) return "desconhecido";
      const pay = f.payment || {};
      if (pay.status !== "approved" || !pay.id) return "cobranca_" + (pay.status || f.status || "?");
      if (!(Number(f.transaction_amount) >= 1) || (f.currency_id && f.currency_id !== "BRL")) return "valor_invalido";
      await aplicar(uid, String(pay.id), "cartao", {
        valor: Number(f.transaction_amount),
        dataPagamento: Date.parse(f.debit_date || f.date_created) || agora(),
        extra: { cobranca: id, preapproval: preId },
      });
      return "cartao_aplicado";
    }
    return "ignorado";
  }

  return { config, assinarCartao, gerarPix, conferirPix, cancelarCartao, sincronizarCartao, aviso, aplicar, lojaExiste };
}
