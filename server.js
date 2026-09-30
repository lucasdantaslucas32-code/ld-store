/**
 * LD STORE — servidor (Pix manual + painel administrativo de pedidos)
 * =====================================================================
 * Arquivo único de propósito: publicar direto pelo GitHub + Render, sem
 * precisar de computador.
 *
 * O que este servidor faz:
 *  - Guarda o catálogo oficial de preços/cupons (fonte da verdade).
 *  - Cria e armazena pedidos em um banco SQLite (persistente).
 *  - Expõe a chave Pix / titular / WhatsApp configurados via variáveis
 *    de ambiente (nunca ficam escritos no HTML público).
 *  - Protege o painel de pedidos (public/admin.html) com login por
 *    senha verificado no servidor + sessão segura — a senha nunca fica
 *    no HTML/JS público.
 *  - Deixa o cliente acompanhar SOMENTE o próprio pedido (pelo ID,
 *    que é um código longo e aleatório — não existe endpoint público
 *    que liste todos os pedidos).
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const Database = require("better-sqlite3");

/* =========================================================
   1. CATÁLOGO OFICIAL — fonte da verdade para preços/cupons
   =========================================================
   O painel de configurações do site (o admin ANTIGO, dentro do próprio
   index.html) só grava no localStorage do navegador — isso não chega
   aqui. Para o valor mostrado ser sempre igual ao valor que o cliente
   deve pagar, o site busca este catálogo em GET /api/catalog. Para
   mudar preços de verdade, edite AQUI e suba no GitHub (o Render
   publica sozinho).
   ========================================================= */
const SERVICES = [
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
];

// Exemplo: { id: "cp1", code: "BEMVINDO10", percent: 10, active: true }
const COUPONS = [];

/**
 * HORÁRIO OFICIAL DA LOJA — fonte da verdade, igual para todos os
 * visitantes (antes, o horário só era salvo no navegador de quem
 * editava no painel embutido do site, então cada aparelho mostrava um
 * horário diferente). Minutos desde 00:00. Chave: 0=domingo ... 6=sábado.
 * Para mudar, edite aqui e suba no GitHub — o Render publica sozinho.
 */
const STORE_HOURS = {
  0: [14 * 60, 20 * 60], // domingo
  1: [12 * 60, 22 * 60], // segunda
  2: [12 * 60, 22 * 60], // terça
  3: [12 * 60, 22 * 60], // quarta
  4: [12 * 60, 22 * 60], // quinta
  5: [12 * 60, 22 * 60], // sexta
  6: [12 * 60, 22 * 60], // sábado
};

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function getService(id) { return SERVICES.find(s => s.id === id && s.active !== false) || null; }
function getCoupon(code) {
  if (!code) return null;
  const norm = String(code).trim().toUpperCase();
  return COUPONS.find(c => c.active && String(c.code).trim().toUpperCase() === norm) || null;
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
  const coupon = getCoupon(couponCode);
  const finalPrice = coupon ? round2(Math.max(0, unitPrice - (unitPrice * coupon.percent / 100))) : round2(unitPrice);
  return { serviceName: service.name, category: service.category, planLabel, unitPrice: round2(unitPrice),
    coupon: coupon ? { code: coupon.code, percent: coupon.percent } : null, finalPrice };
}

/* =========================================================
   2. BANCO DE DADOS (SQLite) — pedidos persistem entre reinícios
   ========================================================= */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "ldstore.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    plan_label TEXT NOT NULL,
    plan_index INTEGER,
    coupon_code TEXT,
    unit_price REAL NOT NULL,
    final_price REAL NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    internal_notes TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | review | paid | completed | cancelled
    client_ref TEXT,                          -- evita pedidos duplicados por reenvio de rede
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref ON orders (client_ref) WHERE client_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);

  CREATE TABLE IF NOT EXISTS order_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    changed_at INTEGER NOT NULL
  );
