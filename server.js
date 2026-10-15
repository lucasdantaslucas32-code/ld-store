/**
 * LD STORE — servidor (Pix manual + painel administrativo completo)
 * =====================================================================
 * Arquivo único de propósito: publicar direto pelo GitHub + Render, sem
 * precisar de computador.
 *
 * O que mudou nesta versão (correção de salvamento para todos os
 * visitantes — veja o relatório enviado junto com este arquivo):
 *  - O banco de dados agora é Postgres (externo, ex.: Neon), não mais
 *    SQLite local. O disco do Render no plano gratuito é apagado a cada
 *    reinício/novo deploy, então nada gravado nele sobrevive — por isso
 *    os pedidos somiam. Um Postgres externo resolve isso de graça.
 *  - Produtos, cupons, horários e as configurações gerais da loja agora
 *    são gravados nessa mesma base (tabela "settings"), com endpoints
 *    de admin protegidos por login — e não mais só no navegador de
 *    quem editava.
 *  - O catálogo de jogos (PS4/PS5) entra como produtos comuns, com
 *    "active: false" e preço zerado até você mesmo ativar e precificar
 *    pelo painel — nada aparece como disponível sem você confirmar.
 *
 * O que NÃO mudou: todas as rotas de pedidos, a lógica de preço, a
 * sessão de admin e o jeito de publicar (GitHub → Render) continuam os
 * mesmos de antes.
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const { Pool } = require("pg");

/* =========================================================
   1. CATÁLOGO PADRÃO — usado só para SEMEAR o banco na primeira vez
   =========================================================
   A partir do primeiro boot, quem manda de verdade é o Postgres (tabela
   "settings"), editável pelo painel /admin. Estas constantes abaixo só
   existem para popular o banco automaticamente caso ele esteja vazio
   (banco novo, ou primeira migração) — depois disso, editar aqui não
   muda mais nada em produção; use o painel /admin.
   ========================================================= */
const DEFAULT_CATEGORIES = [
  { id: "musica", label: "Música", icon: "🎵" },
  { id: "streaming", label: "Streaming", icon: "🎬" },
  { id: "produtividade", label: "IA / Produtividade", icon: "🤖" },
  { id: "jogos", label: "Jogos", icon: "🎮" },
];

