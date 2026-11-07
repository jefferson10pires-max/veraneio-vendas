// Firebase simulado para os testes do painel e do ADM (substitui os módulos do gstatic).
// Banco e login ficam no localStorage, então sobrevivem a recarregar a página.
const LS = "fake:db", LU = "fake:user";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lerDB = () => { try { const s = localStorage.getItem(LS); if (s) return JSON.parse(s); } catch (e) {} const seed = window.__FAKE_SEED || {}; localStorage.setItem(LS, JSON.stringify(seed)); return JSON.parse(JSON.stringify(seed)); };
const gravarDB = (d) => localStorage.setItem(LS, JSON.stringify(d));
const atraso = async (path) => { const d = window.__FAKE_DELAY || {}; for (const k in d) if (path.startsWith(k)) await sleep(d[k]); await sleep(5); };
const conta = (path) => { window.__FAKE_ESCRITAS = window.__FAKE_ESCRITAS || []; window.__FAKE_ESCRITAS.push(path); };

/* ---------- app ---------- */
export function initializeApp(cfg, nome = "[DEFAULT]") { return { nome, cfg }; }

/* ---------- auth ---------- */
const auths = {};
export function getAuth(app) {
  const nome = (app && app.nome) || "[DEFAULT]";
  if (!auths[nome]) {
    let u = null; try { u = JSON.parse(localStorage.getItem(LU + ":" + nome) || "null"); } catch (e) {}
    auths[nome] = { nome, currentUser: u, cbs: [] };
  }
  return auths[nome];
}
const avisar = (a) => a.cbs.forEach((cb) => setTimeout(() => cb(a.currentUser), 0));
export function onAuthStateChanged(a, cb) { a.cbs.push(cb); setTimeout(() => cb(a.currentUser), 20); return () => {}; }
export async function signInWithEmailAndPassword(a, email, senha) {
  await sleep(30);
  const u = (window.__FAKE_USERS || {})[email];
  if (!u || u.senha !== senha) { const e = new Error("bad"); e.code = "auth/invalid-credential"; throw e; }
  const mesmo = a.currentUser && a.currentUser.uid === u.uid;
  a.currentUser = { uid: u.uid, email }; localStorage.setItem(LU + ":" + a.nome, JSON.stringify(a.currentUser));
  if (!mesmo) avisar(a); // igual ao Firebase: mesmo usuário não dispara de novo
  return { user: a.currentUser };
}
export async function createUserWithEmailAndPassword(a, email) { const uid = "u" + Math.random().toString(36).slice(2, 10); a.currentUser = { uid, email }; return { user: a.currentUser }; }
export async function signOut(a) { a.currentUser = null; localStorage.removeItem(LU + ":" + a.nome); avisar(a); }
export async function sendPasswordResetEmail() { window.__FAKE_RESET = (window.__FAKE_RESET || 0) + 1; }