`);

const VALID_STATUSES = ["pending", "review", "paid", "completed", "cancelled"];

function insertOrder(o) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO orders (id, service_id, service_name, plan_label, plan_index, coupon_code,
      unit_price, final_price, customer_name, customer_phone, status, client_ref, created_at, updated_at)
    VALUES (@id, @serviceId, @serviceName, @planLabel, @planIndex, @couponCode, @unitPrice, @finalPrice,
      @customerName, @customerPhone, 'pending', @clientRef, @now, @now)
  `).run({ ...o, now });
  db.prepare(`INSERT INTO order_status_history (order_id, status, note, changed_at) VALUES (?, 'pending', 'Pedido criado', ?)`).run(o.id, now);
}
function getOrder(id) { return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id); }
function getOrderByClientRef(ref) { return ref ? db.prepare(`SELECT * FROM orders WHERE client_ref = ?`).get(ref) : null; }
function getHistory(orderId) { return db.prepare(`SELECT status, note, changed_at FROM order_status_history WHERE order_id = ? ORDER BY changed_at ASC`).all(orderId); }

function updateOrderStatus(id, status, note) {
  const now = Date.now();
  db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id);
  db.prepare(`INSERT INTO order_status_history (order_id, status, note, changed_at) VALUES (?, ?, ?, ?)`).run(id, status, note || null, now);
}
function updateInternalNotes(id, notes) {
  db.prepare(`UPDATE orders SET internal_notes = ?, updated_at = ? WHERE id = ?`).run(notes || "", Date.now(), id);
}

function searchOrders({ q, status, dateFrom, dateTo, limit = 200 }) {
  const clauses = [];
  const params = {};
  if (status && VALID_STATUSES.includes(status)) { clauses.push("status = @status"); params.status = status; }
  if (q && q.trim()) {
    clauses.push("(customer_name LIKE @q OR id LIKE @q OR customer_phone LIKE @q)");
    params.q = `%${q.trim()}%`;
  }
  if (dateFrom) { clauses.push("created_at >= @dateFrom"); params.dateFrom = Number(dateFrom); }
  if (dateTo) { clauses.push("created_at <= @dateTo"); params.dateTo = Number(dateTo); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT @limit`).all({ ...params, limit });
}
function orderCounts() {
  const rows = db.prepare(`SELECT status, COUNT(*) as n FROM orders GROUP BY status`).all();
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
    // ainda assim compara contra algo do mesmo tamanho, pra não vazar o comprimento por timing
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

app.set("trust proxy", 1); // necessário no Render para cookies "secure" e IP correto no rate-limit
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
    secure: isProd,        // exige HTTPS em produção (o Render já serve HTTPS)
    sameSite: "strict",    // mitiga CSRF — a sessão de admin só é enviada em navegação direta ao site
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
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

/* ---- catálogo e configuração pública (chave Pix, WhatsApp, etc.) ---- */
app.get("/api/catalog", (req, res) => res.json({ services: SERVICES, coupons: COUPONS }));

app.get("/api/public-config", (req, res) => {
  res.json({
    storeName: process.env.STORE_NAME || "LD STORE",
    pixKey: process.env.PIX_KEY || "",
    pixKeyType: process.env.PIX_KEY_TYPE || "",       // ex.: "Aleatória", "CPF", "E-mail", "Telefone"
    pixHolderName: process.env.PIX_HOLDER_NAME || "",
    whatsappNumber: process.env.WHATSAPP_NUMBER || "", // somente dígitos, com DDI+DDD
    hours: STORE_HOURS,
  });
});

/* ---- criação de pedido (cliente) ---- */
const createOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: "Muitas tentativas de criar pedido. Tente novamente em alguns minutos." },
});

function generateOrderId() { return `LD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; }

app.post("/api/orders", createOrderLimiter, (req, res) => {
  try {
    const { serviceId, planIndex, couponCode, customerName, customerPhone, clientRef } = req.body || {};

    if (!serviceId || typeof serviceId !== "string") return res.status(400).json({ error: "Produto (serviceId) é obrigatório." });
    if (!customerName || String(customerName).trim().length < 2) return res.status(400).json({ error: "Informe seu nome completo." });

    // Evita pedido duplicado se o cliente reenviar por causa de uma falha de rede.
    if (clientRef) {
      const existing = getOrderByClientRef(String(clientRef));
      if (existing) return res.status(200).json(toPublicOrder(existing));
    }

    const priced = priceOrder({
      serviceId, planIndex: planIndex === null || planIndex === undefined ? undefined : Number(planIndex), couponCode,
    });
    if (priced.finalPrice <= 0) return res.status(400).json({ error: "Valor do pedido inválido." });

    const orderId = generateOrderId();
    insertOrder({
      id: orderId, serviceId, serviceName: priced.serviceName, planLabel: priced.planLabel,
      planIndex: planIndex === null || planIndex === undefined ? null : Number(planIndex),
      couponCode: priced.coupon ? priced.coupon.code : null,
      unitPrice: priced.unitPrice, finalPrice: priced.finalPrice,
      customerName: String(customerName).trim(),
      customerPhone: customerPhone ? String(customerPhone).trim() : null,
      clientRef: clientRef ? String(clientRef) : null,
    });

    return res.status(201).json(toPublicOrder(getOrder(orderId)));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || "Erro interno ao criar pedido." });
  }
});

