/**
 * Regra de preço da loja. A mesma conta existe no painel da revendedora
 * (public/painel.html → precoFinal) para mostrar a prévia. Se mudar aqui, mude lá.
 *
 * base   = preço de atacado Veraneio
 * margem = % da revendedora (padrão ou por peça)
 * arred  = "none" (exato) | "90" (termina em ,90) | "int" (valor inteiro)
 * Nunca fica abaixo do atacado.
 */
function precoFinal(base, pr, id) {
  base = Number(base) || 0;
  const o = pr.over && pr.over[id];
  const m = Math.max(0, (o === undefined || o === null || o === "") ? Number(pr.margem || 0) : Number(o));
  let v = base * (1 + m / 100);
  if (pr.arred === "90") { let r = Math.floor(v) + 0.9; if (r < v - 0.005) r += 1; v = r; }
  else if (pr.arred === "int") v = Math.ceil(v - 0.005);
  else v = Math.round(v * 100) / 100;
  return Math.max(Math.round(v * 100) / 100, base);
}
module.exports = { precoFinal };