const DEFAULT_SERVICES = [
  { id: "spotify", category: "musica", icon: "🎧", name: "Spotify", featured: true, active: true, type: "tiers",
    tiers: [ { label: "Mensal", price: 9.90 }, { label: "Trimestral", price: 24.90 }, { label: "Anual", price: 45.00 } ] },
  { id: "netflix", category: "streaming", icon: "🎬", name: "Netflix", featured: true, active: true, type: "tiers",
    tiers: [ { label: "Premium 4K Privado", price: 24.90 }, { label: "Premium 4K Compartilhado", price: 15.90 } ] },
  { id: "crunchyroll", category: "streaming", icon: "🍥", name: "Crunchyroll", featured: false, active: true, type: "tiers",
    tiers: [ { label: "Compartilhado", price: 15.00 }, { label: "Tela + PIN", price: 25.00 } ] },
  { id: "hbomax", category: "streaming", icon: "🎭", name: "HBO Max", featured: false, active: true, type: "single", price: 15.00 },
  { id: "primevideo", category: "streaming", icon: "📦", name: "Prime Video", featured: false, active: true, type: "single", price: 15.00 },
  { id: "paramount", category: "streaming", icon: "⛰️", name: "Paramount+", featured: false, active: true, type: "single", price: 15.00 },
  { id: "disney", category: "streaming", icon: "🏰", name: "Disney+", featured: false, active: true, type: "single", price: 15.00 },
  { id: "globoplay", category: "streaming", icon: "📺", name: "Globoplay", featured: false, active: true, type: "single", price: 13.00 },
  { id: "youtube", category: "streaming", icon: "▶️", name: "YouTube", featured: false, active: true, type: "single", price: 15.00 },
  { id: "chatgpt", category: "produtividade", icon: "🧠", name: "ChatGPT", featured: true, active: true, type: "tiers",
    tiers: [ { label: "Go", price: 20.00 }, { label: "Plus", price: 48.00 } ] },
  { id: "canva", category: "produtividade", icon: "🎨", name: "Canva Pro", featured: true, active: true, type: "single", price: 15.00 },

  /* ---- Catálogo de jogos (PS4/PS5) ----
     active:false e preço 0 de propósito: ninguém vê nem compra até você
     mesmo preencher o preço real e ativar pelo painel /admin → Produtos.
     As versões de PS4 e PS5 ficam como "planos" separados (mesmo padrão
     já usado em Spotify/Netflix), então o cliente escolhe a versão. */
  { id: "fc26", category: "jogos", icon: "🎮", name: "EA SPORTS FC 26", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "rdr2", category: "jogos", icon: "🎮", name: "Red Dead Redemption 2", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "minecraft", category: "jogos", icon: "🎮", name: "Minecraft", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "gtav", category: "jogos", icon: "🎮", name: "GTA V", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "mk11", category: "jogos", icon: "🎮", name: "Mortal Kombat 11 Ultimate", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "spiderman", category: "jogos", icon: "🎮", name: "Marvel's Spider-Man", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "gt7", category: "jogos", icon: "🎮", name: "Gran Turismo 7", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "tlou1", category: "jogos", icon: "🎮", name: "The Last of Us Part I", featured: false, active: false, type: "single", price: 0 },
  { id: "tlou2", category: "jogos", icon: "🎮", name: "The Last of Us Part II", featured: false, active: false, type: "single", price: 0 },
  { id: "gowragnarok", category: "jogos", icon: "🎮", name: "God of War Ragnarök", featured: false, active: false, type: "tiers",
    tiers: [ { label: "PS4", price: 0 }, { label: "PS5", price: 0 } ] },
  { id: "gow3remastered", category: "jogos", icon: "🎮", name: "God of War III Remastered", featured: false, active: false, type: "single", price: 0 },
  { id: "gow2018", category: "jogos", icon: "🎮", name: "God of War (2018)", featured: false, active: false, type: "single", price: 0 },
];

const DEFAULT_COUPONS = [
  { id: "cp1", code: "BEMVINDO10", percent: 10, active: true },
];

const DEFAULT_HOURS = {
  0: [9 * 60, 21 * 60],
  1: [8 * 60, 22 * 60],
  2: [8 * 60, 22 * 60],
  3: [8 * 60, 22 * 60],
  4: [8 * 60, 22 * 60],
  5: [8 * 60, 22 * 60],
  6: [8 * 60 + 30, 21 * 60 + 30],
};

const DEFAULT_STORE = {
  storeName: "LD STORE",
  logoEmoji: "👑",
  slogan: "Seu entretenimento, do seu jeito.",
  tagline: "Serviços digitais de forma simples, rápida e prática.",
  instagramUrl: "",
};

const DEFAULT_NOTICES = [
  { id: "n1", text: "🔥 Promoção: assine o Spotify anual e economize.", type: "promo", active: true },
];