/* ---- consulta pública de status (o próprio ID funciona como código de acesso) ---- */
app.get("/api/orders/:id", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json(toPublicOrder(order));
});

function toPublicOrder(o) {
  return {
    orderId: o.id, status: o.status, serviceName: o.service_name, planLabel: o.plan_label,
    amount: o.final_price, customerName: o.customer_name, createdAt: o.created_at, updatedAt: o.updated_at,
  };
}

/* ---- painel administrativo (protegido) ---- */
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const { q, status, dateFrom, dateTo } = req.query;
  const rows = searchOrders({ q, status, dateFrom, dateTo });
  res.json({
    counts: orderCounts(),
    orders: rows.map(o => ({
      id: o.id, serviceName: o.service_name, planLabel: o.plan_label, amount: o.final_price,
      customerName: o.customer_name, customerPhone: o.customer_phone, status: o.status,
      createdAt: o.created_at, updatedAt: o.updated_at,
    })),
  });
});

app.get("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const o = getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json({
    id: o.id, serviceId: o.service_id, serviceName: o.service_name, planLabel: o.plan_label,
    couponCode: o.coupon_code, unitPrice: o.unit_price, amount: o.final_price,
    customerName: o.customer_name, customerPhone: o.customer_phone, internalNotes: o.internal_notes,
    status: o.status, createdAt: o.created_at, updatedAt: o.updated_at, history: getHistory(o.id),
  });
});

app.put("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const o = getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "Pedido não encontrado." });
  const { status, note, internalNotes } = req.body || {};

  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Status inválido." });
    updateOrderStatus(o.id, status, note || null);
  }
  if (internalNotes !== undefined) {
    updateInternalNotes(o.id, String(internalNotes));
  }
  const updated = getOrder(o.id);
  res.json({
    id: updated.id, status: updated.status, internalNotes: updated.internal_notes,
    history: getHistory(updated.id),
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---- frontend estático ---- */
app.use(express.static(path.join(__dirname, "public")));
// Um arquivo só serve tanto a loja quanto o painel /admin — o próprio
// site.html decide (em JavaScript, olhando location.pathname) qual dos
// dois blocos mostrar. Isso simplifica a publicação (1 arquivo de site).
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "site.html"));
});

app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  res.status(err.status || 500).json({ error: "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`LD STORE rodando na porta ${PORT}`);
  if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD não definido — o login do painel de pedidos vai recusar qualquer senha até você configurar essa variável de ambiente.");
  if (!process.env.PIX_KEY) console.warn("⚠️  PIX_KEY não definido — a tela de pagamento vai aparecer sem chave Pix até você configurar essa variável de ambiente.");
  if (!process.env.SESSION_SECRET) console.warn("⚠️  SESSION_SECRET não definido — foi gerado um valor aleatório temporário (as sessões de admin serão encerradas a cada reinício do servidor). Defina SESSION_SECRET para evitar isso.");
});