/* ---------- firestore ---------- */
export function getFirestore() { return { db: true }; }
const junta = (base, segs) => [...(base && base.path ? base.path.split("/") : []), ...segs].filter((x) => x !== undefined).join("/");
export function doc(base, ...segs) {
  if (base && base.tipo === "col" && !segs.length) segs = [Math.random().toString(36).slice(2, 12)];
  const path = junta(base, segs); return { tipo: "doc", path, id: path.split("/").pop() };
}
export function collection(base, ...segs) { const path = junta(base, segs); return { tipo: "col", path, id: path.split("/").pop() }; }
export function collectionGroup(db, id) { return { tipo: "grupo", id, path: "**/" + id }; }
export function query(ref, ...cs) { return { ...ref, cs }; }
export const where = (f, op, v) => ({ k: "where", f, op, v });
export const orderBy = (f, dir = "asc") => ({ k: "orderBy", f, dir });
export const limit = (n) => ({ k: "limit", n });
export const serverTimestamp = () => ({ __ts: Date.now() });
export const increment = (n) => ({ __inc: n });
export const Timestamp = { fromDate: (d) => ({ __ts: d.getTime() }) };
const vivo = (v) => {
  if (v && typeof v === "object") {
    if ("__ts" in v) { const t = v.__ts; return { toDate: () => new Date(t), toMillis: () => t, __ts: t }; }
    if (Array.isArray(v)) return v.map(vivo);
    const o = {}; for (const k in v) o[k] = vivo(v[k]); return o;
  }
  return v;
};
const valorCmp = (v) => (v && typeof v === "object" && "__ts" in v ? v.__ts : v);
const snapDoc = (path, data) => ({ id: path.split("/").pop(), ref: { tipo: "doc", path, id: path.split("/").pop(), parent: { parent: { id: path.split("/").slice(-3, -2)[0] } } }, exists: () => data !== undefined, data: () => (data === undefined ? undefined : vivo(data)) });
export async function getDoc(ref) {
  await atraso(ref.path); const d = lerDB();
  if (window.__FAKE_FALHA && window.__FAKE_FALHA.test(ref.path)) { const e = new Error("unavailable"); e.code = "unavailable"; throw e; }
  return snapDoc(ref.path, d[ref.path]);
}
export async function getDocs(q) {
  await atraso(q.path); const d = lerDB();
  if (window.__FAKE_FALHA && window.__FAKE_FALHA.test(q.path)) { const e = new Error("unavailable"); throw e; }
  let ps;
  if (q.tipo === "grupo") ps = Object.keys(d).filter((p) => { const s = p.split("/"); return s.length >= 2 && s[s.length - 2] === q.id; });
  else { const n = q.path.split("/").length + 1; ps = Object.keys(d).filter((p) => p.startsWith(q.path + "/") && p.split("/").length === n); }
  let docs = ps.map((p) => ({ p, v: d[p] }));
  for (const c of q.cs || []) {
    if (c.k === "where") docs = docs.filter(({ v }) => { const a = valorCmp(v[c.f]), b = valorCmp(c.v); return c.op === ">=" ? a >= b : c.op === "==" ? a === b : c.op === "<=" ? a <= b : true; });
    if (c.k === "orderBy") docs.sort((x, y) => { const a = valorCmp(x.v[c.f]), b = valorCmp(y.v[c.f]); return (a > b ? 1 : a < b ? -1 : 0) * (c.dir === "desc" ? -1 : 1); });
    if (c.k === "limit") docs = docs.slice(0, c.n);
  }
  const out = docs.map(({ p, v }) => snapDoc(p, v));
  return { docs: out, size: out.length, empty: !out.length };
}
const aplicar = (atual, data) => { const o = { ...(atual || {}) }; for (const k in data) { const v = data[k]; if (v && typeof v === "object" && "__inc" in v) o[k] = (Number(o[k]) || 0) + v.__inc; else o[k] = v; } return o; };
export async function setDoc(ref, data, opt) { await atraso(ref.path); const d = lerDB(); d[ref.path] = opt && opt.merge ? aplicar(d[ref.path], data) : aplicar({}, data); gravarDB(d); conta(ref.path); }
export async function updateDoc(ref, data) { await atraso(ref.path); const d = lerDB(); if (!d[ref.path]) { const e = new Error("not-found"); e.code = "not-found"; throw e; } d[ref.path] = aplicar(d[ref.path], data); gravarDB(d); conta(ref.path); }
export async function deleteDoc(ref) { const d = lerDB(); delete d[ref.path]; gravarDB(d); conta(ref.path); }
export function writeBatch() {
  const ops = [];
  return {
    set: (r, data, opt) => ops.push(() => setDoc(r, data, opt)),
    update: (r, data) => ops.push(() => updateDoc(r, data)),
    delete: (r) => ops.push(() => deleteDoc(r)),
    commit: async () => { for (const f of ops) await f(); },
  };
}
export async function runTransaction(db, fn) {
  const ops = [];
  const t = { get: getDoc, set: (r, data, opt) => { ops.push(() => setDoc(r, data, opt)); return t; }, update: (r, data) => { ops.push(() => updateDoc(r, data)); return t; } };
  const res = await fn(t); for (const f of ops) await f(); return res;
}