const DEFAULT_MESSAGES = {
  greetingOnline: "Olá! Vim pelo site da {store} e gostaria de saber mais sobre os serviços.",
  greetingOffline: "Olá! Vim pelo site da {store}. Sei que o atendimento está encerrado no momento, mas gostaria de deixar minha mensagem sobre {service}.",
  existingCustomer: "Olá! Já sou cliente da {store} e preciso de suporte.",
  orderFinal: "Olá! Fiz um pedido na {store}.\n\n🆔 Pedido: {id}\n📦 Produto: {service}\n📋 Plano: {plan}\n💰 Valor: {price}\n💳 Pagamento: Pix\n\nJá realizei o pagamento e aguardo a confirmação.",
};

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/* =========================================================
   2. BANCO DE DADOS (Postgres externo — ex.: Neon, grátis e permanente)
   =========================================================
   Precisa da variável de ambiente DATABASE_URL (string de conexão do
   Postgres). Sem ela, o servidor recusa subir — veja o README para
   como criar uma base grátis no Neon e configurar isso no Render.
   ========================================================= */
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL não configurado. Crie um Postgres grátis (ex.: neon.tech) e defina essa variável de ambiente no Render. O servidor não pode persistir dados sem isso.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const VALID_STATUSES = ["pending", "review", "paid", "completed", "cancelled"];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      plan_label TEXT NOT NULL,
      plan_index INTEGER,
      coupon_code TEXT,
      unit_price NUMERIC NOT NULL,
      final_price NUMERIC NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      internal_notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      client_ref TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref ON orders (client_ref) WHERE client_ref IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_status_history (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      changed_at BIGINT NOT NULL
    );
  `);

  // Configurações compartilhadas (produtos, cupons, horários, dados gerais
  // da loja, avisos, mensagens). Uma linha por "seção", valor em JSONB.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  // Semeia o banco só se ainda não existir aquela chave (não sobrescreve
  // nada que já exista — importante para não apagar edições já feitas).
  const seeds = {
    categories: DEFAULT_CATEGORIES,
    services: DEFAULT_SERVICES,
    coupons: DEFAULT_COUPONS,
    hours: DEFAULT_HOURS,
    store: DEFAULT_STORE,
    notices: DEFAULT_NOTICES,
    messages: DEFAULT_MESSAGES,
  };
  for (const [key, value] of Object.entries(seeds)) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value), Date.now()]
    );
  }
}

/* ---- cache em memória das configurações (evita ler o banco a cada
   visita; é atualizado sempre que o admin salva algo) ---- */
let SETTINGS_CACHE = {
  categories: DEFAULT_CATEGORIES, services: DEFAULT_SERVICES, coupons: DEFAULT_COUPONS,
  hours: DEFAULT_HOURS, store: DEFAULT_STORE, notices: DEFAULT_NOTICES, messages: DEFAULT_MESSAGES,
};

async function loadSettingsCache() {
  const { rows } = await pool.query(`SELECT key, value FROM settings`);
  const next = { ...SETTINGS_CACHE };
  for (const row of rows) next[row.key] = row.value;
  SETTINGS_CACHE = next;
}

async function saveSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  );
  SETTINGS_CACHE = { ...SETTINGS_CACHE, [key]: value };
}

function getService(id) {
  return (SETTINGS_CACHE.services || []).find(s => s.id === id && s.active !== false) || null;
}
function getCoupon(code) {
  if (!code) return null;
  const norm = String(code).trim().toUpperCase();
  return (SETTINGS_CACHE.coupons || []).find(c => c.active && String(c.code).trim().toUpperCase() === norm) || null;
}
function priceOrder({ serviceId, planIndex, couponCode }) {
  const service = getService(serviceId);
  if (!service) { const e = new Error("Produto inválido ou indisponível."); e.status = 400; throw e; }
  let planLabel, unitPrice;
  if (service.type === "single") {
    planLabel = "Acesso individual"; unitPrice = service.price;
  } else {
    const tier = service.tiers[planIndex];
    if (!tier) { const e = new Error("Plano inválido para este produto."); e.status = 400; throw e; }
    planLabel = tier.label; unitPrice = tier.price;
  }
  if (!(typeof unitPrice === "number" && unitPrice > 0)) {
    const e = new Error("Este produto ainda não está disponível para compra."); e.status = 400; throw e;
  }
  const coupon = getCoupon(couponCode);
  const finalPrice = coupon ? round2(Math.max(0, unitPrice - (unitPrice * coupon.percent / 100))) : round2(unitPrice);
  return { serviceName: service.name, category: service.category, planLabel, unitPrice: round2(unitPrice),
    coupon: coupon ? { code: coupon.code, percent: coupon.percent } : null, finalPrice };
}

async function insertOrder(o) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO orders (id, service_id, service_name, plan_label, plan_index, coupon_code,
        unit_price, final_price, customer_name, customer_phone, status, client_ref, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$12)`,
    [o.id, o.serviceId, o.serviceName, o.planLabel, o.planIndex, o.couponCode,
      o.unitPrice, o.finalPrice, o.customerName, o.customerPhone, o.clientRef, now]
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, note, changed_at) VALUES ($1,'pending','Pedido criado',$2)`,
    [o.id, now]
  );
}
async function getOrder(id) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function getOrderByClientRef(ref) {
  if (!ref) return null;
  const { rows } = await pool.query(`SELECT * FROM orders WHERE client_ref = $1`, [ref]);
  return rows[0] || null;
}
async function getHistory(orderId) {
  const { rows } = await pool.query(
    `SELECT status, note, changed_at FROM order_status_history WHERE order_id = $1 ORDER BY changed_at ASC`,
    [orderId]
  );
  return rows;
}
async function updateOrderStatus(id, status, note) {
  const now = Date.now();
  await pool.query(`UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3`, [status, now, id]);
  await pool.query(
    `INSERT INTO order_status_history (order_id, status, note, changed_at) VALUES ($1,$2,$3,$4)`,
    [id, status, note || null, now]
  );
}
async function updateInternalNotes(id, notes) {
  await pool.query(`UPDATE orders SET internal_notes = $1, updated_at = $2 WHERE id = $3`, [notes || "", Date.now(), id]);
}

async function searchOrders({ q, status, dateFrom, dateTo, limit = 200 }) {
  const clauses = [];
  const params = [];
  let i = 1;
  if (status && VALID_STATUSES.includes(status)) { clauses.push(`status = $${i++}`); params.push(status); }
  if (q && q.trim()) {
    clauses.push(`(customer_name ILIKE $${i} OR id ILIKE $${i} OR customer_phone ILIKE $${i})`);
    params.push(`%${q.trim()}%`); i++;
  }
  if (dateFrom) { clauses.push(`created_at >= $${i++}`); params.push(Number(dateFrom)); }
  if (dateTo) { clauses.push(`created_at <= $${i++}`); params.push(Number(dateTo)); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const { rows } = await pool.query(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${i}`, params);
  return rows;
}
async function orderCounts() {
  const { rows } = await pool.query(`SELECT status, COUNT(*)::int as n FROM orders GROUP BY status`);
  const out = { pending: 0, review: 0, paid: 0, completed: 0, cancelled: 0, total: 0 };
  for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
  return out;
}

/* =========================================================
   3. AUTENTICAÇÃO DO ADMIN (server-side, sessão segura)
   ========================================================= */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Não autenticado." });
}

/* =========================================================
   4. SERVIDOR EXPRESS
   ========================================================= */
const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(isProd ? "combined" : "dev"));
app.use(cors(process.env.FRONTEND_ORIGIN ? { origin: process.env.FRONTEND_ORIGIN, credentials: true } : { credentials: true }));
app.use(express.json());

app.use(session({
  name: "ldstore.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

/* ---- login/logout do admin ---- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente de novo." },
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD não configurado no servidor. Defina essa variável de ambiente para ativar o login." });
  }
  const { password } = req.body || {};
  if (!password || !constantTimeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Senha incorreta." });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get("/api/admin/me", (req, res) => res.json({ authenticated: !!(req.session && req.session.isAdmin) }));

/* ---- catálogo e configurações públicas (iguais para qualquer visitante) ---- */
app.get("/api/catalog", (req, res) => {
  res.json({ services: SETTINGS_CACHE.services, coupons: SETTINGS_CACHE.coupons, categories: SETTINGS_CACHE.categories });
});

app.get("/api/public-settings", (req, res) => {
  res.json({
    store: SETTINGS_CACHE.store,
    notices: SETTINGS_CACHE.notices,
    messages: SETTINGS_CACHE.messages,
    hours: SETTINGS_CACHE.hours,
    categories: SETTINGS_CACHE.categories,
  });
});

app.get("/api/public-config", (req, res) => {
  res.json({
    storeName: (SETTINGS_CACHE.store && SETTINGS_CACHE.store.storeName) || process.env.STORE_NAME || "LD STORE",
    pixKey: process.env.PIX_KEY || "",
    pixKeyType: process.env.PIX_KEY_TYPE || "",
    pixHolderName: process.env.PIX_HOLDER_NAME || "",
    whatsappNumber: process.env.WHATSAPP_NUMBER || "",
    hours: SETTINGS_CACHE.hours,
  });
});

/* ---- CRUD de configurações (protegido) ----
   Um endpoint só, que aceita qualquer subconjunto de chaves e grava
   cada uma na tabela settings. Isso atualiza o cache na hora — a
   próxima visita de QUALQUER pessoa já vê a mudança. */
const EDITABLE_SETTINGS = ["categories", "services", "coupons", "hours", "store", "notices", "messages"];

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({
    categories: SETTINGS_CACHE.categories, services: SETTINGS_CACHE.services, coupons: SETTINGS_CACHE.coupons,
    hours: SETTINGS_CACHE.hours, store: SETTINGS_CACHE.store, notices: SETTINGS_CACHE.notices, messages: SETTINGS_CACHE.messages,
  });
});

app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const keys = Object.keys(body).filter(k => EDITABLE_SETTINGS.includes(k));
    if (!keys.length) return res.status(400).json({ error: "Nada para salvar — envie ao menos uma seção válida." });

    if (body.services !== undefined) {
      if (!Array.isArray(body.services)) return res.status(400).json({ error: "services precisa ser uma lista." });
      for (const s of body.services) {
        if (!s.id || !s.name || !s.category) return res.status(400).json({ error: "Cada produto precisa de id, name e category." });
        if (s.type === "tiers" && !Array.isArray(s.tiers)) return res.status(400).json({ error: `Produto "${s.id}" é do tipo tiers mas não tem tiers.` });
      }
    }
    if (body.coupons !== undefined) {
      if (!Array.isArray(body.coupons)) return res.status(400).json({ error: "coupons precisa ser uma lista." });
      for (const c of body.coupons) {
        if (!c.code || typeof c.percent !== "number" || c.percent <= 0 || c.percent > 95) {
          return res.status(400).json({ error: `Cupom inválido: ${c.code || "(sem código)"}` });
        }
      }
    }
    if (body.hours !== undefined) {
      for (const d of [0, 1, 2, 3, 4, 5, 6]) {
        const v = body.hours[d];
        if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number") {
          return res.status(400).json({ error: "Horário inválido — cada dia precisa de [abre, fecha] em minutos." });
        }
      }
    }

    for (const key of keys) await saveSetting(key, body[key]);
    res.json({ ok: true, saved: keys });
  } catch (err) {
    console.error("Erro ao salvar configurações:", err);
    res.status(500).json({ error: "Erro interno ao salvar configurações." });
  }
});

/* ---- criação de pedido (cliente) ---- */
const createOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: "Muitas tentativas de criar pedido. Tente novamente em alguns minutos." },
});

function generateOrderId() { return `LD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; }

app.post("/api/orders", createOrderLimiter, async (req, res) => {
  try {
    const { serviceId, planIndex, couponCode, customerName, customerPhone, clientRef } = req.body || {};

    if (!serviceId || typeof serviceId !== "string") return res.status(400).json({ error: "Produto (serviceId) é obrigatório." });
    if (!customerName || String(customerName).trim().length < 2) return res.status(400).json({ error: "Informe seu nome completo." });

    if (clientRef) {
      const existing = await getOrderByClientRef(String(clientRef));
      if (existing) return res.status(200).json(toPublicOrder(existing));
    }

    const priced = priceOrder({
      serviceId, planIndex: planIndex === null || planIndex === undefined ? undefined : Number(planIndex), couponCode,
    });
    if (priced.finalPrice <= 0) return res.status(400).json({ error: "Valor do pedido inválido." });

    const orderId = generateOrderId();
    await insertOrder({
      id: orderId, serviceId, serviceName: priced.serviceName, planLabel: priced.planLabel,
      planIndex: planIndex === null || planIndex === undefined ? null : Number(planIndex),
      couponCode: priced.coupon ? priced.coupon.code : null,
      unitPrice: priced.unitPrice, finalPrice: priced.finalPrice,
      customerName: String(customerName).trim(),
      customerPhone: customerPhone ? String(customerPhone).trim() : null,
      clientRef: clientRef ? String(clientRef) : null,
    });

    return res.status(201).json(toPublicOrder(await getOrder(orderId)));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || "Erro interno ao criar pedido." });
  }
});

/* ---- consulta pública de status (o próprio ID funciona como código de acesso) ---- */
app.get("/api/orders/:id", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json(toPublicOrder(order));
});

function toPublicOrder(o) {
  return {
    orderId: o.id, status: o.status, serviceName: o.service_name, planLabel: o.plan_label,
    amount: Number(o.final_price), customerName: o.customer_name, createdAt: Number(o.created_at), updatedAt: Number(o.updated_at),
  };
}

/* ---- painel administrativo de pedidos (protegido) ---- */
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const { q, status, dateFrom, dateTo } = req.query;
    const rows = await searchOrders({ q, status, dateFrom, dateTo });
    res.json({
      counts: await orderCounts(),
      orders: rows.map(o => ({
        id: o.id, serviceName: o.service_name, planLabel: o.plan_label, amount: Number(o.final_price),
        customerName: o.customer_name, customerPhone: o.customer_phone, status: o.status,
        createdAt: Number(o.created_at), updatedAt: Number(o.updated_at),
      })),
    });
  } catch (err) {
    console.error("Erro ao listar pedidos:", err);
    res.status(500).json({ error: "Erro interno ao listar pedidos." });
  }
});

app.get("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json({
    id: o.id, serviceId: o.service_id, serviceName: o.service_name, planLabel: o.plan_label,
    couponCode: o.coupon_code, unitPrice: Number(o.unit_price), amount: Number(o.final_price),
    customerName: o.customer_name, customerPhone: o.customer_phone, internalNotes: o.internal_notes,
    status: o.status, createdAt: Number(o.created_at), updatedAt: Number(o.updated_at),
    history: (await getHistory(o.id)).map(h => ({ ...h, changed_at: Number(h.changed_at) })),
  });
});

app.put("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "Pedido não encontrado." });
  const { status, note, internalNotes } = req.body || {};

  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Status inválido." });
    await updateOrderStatus(o.id, status, note || null);
  }
  if (internalNotes !== undefined) {
    await updateInternalNotes(o.id, String(internalNotes));
  }
  const updated = await getOrder(o.id);
  res.json({
    id: updated.id, status: updated.status, internalNotes: updated.internal_notes,
    history: (await getHistory(updated.id)).map(h => ({ ...h, changed_at: Number(h.changed_at) })),
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected", time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, db: "error", error: err.message });
  }
});

/* ---- frontend estático ---- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "site.html"));
});

app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  res.status(err.status || 500).json({ error: "Erro interno do servidor." });
});

/* =========================================================
   5. INICIALIZAÇÃO
   ========================================================= */
(async function start() {
  try {
    if (process.env.DATABASE_URL) {
      await initDb();
      await loadSettingsCache();
      console.log("✅ Banco de dados conectado e configurações carregadas.");
    } else {
      console.warn("⚠️  Rodando SEM banco de dados — usando apenas os valores padrão em memória (nada será salvo). Configure DATABASE_URL.");
    }
  } catch (err) {
    console.error("❌ Falha ao conectar/preparar o banco de dados:", err.message);
    console.error("   O servidor vai subir mesmo assim, mas pedidos e configurações NÃO vão funcionar até isso ser corrigido.");
  }

  app.listen(PORT, () => {
    console.log(`LD STORE rodando na porta ${PORT}`);
    if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD não definido — o login do painel vai recusar qualquer senha até você configurar essa variável de ambiente.");
    if (!process.env.PIX_KEY) console.warn("⚠️  PIX_KEY não definido — a tela de pagamento vai aparecer sem chave Pix até você configurar essa variável de ambiente.");
    if (!process.env.SESSION_SECRET) console.warn("⚠️  SESSION_SECRET não definido — foi gerado um valor aleatório temporário (as sessões de admin serão encerradas a cada reinício do servidor). Defina SESSION_SECRET para evitar isso.");
    if (!process.env.DATABASE_URL) console.warn("⚠️  DATABASE_URL não definido — veja o README para criar um Postgres grátis (Neon) e configurar isso.");
  });
})();
