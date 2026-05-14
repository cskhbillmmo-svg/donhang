const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = __dirname;
const dbPath = path.join(root, "accounts.db.json");
const ordersPath = path.join(root, "orders.db.json");
const txPath = path.join(root, "transactions.db.json");
const configPath = path.join(root, "config.db.json");
const productsPath = path.join(root, "products.db.json");
const auditPath = path.join(root, "audit.db.json");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT) || 8000;
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const INITIAL_BALANCE = 30000;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://anqjrhololyuulghrbap.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_j4lN7sNReirmd2U2LD7njw_I4ZwAb9G";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "app_store";
const USE_SUPABASE = (process.env.USE_SUPABASE || "1") !== "0";

const localStores = new Map();
const pendingSupabaseWrites = new Map();

const DEFAULT_VIP_LEVELS = {
  VIP1: { rate: 0.005, refRate: 0.15, dailyCap: 30, minRange: 0, maxRange: 10000000 },
  VIP2: { rate: 0.008, refRate: 0.18, dailyCap: 50, minRange: 0, maxRange: 30000000 },
  VIP3: { rate: 0.012, refRate: 0.22, dailyCap: 80, minRange: 0, maxRange: 50000000 },
  VIP4: { rate: 0.015, refRate: 0.25, dailyCap: 100, minRange: 0, maxRange: 100000000 },
};

const STORE_FILES = {
  config: configPath,
  accounts: dbPath,
  orders: ordersPath,
  transactions: txPath,
  products: productsPath,
  audit: auditPath,
};

const STORE_DEFAULTS = {
  config: () => {
    const { hash, salt } = hashPassword(INITIAL_ADMIN_PASSWORD);
    return {
      vipLevels: DEFAULT_VIP_LEVELS,
      adminPasswordHash: hash,
      adminPasswordSalt: salt,
    };
  },
  accounts: () => ({ accounts: [] }),
  orders: () => ({ orders: [] }),
  transactions: () => ({ txs: [] }),
  products: () => ({ products: [] }),
  audit: () => ({ logs: [] }),
};

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function localReadStore(key) {
  const filePath = STORE_FILES[key];
  if (filePath && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return STORE_DEFAULTS[key]();
}

function localWriteStore(key, value) {
  const filePath = STORE_FILES[key];
  if (filePath) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch (error) {
      if (!process.env.VERCEL) {
        throw error;
      }
    }
  }
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body && (body.message || body.error) ? (body.message || body.error) : response.statusText;
    throw new Error(message);
  }
  return body;
}

async function loadStoreFromSupabase(key) {
  const rows = await supabaseRequest(`/rest/v1/${SUPABASE_TABLE}?key=eq.${encodeURIComponent(key)}&select=data`);
  if (Array.isArray(rows) && rows[0] && rows[0].data) {
    return rows[0].data;
  }
  const initial = localReadStore(key);
  await saveStoreToSupabase(key, initial);
  return initial;
}

async function saveStoreToSupabase(key, value) {
  await supabaseRequest(`/rest/v1/${SUPABASE_TABLE}?on_conflict=key`, {
    method: "POST",
    body: JSON.stringify({
      key,
      data: value,
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: "resolution=merge-duplicates" },
  });
}

function readStore(key) {
  if (!localStores.has(key)) {
    const value = localReadStore(key);
    localStores.set(key, value);
  }
  return cloneData(localStores.get(key));
}

function writeStore(key, value) {
  localStores.set(key, cloneData(value));
  localWriteStore(key, value);
  if (USE_SUPABASE) {
    const prev = pendingSupabaseWrites.get(key);
    const start = prev ? prev.catch(() => {}) : Promise.resolve();
    const p = start.then(() => saveStoreToSupabase(key, value)).catch((error) => {
      console.error(`[supabase] save ${key} failed: ${error.message}`);
    }).finally(() => {
      if (pendingSupabaseWrites.get(key) === p) {
        pendingSupabaseWrites.delete(key);
      }
    });
    pendingSupabaseWrites.set(key, p);
    return p;
  }
  return Promise.resolve();
}

async function refreshStoreFromSupabase(key) {
  if (!USE_SUPABASE) return;
  try {
    const pending = pendingSupabaseWrites.get(key);
    if (pending) await pending;
    const value = await loadStoreFromSupabase(key);
    localStores.set(key, value);
  } catch (error) {
    console.error(`[supabase] refresh ${key} failed: ${error.message}`);
  }
}

async function flushPendingWrites(keys) {
  if (!USE_SUPABASE) return;
  const list = keys ? (Array.isArray(keys) ? keys : [keys]) : Array.from(pendingSupabaseWrites.keys());
  await Promise.all(list.map((k) => pendingSupabaseWrites.get(k)).filter(Boolean));
}

async function initStorage() {
  for (const key of Object.keys(STORE_FILES)) {
    const value = USE_SUPABASE ? await loadStoreFromSupabase(key) : localReadStore(key);
    localStores.set(key, value);
    localWriteStore(key, value);
  }
}

function ensureConfig() {
  if (!localStores.has("config")) localStores.set("config", localReadStore("config"));
}

function readConfig() {
  ensureConfig();
  return readStore("config");
}

function writeConfig(c) {
  writeStore("config", c);
}

function getVipLevels() {
  return readConfig().vipLevels || DEFAULT_VIP_LEVELS;
}

function getVipInfo(level) {
  const all = getVipLevels();
  return { level, ...(all[level] || all.VIP1 || DEFAULT_VIP_LEVELS.VIP1) };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function ensureDb() {
  if (!localStores.has("accounts")) localStores.set("accounts", localReadStore("accounts"));
}

function ensureOrders() {
  if (!localStores.has("orders")) localStores.set("orders", localReadStore("orders"));
}

function ensureTx() {
  if (!localStores.has("transactions")) localStores.set("transactions", localReadStore("transactions"));
}

function readTx() {
  ensureTx();
  return readStore("transactions");
}

function writeTx(db) {
  writeStore("transactions", db);
}

// VIP rank for unlock comparison
const VIP_RANK = { VIP1: 1, VIP2: 2, VIP3: 3, VIP4: 4 };

// Compute balance for a user from approved deposits + commission + adjustments + referral, minus approved + pending withdrawals.
// Referral bonuses are locked (frozen) until referrer reaches lockedUntilVip level.
function computeBalance(username) {
  const t = readTx();
  const o = readOrders();
  const accountDb = readDb();
  const account = accountDb.accounts.find((a) => a.username === username);
  const userVipRank = VIP_RANK[(account && account.vipLevel) || "VIP1"] || 1;
  let total = INITIAL_BALANCE;
  let frozen = 0;
  let referralLocked = 0;
  for (const tx of t.txs) {
    if (tx.username !== username) continue;
    if (tx.type === "deposit" && tx.status === "approved") total += tx.amount;
    if (tx.type === "withdraw" && tx.status === "approved") total -= tx.amount;
    if (tx.type === "withdraw" && tx.status === "pending") frozen += tx.amount;
    if (tx.type === "adjustment" && tx.status === "approved") total += tx.amount; // amount may be negative
    if (tx.type === "referral-bonus" && tx.status === "approved") {
      total += tx.amount;
      const requiredRank = VIP_RANK[tx.lockedUntilVip || "VIP2"] || 2;
      if (userVipRank < requiredRank) {
        referralLocked += tx.amount;
      }
    }
  }
  // Approved orders: add both order value + commission into total, all of it is frozen
  let taskFrozen = 0;
  for (const ord of o.orders) {
    if (ord.claimedBy === username && ord.status === "approved") {
      const amt = Number(ord.amount || 0);
      const com = Number(ord.commission || 0);
      total += amt + com;
      taskFrozen += amt + com;
    }
  }
  const totalFrozen = frozen + referralLocked + taskFrozen;
  const available = Math.max(0, total - totalFrozen);
  return { total, available, frozen: totalFrozen, referralLocked, withdrawFrozen: frozen, taskFrozen };
}

function readDb() {
  ensureDb();
  return readStore("accounts");
}

function writeDb(db) {
  writeStore("accounts", db);
}

function readOrders() {
  ensureOrders();
  return readStore("orders");
}

function writeOrders(db) {
  writeStore("orders", db);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 160000, 32, "sha256").toString("hex");
  return { hash, salt };
}

function verifyPassword(password, account) {
  const candidate = hashPassword(password, account.salt).hash;
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(account.passwordHash, "hex"));
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    // Vercel @vercel/node pre-parses JSON body into request.body
    if (request.body && typeof request.body === "object") {
      resolve(request.body);
      return;
    }
    if (typeof request.body === "string") {
      try { resolve(request.body ? JSON.parse(request.body) : {}); }
      catch (e) { reject(e); }
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) {
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function checkAdmin(data) {
  const provided = String(data.adminPassword || "");
  if (!provided) return false;
  const c = readConfig();
  if (!c.adminPasswordHash || !c.adminPasswordSalt) return provided === INITIAL_ADMIN_PASSWORD;
  const candidate = hashPassword(provided, c.adminPasswordSalt).hash;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(c.adminPasswordHash, "hex"));
  } catch (e) { return false; }
}

function ensureProducts() {
  if (!localStores.has("products")) localStores.set("products", localReadStore("products"));
}
function readProducts() {
  ensureProducts();
  return readStore("products");
}
function writeProducts(p) {
  writeStore("products", p);
}

function ensureAudit() {
  if (!localStores.has("audit")) localStores.set("audit", localReadStore("audit"));
}
function readAudit() {
  ensureAudit();
  return readStore("audit");
}
function writeAudit(a) {
  writeStore("audit", a);
}

function audit(action, target, details) {
  try {
    const a = readAudit();
    a.logs.unshift({
      id: "AL-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      action,
      target: target || null,
      details: details || null,
    });
    if (a.logs.length > 500) a.logs.length = 500; // keep last 500
    writeAudit(a);
  } catch (e) {}
}

const REFERRAL_BONUS = 100000; // 100k VND auto-credit to referrer
const REFERRAL_UNLOCK_VIP = "VIP2"; // referrer must reach this VIP to withdraw bonus

function generateReferralCode(seed) {
  // Deterministic 6-digit code derived from account id (or random if seed empty)
  if (seed) {
    const hex = crypto.createHash("sha256").update(seed).digest("hex");
    const num = parseInt(hex.slice(0, 8), 16) % 900000 + 100000; // 100000..999999
    return String(num);
  }
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function handleRegister(request, response) {
  try {
    const data = await readJson(request);
    const fullName = String(data.fullName || "").trim();
    const phone = String(data.phone || "").trim();
    const username = String(data.username || "").trim().toLowerCase();
    const password = String(data.password || "");
    const referralCodeRaw = String(data.referralCode || "").trim();

    if (!fullName || !phone || !username || !password) {
      sendJson(response, 400, { ok: false, message: "Vui lòng nhập đủ thông tin." });
      return;
    }

    if (password.length < 6) {
      sendJson(response, 400, { ok: false, message: "Mật khẩu cần tối thiểu 6 ký tự." });
      return;
    }

    const db = readDb();
    if (db.accounts.some((account) => account.username === username)) {
      sendJson(response, 409, { ok: false, message: "Tên đăng nhập đã tồn tại." });
      return;
    }

    // Validate referral code (if provided)
    let referrer = null;
    if (referralCodeRaw) {
      // Look up by referralCode field; if any old account doesn't have one, derive from id
      referrer = db.accounts.find((a) => {
        const code = a.referralCode || generateReferralCode(a.id);
        return code === referralCodeRaw;
      });
      if (!referrer) {
        sendJson(response, 400, { ok: false, message: `Mã giới thiệu "${referralCodeRaw}" không tồn tại.` });
        return;
      }
      // backfill referralCode if missing
      if (!referrer.referralCode) referrer.referralCode = generateReferralCode(referrer.id);
    }

    const { hash, salt } = hashPassword(password);
    const id = crypto.randomUUID();
    const newAccount = {
      id,
      fullName,
      phone,
      username,
      passwordHash: hash,
      salt,
      vipLevel: "VIP1",
      blocked: false,
      referralCode: generateReferralCode(id),
      referredBy: referrer ? referrer.username : null,
      createdAt: new Date().toISOString(),
    };
    db.accounts.push(newAccount);
    writeDb(db);

    // Credit referral bonus to referrer (locked until they reach VIP2)
    if (referrer) {
      const t = readTx();
      t.txs.unshift({
        id: "TX-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        type: "referral-bonus",
        username: referrer.username,
        amount: REFERRAL_BONUS,
        paymentMethod: null,
        bankInfo: null,
        reason: `Hoa hồng giới thiệu @${username}`,
        referredUser: username,
        lockedUntilVip: REFERRAL_UNLOCK_VIP,
        status: "approved",
        rejectedReason: null,
        createdAt: Date.now(),
        approvedAt: Date.now(),
        rejectedAt: null,
        approvedBy: "system",
      });
      writeTx(t);
      audit("referral-bonus", referrer.username, { from: username, amount: REFERRAL_BONUS });
    }

    sendJson(response, 201, {
      ok: true,
      message: "Đăng ký tài khoản thành công.",
      referrer: referrer ? referrer.username : null,
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, message: "Dữ liệu gửi lên không hợp lệ." });
  }
}

async function handleLogin(request, response) {
  try {
    const data = await readJson(request);
    const username = String(data.username || "").trim().toLowerCase();
    const password = String(data.password || "");
    const db = readDb();
    const account = db.accounts.find((item) => item.username === username);

    if (!account || !verifyPassword(password, account)) {
      sendJson(response, 401, { ok: false, message: "Sai tài khoản hoặc mật khẩu." });
      return;
    }

    if (account.blocked) {
      sendJson(response, 403, { ok: false, message: "Tài khoản đã bị khóa. Liên hệ CSKH để được hỗ trợ." });
      return;
    }

    // Backfill referralCode if missing on legacy accounts
    if (!account.referralCode) {
      account.referralCode = generateReferralCode(account.id);
      const dbAll = readDb();
      const idx = dbAll.accounts.findIndex((a) => a.id === account.id);
      if (idx !== -1) { dbAll.accounts[idx].referralCode = account.referralCode; writeDb(dbAll); }
    }

    sendJson(response, 200, {
      ok: true,
      message: "Đăng nhập thành công.",
      account: {
        id: account.id,
        fullName: account.fullName,
        username: account.username,
        phone: account.phone,
        vipLevel: account.vipLevel || "VIP1",
        vip: getVipInfo(account.vipLevel || "VIP1"),
        referralCode: account.referralCode,
        referredBy: account.referredBy || null,
      },
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, message: "Dữ liệu gửi lên không hợp lệ." });
  }
}

// ============== ORDERS API ==============

// Admin: create a new available order (optionally pre-assigned to a user)
async function handleAdminCreateOrder(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    const productTitle = String(data.productTitle || "").trim();
    const productImg = String(data.productImg || "").trim();
    const amount = Number(data.amount || 0);
    const assignedTo = String(data.assignedTo || "").trim().toLowerCase() || null;
    if (!productTitle || amount <= 0) {
      sendJson(response, 400, { ok: false, message: "Cần nhập tên sản phẩm và số tiền > 0." });
      return;
    }
    const fixedCommission = Number(data.commission || 0);
    let commissionRate;
    let commission;
    if (fixedCommission > 0) {
      commission = Math.round(fixedCommission);
      commissionRate = amount > 0 ? commission / amount : 0;
    } else {
      commissionRate = Number(data.commissionRate || 0.005);
      commission = Math.round(amount * commissionRate);
    }
    await Promise.all([
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("accounts"),
    ]);
    // Validate assignedTo exists if provided
    if (assignedTo) {
      const accountDb = readDb();
      if (!accountDb.accounts.some((a) => a.username === assignedTo)) {
        sendJson(response, 400, { ok: false, message: `Không tìm thấy user "${assignedTo}".` });
        return;
      }
    }
    const db = readOrders();
    const order = {
      id: "ORD-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      status: "available",
      productTitle,
      productImg,
      amount,
      commissionRate,
      commission,
      assignedTo,
      claimedBy: null,
      claimedAt: null,
      approvedAt: null,
      rejectedAt: null,
      rejectedReason: null,
      createdAt: Date.now(),
    };
    db.orders.unshift(order);
    writeOrders(db);
    audit("order-create", order.id, { productTitle, amount, assignedTo });
    sendJson(response, 201, { ok: true, message: "Đã tạo đơn.", order });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Dữ liệu không hợp lệ." });
  }
}

// Admin: assign an existing available order to a specific user
async function handleAdminAssignOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    const assignedTo = String(data.assignedTo || "").trim().toLowerCase();
    if (!assignedTo) {
      sendJson(response, 400, { ok: false, message: "Cần chọn user để gán." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("accounts"),
    ]);
    const accountDb = readDb();
    if (!accountDb.accounts.some((a) => a.username === assignedTo)) {
      sendJson(response, 400, { ok: false, message: `Không tìm thấy user "${assignedTo}".` });
      return;
    }
    const db = readOrders();
    const idx = db.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy đơn." });
      return;
    }
    if (db.orders[idx].status !== "available") {
      sendJson(response, 400, { ok: false, message: "Chỉ gán được đơn ở trạng thái available." });
      return;
    }
    db.orders[idx].assignedTo = assignedTo;
    writeOrders(db);
    audit("order-assign", orderId, { assignedTo });
    sendJson(response, 200, { ok: true, message: `Đã gán đơn cho ${assignedTo}.`, order: db.orders[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: unassign (remove assignedTo) — make order open to anyone
async function handleAdminUnassignOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    const idx = db.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy đơn." });
      return;
    }
    db.orders[idx].assignedTo = null;
    writeOrders(db);
    audit("order-unassign", orderId);
    sendJson(response, 200, { ok: true, message: "Đã bỏ gán.", order: db.orders[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: adjust user balance (positive = +, negative = -)
async function handleAdminAdjustBalance(request, response, username) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("transactions"),
      refreshStoreFromSupabase("orders"),
    ]);
    const accountDb = readDb();
    if (!accountDb.accounts.some((a) => a.username === username)) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    const amount = Math.round(Number(data.amount || 0));
    const reason = String(data.reason || "").trim() || (amount >= 0 ? "Admin cộng tiền" : "Admin trừ tiền");
    if (!Number.isFinite(amount) || amount === 0) {
      sendJson(response, 400, { ok: false, message: "Số tiền điều chỉnh không hợp lệ." });
      return;
    }
    // If subtracting, check available balance (not total) so không trừ vào phần đóng băng.
    if (amount < 0) {
      const bal = computeBalance(username);
      if (Math.abs(amount) > bal.available) {
        sendJson(response, 400, { ok: false, message: `Không thể trừ ${Math.abs(amount).toLocaleString("vi-VN")} ₫ — số dư khả dụng chỉ ${bal.available.toLocaleString("vi-VN")} ₫.` });
        return;
      }
    }
    const t = readTx();
    const tx = {
      id: "TX-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      type: "adjustment",
      username,
      amount, // may be negative
      paymentMethod: null,
      bankInfo: null,
      reason,
      status: "approved",
      rejectedReason: null,
      createdAt: Date.now(),
      approvedAt: Date.now(),
      rejectedAt: null,
      approvedBy: "admin",
    };
    t.txs.unshift(tx);
    writeTx(t);
    const newBal = computeBalance(username);
    audit(amount >= 0 ? "user-add-balance" : "user-sub-balance", username, { amount, reason });
    sendJson(response, 200, { ok: true, message: amount > 0 ? `Đã cộng ${amount.toLocaleString("vi-VN")} ₫.` : `Đã trừ ${Math.abs(amount).toLocaleString("vi-VN")} ₫.`, tx, balance: newBal });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: set VIP level
async function handleAdminSetVip(request, response, username) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    const vipLevel = String(data.vipLevel || "").trim().toUpperCase();
    const vipLevels = getVipLevels();
    if (!vipLevels[vipLevel]) {
      sendJson(response, 400, { ok: false, message: `Cấp VIP không hợp lệ. Chấp nhận: ${Object.keys(vipLevels).join(", ")}.` });
      return;
    }
    await refreshStoreFromSupabase("accounts");
    const accountDb = readDb();
    const idx = accountDb.accounts.findIndex((a) => a.username === username);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    accountDb.accounts[idx].vipLevel = vipLevel;
    writeDb(accountDb);
    audit("user-set-vip", username, { vipLevel });
    sendJson(response, 200, { ok: true, message: `Đã đặt ${username} thành ${vipLevel}.`, vip: getVipInfo(vipLevel) });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: get VIP levels config
function handleAdminVipLevels(request, response) {
  sendJson(response, 200, { ok: true, levels: getVipLevels() });
}

// Admin: update VIP levels
async function handleAdminUpdateVipLevels(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("config");
    const incoming = data.levels || {};
    const validKeys = Object.keys(DEFAULT_VIP_LEVELS);
    const newLevels = {};
    for (const key of validKeys) {
      const lvl = incoming[key];
      if (!lvl) {
        sendJson(response, 400, { ok: false, message: `Thiếu cấu hình ${key}.` });
        return;
      }
      const rate = Number(lvl.rate);
      const refRate = Number(lvl.refRate);
      const dailyCap = Number(lvl.dailyCap);
      const minRange = Number(lvl.minRange || 0);
      const maxRange = Number(lvl.maxRange);
      if (!(rate >= 0 && rate <= 1 && refRate >= 0 && refRate <= 1 && dailyCap > 0 && maxRange > minRange)) {
        sendJson(response, 400, { ok: false, message: `Cấu hình ${key} không hợp lệ.` });
        return;
      }
      newLevels[key] = { rate, refRate, dailyCap, minRange, maxRange };
    }
    const c = readConfig();
    c.vipLevels = newLevels;
    writeConfig(c);
    audit("vip-config-update", null, { levels: Object.keys(newLevels) });
    sendJson(response, 200, { ok: true, message: "Đã cập nhật cấu hình VIP.", levels: newLevels });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: change password
async function handleAdminChangePassword(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin hiện tại." });
      return;
    }
    const newPw = String(data.newPassword || "");
    if (newPw.length < 6) {
      sendJson(response, 400, { ok: false, message: "Mật khẩu mới tối thiểu 6 ký tự." });
      return;
    }
    await refreshStoreFromSupabase("config");
    const { hash, salt } = hashPassword(newPw);
    const c = readConfig();
    c.adminPasswordHash = hash;
    c.adminPasswordSalt = salt;
    writeConfig(c);
    audit("admin-password-changed");
    sendJson(response, 200, { ok: true, message: "Đã đổi mật khẩu admin." });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: list products
async function handleAdminListProducts(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    sendJson(response, 200, { ok: true, products: readProducts().products });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Public: list products (used by client home) — chỉ trả product đang bật
async function handlePublicListProducts(request, response) {
  try {
    await refreshStoreFromSupabase("products");
    const list = readProducts().products.filter((p) => p.enabled !== false);
    sendJson(response, 200, { ok: true, products: list });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: create product
async function handleAdminCreateProduct(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    const title = String(data.title || "").trim();
    const img = String(data.img || "").trim();
    const amount = Math.max(0, Math.round(Number(data.amount || 0)));
    if (!title) {
      sendJson(response, 400, { ok: false, message: "Cần nhập tên sản phẩm." });
      return;
    }
    await refreshStoreFromSupabase("products");
    const p = readProducts();
    const product = {
      id: "P-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      title,
      img,
      amount,
      enabled: true,
      createdAt: Date.now(),
    };
    p.products.unshift(product);
    writeProducts(p);
    audit("product-create", product.id, { title });
    sendJson(response, 201, { ok: true, message: "Đã thêm sản phẩm.", product });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: update product
async function handleAdminUpdateProduct(request, response, productId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("products");
    const p = readProducts();
    const idx = p.products.findIndex((x) => x.id === productId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy sản phẩm." });
      return;
    }
    if (data.title != null) p.products[idx].title = String(data.title).trim();
    if (data.img != null) p.products[idx].img = String(data.img).trim();
    if (data.amount != null) p.products[idx].amount = Math.max(0, Math.round(Number(data.amount || 0)));
    if (data.enabled != null) p.products[idx].enabled = !!data.enabled;
    writeProducts(p);
    audit("product-update", productId, { fields: Object.keys(data).filter((k) => k !== "adminPassword") });
    sendJson(response, 200, { ok: true, message: "Đã cập nhật sản phẩm.", product: p.products[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: delete product
async function handleAdminDeleteProduct(request, response, productId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("products");
    const p = readProducts();
    const before = p.products.length;
    p.products = p.products.filter((x) => x.id !== productId);
    if (p.products.length === before) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy sản phẩm." });
      return;
    }
    writeProducts(p);
    audit("product-delete", productId);
    sendJson(response, 200, { ok: true, message: "Đã xóa sản phẩm." });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: list audit logs
async function handleAdminAuditList(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    const a = readAudit();
    sendJson(response, 200, { ok: true, logs: a.logs.slice(0, 200) });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: dashboard stats
async function handleAdminDashboard(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const accountDb = readDb();
    const orderDb = readOrders();
    const txDb = readTx();

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(); startOfWeek.setDate(startOfWeek.getDate() - 7);

    const totalUsers = accountDb.accounts.length;
    const blockedUsers = accountDb.accounts.filter((a) => a.blocked).length;
    const usersByVip = {};
    for (const lvl of Object.keys(getVipLevels())) usersByVip[lvl] = 0;
    accountDb.accounts.forEach((a) => { usersByVip[a.vipLevel || "VIP1"] = (usersByVip[a.vipLevel || "VIP1"] || 0) + 1; });

    const orders = orderDb.orders;
    const ordersByStatus = { available: 0, claimed: 0, approved: 0, rejected: 0 };
    orders.forEach((o) => { ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1; });
    const ordersToday = orders.filter((o) => o.createdAt >= startOfDay.getTime()).length;
    const totalOrderAmount = orders.filter((o) => o.status === "approved").reduce((s, o) => s + o.amount, 0);
    const totalCommissionPaid = orders.filter((o) => o.status === "approved").reduce((s, o) => s + (o.commission || 0), 0);

    const txs = txDb.txs;
    const txByStatus = { pending: 0, approved: 0, rejected: 0 };
    txs.forEach((t) => { txByStatus[t.status] = (txByStatus[t.status] || 0) + 1; });
    const totalDeposited = txs.filter((t) => t.type === "deposit" && t.status === "approved").reduce((s, t) => s + t.amount, 0);
    const totalWithdrawn = txs.filter((t) => t.type === "withdraw" && t.status === "approved").reduce((s, t) => s + t.amount, 0);
    const pendingDeposit = txs.filter((t) => t.type === "deposit" && t.status === "pending").reduce((s, t) => s + t.amount, 0);
    const pendingWithdraw = txs.filter((t) => t.type === "withdraw" && t.status === "pending").reduce((s, t) => s + t.amount, 0);
    const adjustmentTotal = txs.filter((t) => t.type === "adjustment" && t.status === "approved").reduce((s, t) => s + t.amount, 0);

    // Top users by commission
    const topUsers = accountDb.accounts.map((a) => {
      const myOrders = orders.filter((o) => o.claimedBy === a.username && o.status === "approved");
      return {
        username: a.username,
        fullName: a.fullName,
        vipLevel: a.vipLevel || "VIP1",
        commission: myOrders.reduce((s, o) => s + (o.commission || 0), 0),
        orderCount: myOrders.length,
      };
    }).sort((a, b) => b.commission - a.commission).slice(0, 5);

    // Recent activity (last 10) — combine orders and txs
    const orderEvents = orders.map((o) => ({
      type: "order",
      action: o.status,
      title: o.productTitle,
      who: o.claimedBy || o.assignedTo || "",
      amount: o.amount,
      ts: o.approvedAt || o.rejectedAt || o.claimedAt || o.createdAt,
    }));
    const txEvents = txs.map((t) => ({
      type: "tx-" + t.type,
      action: t.status,
      title: t.type === "adjustment" ? (t.reason || "Điều chỉnh") : (t.type === "deposit" ? "Nạp tiền" : "Rút tiền"),
      who: t.username,
      amount: t.type === "adjustment" ? t.amount : (t.type === "deposit" ? t.amount : -t.amount),
      ts: t.approvedAt || t.rejectedAt || t.createdAt,
    }));
    const recentActivity = [...orderEvents, ...txEvents].sort((a, b) => b.ts - a.ts).slice(0, 12);

    sendJson(response, 200, {
      ok: true,
      stats: {
        totalUsers, blockedUsers, usersByVip,
        ordersByStatus, ordersToday, totalOrderAmount, totalCommissionPaid,
        txByStatus, totalDeposited, totalWithdrawn, pendingDeposit, pendingWithdraw, adjustmentTotal,
      },
      topUsers,
      recentActivity,
    });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: block/unblock user
async function handleAdminToggleBlock(request, response, username) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("accounts");
    const accountDb = readDb();
    const idx = accountDb.accounts.findIndex((a) => a.username === username);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    const newBlocked = !accountDb.accounts[idx].blocked;
    accountDb.accounts[idx].blocked = newBlocked;
    writeDb(accountDb);
    audit(newBlocked ? "user-block" : "user-unblock", username);
    sendJson(response, 200, { ok: true, message: newBlocked ? `Đã khóa @${username}.` : `Đã mở khóa @${username}.`, blocked: newBlocked });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: delete user (hard delete + cascade orders/txs)
async function handleAdminDeleteUser(request, response, username) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const accountDb = readDb();
    const idx = accountDb.accounts.findIndex((a) => a.username === username);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    const cascade = data.cascade !== false; // default true
    accountDb.accounts.splice(idx, 1);
    writeDb(accountDb);
    let removedOrders = 0;
    let removedTxs = 0;
    if (cascade) {
      const od = readOrders();
      const beforeO = od.orders.length;
      od.orders = od.orders.filter((o) => o.claimedBy !== username && o.assignedTo !== username);
      removedOrders = beforeO - od.orders.length;
      writeOrders(od);
      const td = readTx();
      const beforeT = td.txs.length;
      td.txs = td.txs.filter((t) => t.username !== username);
      removedTxs = beforeT - td.txs.length;
      writeTx(td);
    }
    audit("user-delete", username, { removedOrders, removedTxs, cascade });
    sendJson(response, 200, { ok: true, message: `Đã xóa @${username}.`, removedOrders, removedTxs });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: update user (username/password/bankInfo/fullName/phone)
async function handleAdminUpdateUser(request, response, username) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const accountDb = readDb();
    const idx = accountDb.accounts.findIndex((a) => a.username === username);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    const acc = accountDb.accounts[idx];
    const changes = {};

    if (typeof data.fullName === "string" && data.fullName.trim()) {
      acc.fullName = data.fullName.trim();
      changes.fullName = acc.fullName;
    }
    if (typeof data.phone === "string" && data.phone.trim()) {
      acc.phone = data.phone.trim();
      changes.phone = acc.phone;
    }
    if (data.bankInfo && typeof data.bankInfo === "object") {
      const b = data.bankInfo;
      acc.bankInfo = {
        bank: String(b.bank || "").trim(),
        account: String(b.account || "").trim(),
        holder: String(b.holder || "").trim(),
        branch: String(b.branch || "").trim(),
      };
      changes.bankInfo = acc.bankInfo;
    } else if (data.bankInfo === null) {
      acc.bankInfo = null;
      changes.bankInfo = null;
    }
    if (typeof data.password === "string" && data.password.length > 0) {
      if (data.password.length < 6) {
        sendJson(response, 400, { ok: false, message: "Mật khẩu cần tối thiểu 6 ký tự." });
        return;
      }
      const { hash, salt } = hashPassword(data.password);
      acc.passwordHash = hash;
      acc.salt = salt;
      changes.password = true;
    }

    let newUsername = null;
    if (typeof data.newUsername === "string") {
      const candidate = data.newUsername.trim().toLowerCase();
      if (candidate && candidate !== username) {
        if (!/^[a-z0-9_.-]{3,32}$/.test(candidate)) {
          sendJson(response, 400, { ok: false, message: "Username chỉ chứa a-z, 0-9, _ . - và dài 3-32 ký tự." });
          return;
        }
        if (accountDb.accounts.some((a) => a.username === candidate)) {
          sendJson(response, 409, { ok: false, message: "Tên đăng nhập đã tồn tại." });
          return;
        }
        newUsername = candidate;
      }
    }

    if (newUsername) {
      acc.username = newUsername;
      writeDb(accountDb);
      const od = readOrders();
      let touchedOrders = 0;
      for (const o of od.orders) {
        if (o.claimedBy === username) { o.claimedBy = newUsername; touchedOrders++; }
        if (o.assignedTo === username) { o.assignedTo = newUsername; touchedOrders++; }
      }
      if (touchedOrders > 0) writeOrders(od);
      const td = readTx();
      let touchedTxs = 0;
      for (const t of td.txs) {
        if (t.username === username) { t.username = newUsername; touchedTxs++; }
      }
      if (touchedTxs > 0) writeTx(td);
      changes.username = newUsername;
      audit("user-rename", username, { newUsername, touchedOrders, touchedTxs });
    } else {
      writeDb(accountDb);
    }

    if (Object.keys(changes).length === 0) {
      sendJson(response, 400, { ok: false, message: "Không có thay đổi nào." });
      return;
    }
    audit("user-update", newUsername || username, { fields: Object.keys(changes) });
    sendJson(response, 200, { ok: true, message: "Đã cập nhật user.", changes, username: newUsername || username });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: get user detail (account + orders + txs)
async function handleAdminUserDetail(request, response, username) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const accountDb = readDb();
    const account = accountDb.accounts.find((a) => a.username === username);
    if (!account) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    const od = readOrders();
    const myOrders = od.orders.filter((o) => o.claimedBy === username).sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));
    const td = readTx();
    const myTxs = td.txs.filter((t) => t.username === username).sort((a, b) => b.createdAt - a.createdAt);
    const balance = computeBalance(username);
    const vipLevel = account.vipLevel || "VIP1";
    sendJson(response, 200, {
      ok: true,
      user: {
        id: account.id,
        fullName: account.fullName,
        phone: account.phone,
        username: account.username,
        vipLevel,
        vip: getVipInfo(vipLevel),
        blocked: !!account.blocked,
        createdAt: account.createdAt,
        balance,
        bankInfo: account.bankInfo || null,
      },
      orders: myOrders,
      txs: myTxs,
    });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: list users
async function handleAdminListUsers(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const accountDb = readDb();
    const orderDb = readOrders();
    const users = accountDb.accounts.map((a) => {
      const myOrders = orderDb.orders.filter((o) => o.claimedBy === a.username);
      const approved = myOrders.filter((o) => o.status === "approved");
      const totalCommission = approved.reduce((s, o) => s + (o.commission || 0), 0);
      const bal = computeBalance(a.username);
      const vipLevel = a.vipLevel || "VIP1";
      return {
        id: a.id,
        fullName: a.fullName,
        phone: a.phone,
        username: a.username,
        createdAt: a.createdAt,
        orderCount: myOrders.length,
        approvedCount: approved.length,
        totalCommission,
        balance: bal,
        vipLevel,
        vip: getVipInfo(vipLevel),
        blocked: !!a.blocked,
        bankInfo: a.bankInfo || null,
      };
    });
    sendJson(response, 200, { ok: true, users });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: list all orders
async function handleAdminListOrders(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    sendJson(response, 200, { ok: true, orders: db.orders });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: approve a claimed order
async function handleAdminApproveOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    const idx = db.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy đơn." });
      return;
    }
    if (db.orders[idx].status !== "claimed") {
      sendJson(response, 400, { ok: false, message: "Đơn không ở trạng thái chờ duyệt." });
      return;
    }
    db.orders[idx].status = "approved";
    db.orders[idx].approvedAt = Date.now();
    writeOrders(db);
    audit("order-approve", orderId, { user: db.orders[idx].claimedBy, amount: db.orders[idx].amount });
    sendJson(response, 200, { ok: true, message: "Đã duyệt đơn.", order: db.orders[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: reject a claimed order
async function handleAdminRejectOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    const idx = db.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy đơn." });
      return;
    }
    if (db.orders[idx].status !== "claimed") {
      sendJson(response, 400, { ok: false, message: "Chỉ có thể từ chối đơn đang chờ duyệt." });
      return;
    }
    db.orders[idx].status = "rejected";
    db.orders[idx].rejectedAt = Date.now();
    db.orders[idx].rejectedReason = String(data.reason || "").trim() || "Đã từ chối";
    writeOrders(db);
    audit("order-reject", orderId, { user: db.orders[idx].claimedBy, reason: db.orders[idx].rejectedReason });
    sendJson(response, 200, { ok: true, message: "Đã từ chối đơn.", order: db.orders[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: delete an order
async function handleAdminDeleteOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    db.orders = db.orders.filter((o) => o.id !== orderId);
    writeOrders(db);
    audit("order-delete", orderId);
    sendJson(response, 200, { ok: true, message: "Đã xóa đơn." });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: claim next available order
// Priority: orders assigned to this user first; then unassigned pool orders.
// Orders assigned to OTHER users are NOT visible/claimable.
async function handleClaimOrder(request, response) {
  try {
    const data = await readJson(request);
    const username = String(data.username || "").trim().toLowerCase();
    if (!username) {
      sendJson(response, 400, { ok: false, message: "Thiếu username." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("accounts"),
    ]);
    const accountDb = readDb();
    const account = accountDb.accounts.find((a) => a.username === username);
    if (!account) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    if (account.blocked) {
      sendJson(response, 403, { ok: false, message: "Tài khoản đã bị khóa, vui lòng liên hệ CSKH." });
      return;
    }
    const vip = getVipInfo(account.vipLevel || "VIP1");
    const db = readOrders();
    // Check daily cap (today only)
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayCount = db.orders.filter((o) => o.claimedBy === username && (o.claimedAt || 0) >= startOfDay.getTime()).length;
    if (todayCount >= vip.dailyCap) {
      sendJson(response, 403, { ok: false, message: `Đã đạt giới hạn ${vip.dailyCap} đơn/ngày của ${vip.level}.` });
      return;
    }
    // Block double-claim if user already has a pending one waiting for distribution
    const existingPending = db.orders.find((o) => o.claimedBy === username && o.status === "claim_pending");
    if (existingPending) {
      sendJson(response, 409, { ok: false, message: "Bạn đã có 1 đơn đang chờ hệ thống phân phối. Vui lòng đợi." });
      return;
    }
    // Priority: tiêu thụ đơn admin đã tạo sẵn cho user (assigned riêng trước, rồi đến pool chung).
    const assignedIdx = db.orders.findIndex((o) => o.status === "available" && o.assignedTo === username);
    const poolIdx = assignedIdx === -1
      ? db.orders.findIndex((o) => o.status === "available" && !o.assignedTo)
      : -1;
    const consumeIdx = assignedIdx !== -1 ? assignedIdx : poolIdx;
    if (consumeIdx !== -1) {
      const existing = db.orders[consumeIdx];
      existing.status = "claimed";
      existing.claimedBy = username;
      existing.claimedAt = Date.now();
      writeOrders(db);
      audit("order-claim", existing.id, { username, amount: existing.amount, commission: existing.commission });
      sendJson(response, 200, { ok: true, message: "Đã nhận đơn, chờ duyệt.", order: existing });
      return;
    }
    // Fallback: chưa có đơn sẵn → tạo placeholder claim_pending để admin phân phối.
    const order = {
      id: "ORD-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      status: "claim_pending",
      productTitle: null,
      productImg: null,
      amount: 0,
      commission: 0,
      commissionRate: 0,
      assignedTo: null,
      claimedBy: username,
      claimedAt: Date.now(),
      approvedAt: null,
      rejectedAt: null,
      rejectedReason: null,
      createdAt: Date.now(),
    };
    db.orders.unshift(order);
    writeOrders(db);
    audit("order-claim-pending", order.id, { username });
    sendJson(response, 200, { ok: true, message: "Đã nhận đơn, đang chờ hệ thống phân phối.", order });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

async function handleAdminDistributeOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    const productTitle = String(data.productTitle || "").trim();
    const productImg = String(data.productImg || "").trim();
    const amount = Number(data.amount || 0);
    const fixedCommission = Number(data.commission || 0);
    if (!productTitle || amount <= 0) {
      sendJson(response, 400, { ok: false, message: "Cần nhập tên sản phẩm và số tiền > 0." });
      return;
    }
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    const idx = db.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy đơn." });
      return;
    }
    const order = db.orders[idx];
    if (order.status !== "claim_pending") {
      sendJson(response, 400, { ok: false, message: "Đơn này không ở trạng thái chờ phân phối." });
      return;
    }
    let commissionRate;
    let commission;
    if (fixedCommission > 0) {
      commission = Math.round(fixedCommission);
      commissionRate = amount > 0 ? commission / amount : 0;
    } else {
      commissionRate = Number(data.commissionRate || 0.005);
      commission = Math.round(amount * commissionRate);
    }
    order.productTitle = productTitle;
    order.productImg = productImg;
    order.amount = amount;
    order.commission = commission;
    order.commissionRate = commissionRate;
    order.status = "claimed";
    writeOrders(db);
    audit("order-distribute", orderId, { productTitle, amount, commission, claimedBy: order.claimedBy });
    sendJson(response, 200, { ok: true, message: "Đã phân phối sản phẩm cho user.", order });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: submit own claimed order — auto-approves (no admin step), credits commission
async function handleUserSubmitOrder(request, response, orderId) {
  try {
    const data = await readJson(request);
    const username = String(data.username || "").trim().toLowerCase();
    if (!username) {
      sendJson(response, 400, { ok: false, message: "Thiếu username." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const db = readOrders();
    const idx = db.orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy đơn." });
      return;
    }
    const order = db.orders[idx];
    // Cho phép submit khi:
    //   - claimed bởi chính user
    //   - approved bởi chính user (idempotent)
    //   - available + assignedTo === user (admin tự tạo đơn cho user) → tự claim + approve trong 1 bước
    const isAdminAssignedToUser = order.status === "available" && order.assignedTo === username;
    if (!isAdminAssignedToUser && order.claimedBy !== username) {
      sendJson(response, 403, { ok: false, message: "Đơn này không thuộc tài khoản của bạn." });
      return;
    }
    if (order.status !== "claimed" && order.status !== "approved" && !isAdminAssignedToUser) {
      sendJson(response, 400, { ok: false, message: "Đơn không ở trạng thái có thể gửi." });
      return;
    }
    // Require user balance >= order value (chỉ check khi chưa approved)
    if (order.status !== "approved") {
      const bal = computeBalance(username);
      const need = Number(order.amount || 0);
      if (bal.available < need) {
        sendJson(response, 400, { ok: false, message: "Số dư không khả dụng, vui lòng nạp thêm tiền để hoàn thành đơn hàng." });
        return;
      }
      if (isAdminAssignedToUser) {
        order.claimedBy = username;
        order.claimedAt = Date.now();
      }
      order.status = "approved";
      order.approvedAt = Date.now();
      writeOrders(db);
      audit("order-self-submit", orderId, { user: username, amount: order.amount, commission: order.commission });
    }
    sendJson(response, 200, { ok: true, message: "Đã gửi đơn thành công.", order });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: get my orders (claimed/approved/rejected belonging to me)
async function handleMyOrders(request, response, username) {
  try {
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    // Include:
    // 1. Orders user has already claimed (claimed/approved/rejected)
    // 2. Orders admin has assigned specifically to user but user hasn't claimed yet (available + assignedTo)
    const mine = db.orders
      .filter((o) =>
        o.claimedBy === username ||
        (o.status === "available" && o.assignedTo === username)
      )
      .sort((a, b) => (b.claimedAt || b.createdAt || 0) - (a.claimedAt || a.createdAt || 0));
    sendJson(response, 200, { ok: true, orders: mine });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// ============== TRANSACTIONS API ==============

// User: create a deposit request
async function handleCreateDeposit(request, response) {
  try {
    const data = await readJson(request);
    const username = String(data.username || "").trim().toLowerCase();
    const amount = Number(data.amount || 0);
    const paymentMethod = String(data.paymentMethod || "Chuyển khoản ngân hàng").trim();
    if (!username || amount <= 0) {
      sendJson(response, 400, { ok: false, message: "Thiếu thông tin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("transactions"),
    ]);
    const accountDb = readDb();
    const account = accountDb.accounts.find((a) => a.username === username);
    if (!account) {
      sendJson(response, 400, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    if (account.blocked) {
      sendJson(response, 403, { ok: false, message: "Tài khoản đã bị khóa, vui lòng liên hệ CSKH." });
      return;
    }
    const t = readTx();
    const tx = {
      id: "TX-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      type: "deposit",
      username,
      amount,
      paymentMethod,
      bankInfo: null,
      status: "pending",
      rejectedReason: null,
      createdAt: Date.now(),
      approvedAt: null,
      rejectedAt: null,
      approvedBy: null,
    };
    t.txs.unshift(tx);
    writeTx(t);
    sendJson(response, 201, { ok: true, message: "Yêu cầu nạp tiền đã được tạo, chờ admin duyệt.", tx });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: create a withdraw request
async function handleCreateWithdraw(request, response) {
  try {
    const data = await readJson(request);
    const username = String(data.username || "").trim().toLowerCase();
    const amount = Number(data.amount || 0);
    const bankInfo = data.bankInfo || null;
    if (!username || amount <= 0) {
      sendJson(response, 400, { ok: false, message: "Thiếu thông tin." });
      return;
    }
    if (!bankInfo || !bankInfo.bank || !bankInfo.account || !bankInfo.holder) {
      sendJson(response, 400, { ok: false, message: "Thiếu thông tin tài khoản nhận." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("transactions"),
      refreshStoreFromSupabase("orders"),
    ]);
    const accountDb = readDb();
    const account = accountDb.accounts.find((a) => a.username === username);
    if (!account) {
      sendJson(response, 400, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    if (account.blocked) {
      sendJson(response, 403, { ok: false, message: "Tài khoản đã bị khóa, vui lòng liên hệ CSKH." });
      return;
    }
    // Check available balance
    const bal = computeBalance(username);
    if (amount > bal.available) {
      sendJson(response, 400, { ok: false, message: `Số dư khả dụng không đủ (còn ${bal.available.toLocaleString("vi-VN")} ₫).` });
      return;
    }
    const t = readTx();
    const tx = {
      id: "TX-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      type: "withdraw",
      username,
      amount,
      paymentMethod: null,
      bankInfo: {
        bank: String(bankInfo.bank).trim(),
        account: String(bankInfo.account).trim(),
        holder: String(bankInfo.holder).trim(),
        branch: String(bankInfo.branch || "").trim(),
      },
      status: "pending",
      rejectedReason: null,
      createdAt: Date.now(),
      approvedAt: null,
      rejectedAt: null,
      approvedBy: null,
    };
    t.txs.unshift(tx);
    writeTx(t);
    sendJson(response, 201, { ok: true, message: "Yêu cầu rút tiền đã được tạo, chờ admin duyệt.", tx });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: get referral info (my code + list of people I referred + bonus stats)
async function handleReferralInfo(request, response, username) {
  try {
    const accountDb = readDb();
    const me = accountDb.accounts.find((a) => a.username === username);
    if (!me) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy user." });
      return;
    }
    if (!me.referralCode) me.referralCode = generateReferralCode(me.id);
    const referrals = accountDb.accounts
      .filter((a) => a.referredBy === username)
      .map((a) => ({
        username: a.username,
        fullName: a.fullName,
        vipLevel: a.vipLevel || "VIP1",
        createdAt: a.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const t = readTx();
    const bonusTxs = t.txs
      .filter((x) => x.username === username && x.type === "referral-bonus" && x.status === "approved")
      .sort((a, b) => b.createdAt - a.createdAt);
    const totalBonus = bonusTxs.reduce((s, x) => s + x.amount, 0);
    const myVipRank = VIP_RANK[me.vipLevel || "VIP1"] || 1;
    const requiredRank = VIP_RANK[REFERRAL_UNLOCK_VIP] || 2;
    const unlocked = myVipRank >= requiredRank;
    sendJson(response, 200, {
      ok: true,
      referralCode: me.referralCode,
      vipLevel: me.vipLevel || "VIP1",
      bonusUnlocked: unlocked,
      requiredVip: REFERRAL_UNLOCK_VIP,
      bonusPerReferral: REFERRAL_BONUS,
      totalBonus,
      lockedBonus: unlocked ? 0 : totalBonus,
      referrals,
      bonusHistory: bonusTxs.map((x) => ({
        id: x.id,
        amount: x.amount,
        referredUser: x.referredUser,
        createdAt: x.createdAt,
      })),
    });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: get my transactions + balance + vip
async function handleMyTransactions(request, response, username) {
  try {
    await Promise.all([
      refreshStoreFromSupabase("transactions"),
      refreshStoreFromSupabase("accounts"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("config"),
    ]);
    const t = readTx();
    const mine = t.txs
      .filter((x) => x.username === username)
      .sort((a, b) => b.createdAt - a.createdAt);
    const balance = computeBalance(username);
    const accountDb = readDb();
    const account = accountDb.accounts.find((a) => a.username === username);
    const vip = getVipInfo(account ? (account.vipLevel || "VIP1") : "VIP1");
    sendJson(response, 200, { ok: true, txs: mine, balance, vip });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: list all transactions (optionally filter by status/type)
async function handleAdminListTx(request, response) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("transactions");
    const t = readTx();
    sendJson(response, 200, { ok: true, txs: t.txs });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: approve a tx
async function handleAdminApproveTx(request, response, txId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await Promise.all([
      refreshStoreFromSupabase("transactions"),
      refreshStoreFromSupabase("orders"),
      refreshStoreFromSupabase("accounts"),
    ]);
    const t = readTx();
    const idx = t.txs.findIndex((x) => x.id === txId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy giao dịch." });
      return;
    }
    if (t.txs[idx].status !== "pending") {
      sendJson(response, 400, { ok: false, message: "Giao dịch không ở trạng thái chờ duyệt." });
      return;
    }
    // For withdrawal, double-check available balance still covers it
    if (t.txs[idx].type === "withdraw") {
      const bal = computeBalance(t.txs[idx].username);
      // Note: pending withdrawal already counted in frozen, so total = available + frozen
      if (t.txs[idx].amount > bal.total) {
        sendJson(response, 400, { ok: false, message: "Số dư user không đủ để duyệt rút." });
        return;
      }
    }
    t.txs[idx].status = "approved";
    t.txs[idx].approvedAt = Date.now();
    t.txs[idx].approvedBy = "admin";
    writeTx(t);
    audit("tx-approve", txId, { type: t.txs[idx].type, amount: t.txs[idx].amount, user: t.txs[idx].username });
    sendJson(response, 200, { ok: true, message: "Đã duyệt giao dịch.", tx: t.txs[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// Admin: reject a tx
async function handleAdminRejectTx(request, response, txId) {
  try {
    const data = await readJson(request);
    if (!checkAdmin(data)) {
      sendJson(response, 401, { ok: false, message: "Sai mật khẩu admin." });
      return;
    }
    await refreshStoreFromSupabase("transactions");
    const t = readTx();
    const idx = t.txs.findIndex((x) => x.id === txId);
    if (idx === -1) {
      sendJson(response, 404, { ok: false, message: "Không tìm thấy giao dịch." });
      return;
    }
    t.txs[idx].status = "rejected";
    t.txs[idx].rejectedAt = Date.now();
    t.txs[idx].rejectedReason = String(data.reason || "Admin từ chối").trim();
    writeTx(t);
    audit("tx-reject", txId, { type: t.txs[idx].type, reason: t.txs[idx].rejectedReason, user: t.txs[idx].username });
    sendJson(response, 200, { ok: true, message: "Đã từ chối giao dịch.", tx: t.txs[idx] });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

// User: count of orders this user can claim (assigned to them OR unassigned)
async function handlePoolCount(request, response) {
  try {
    const url = new URL(request.url, `http://${host}`);
    const username = (url.searchParams.get("username") || "").trim().toLowerCase();
    await refreshStoreFromSupabase("orders");
    const db = readOrders();
    const eligibleOrders = db.orders.filter((o) => {
      if (o.status !== "available") return false;
      if (!o.assignedTo) return true; // open pool
      return username && o.assignedTo === username;
    });
    const next = eligibleOrders[0] || null;
    sendJson(response, 200, {
      ok: true,
      available: eligibleOrders.length,
      next: next ? {
        id: next.id,
        productTitle: next.productTitle,
        productImg: next.productImg,
        amount: next.amount,
        commission: next.commission,
        commissionRate: next.commissionRate,
        assignedTo: next.assignedTo || null,
      } : null,
    });
  } catch (e) {
    sendJson(response, 400, { ok: false, message: "Lỗi." });
  }
}

function serveStatic(request, response) {
  const requestPath = request.url === "/" ? "/index.html" : decodeURIComponent(request.url.split("?")[0]);
  const filePath = path.normalize(path.join(root, requestPath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const headers = {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
    };
    // Không cache HTML để sửa code là user thấy ngay; ảnh/css/js dùng cache mặc định.
    if (ext === ".html") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    }
    response.writeHead(200, headers);
    response.end(content);
  });
}

function appHandler(request, response) {
  // Defer response.end until pending Supabase writes complete, so any read
  // landing on a different serverless container observes the latest state.
  if (USE_SUPABASE) {
    const originalEnd = response.end.bind(response);
    let endCalled = false;
    response.end = function (...args) {
      if (endCalled) return response;
      endCalled = true;
      flushPendingWrites()
        .catch(() => {})
        .then(() => originalEnd(...args));
      return response;
    };
  }

  const fullUrl = request.url || "";
  const url = fullUrl.split("?")[0];
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    response.end();
    return;
  }

  // Auth
  if (method === "GET" && url === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      storage: USE_SUPABASE ? "supabase" : "local",
      table: SUPABASE_TABLE,
      node: process.version,
      vercel: !!process.env.VERCEL,
    });
  }
  if (method === "POST" && url === "/api/register") return handleRegister(request, response);
  if (method === "POST" && url === "/api/login") return handleLogin(request, response);

  // Admin endpoints (POST with adminPassword in body)
  if (method === "POST" && url === "/api/admin/orders/create") return handleAdminCreateOrder(request, response);
  if (method === "POST" && url === "/api/admin/orders/list") return handleAdminListOrders(request, response);
  if (method === "POST" && url === "/api/admin/users/list") return handleAdminListUsers(request, response);
  if (method === "GET" && url === "/api/admin/vip/levels") return handleAdminVipLevels(request, response);
  if (method === "POST" && url === "/api/admin/vip/update") return handleAdminUpdateVipLevels(request, response);
  if (method === "POST" && url === "/api/admin/dashboard") return handleAdminDashboard(request, response);
  if (method === "POST" && url === "/api/admin/change-password") return handleAdminChangePassword(request, response);
  if (method === "POST" && url === "/api/admin/products/list") return handleAdminListProducts(request, response);
  if (method === "POST" && url === "/api/admin/products/create") return handleAdminCreateProduct(request, response);
  const updateProductMatch = url.match(/^\/api\/admin\/products\/([\w-]+)\/update$/);
  if (method === "POST" && updateProductMatch) return handleAdminUpdateProduct(request, response, updateProductMatch[1]);
  const deleteProductMatch = url.match(/^\/api\/admin\/products\/([\w-]+)\/delete$/);
  if (method === "POST" && deleteProductMatch) return handleAdminDeleteProduct(request, response, deleteProductMatch[1]);
  if (method === "POST" && url === "/api/admin/audit/list") return handleAdminAuditList(request, response);
  if (method === "GET" && url === "/api/products") return handlePublicListProducts(request, response);
  const adjustMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/adjust-balance$/);
  if (method === "POST" && adjustMatch) return handleAdminAdjustBalance(request, response, decodeURIComponent(adjustMatch[1]).toLowerCase());
  const setVipMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/set-vip$/);
  if (method === "POST" && setVipMatch) return handleAdminSetVip(request, response, decodeURIComponent(setVipMatch[1]).toLowerCase());
  const blockMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/toggle-block$/);
  if (method === "POST" && blockMatch) return handleAdminToggleBlock(request, response, decodeURIComponent(blockMatch[1]).toLowerCase());
  const delUserMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/delete$/);
  if (method === "POST" && delUserMatch) return handleAdminDeleteUser(request, response, decodeURIComponent(delUserMatch[1]).toLowerCase());
  const userDetailMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/detail$/);
  if (method === "POST" && userDetailMatch) return handleAdminUserDetail(request, response, decodeURIComponent(userDetailMatch[1]).toLowerCase());
  const userUpdateMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/update$/);
  if (method === "POST" && userUpdateMatch) return handleAdminUpdateUser(request, response, decodeURIComponent(userUpdateMatch[1]).toLowerCase());
  const approveMatch = url.match(/^\/api\/admin\/orders\/([\w-]+)\/approve$/);
  if (method === "POST" && approveMatch) return handleAdminApproveOrder(request, response, approveMatch[1]);
  const rejectMatch = url.match(/^\/api\/admin\/orders\/([\w-]+)\/reject$/);
  if (method === "POST" && rejectMatch) return handleAdminRejectOrder(request, response, rejectMatch[1]);
  const deleteMatch = url.match(/^\/api\/admin\/orders\/([\w-]+)\/delete$/);
  if (method === "POST" && deleteMatch) return handleAdminDeleteOrder(request, response, deleteMatch[1]);
  const assignMatch = url.match(/^\/api\/admin\/orders\/([\w-]+)\/assign$/);
  if (method === "POST" && assignMatch) return handleAdminAssignOrder(request, response, assignMatch[1]);
  const unassignMatch = url.match(/^\/api\/admin\/orders\/([\w-]+)\/unassign$/);
  if (method === "POST" && unassignMatch) return handleAdminUnassignOrder(request, response, unassignMatch[1]);
  const distributeMatch = url.match(/^\/api\/admin\/orders\/([\w-]+)\/distribute$/);
  if (method === "POST" && distributeMatch) return handleAdminDistributeOrder(request, response, distributeMatch[1]);

  // User endpoints — orders
  if (method === "POST" && url === "/api/orders/claim") return handleClaimOrder(request, response);
  if (method === "GET" && url === "/api/orders/pool") return handlePoolCount(request, response);
  const myMatch = url.match(/^\/api\/orders\/mine\/([^/?]+)$/);
  if (method === "GET" && myMatch) return handleMyOrders(request, response, decodeURIComponent(myMatch[1]).toLowerCase());
  const submitOrderMatch = url.match(/^\/api\/orders\/([\w-]+)\/submit$/);
  if (method === "POST" && submitOrderMatch) return handleUserSubmitOrder(request, response, submitOrderMatch[1]);

  // User endpoints — transactions
  if (method === "POST" && url === "/api/deposit/create") return handleCreateDeposit(request, response);
  if (method === "POST" && url === "/api/withdraw/create") return handleCreateWithdraw(request, response);
  const myTxMatch = url.match(/^\/api\/transactions\/mine\/([^/?]+)$/);
  if (method === "GET" && myTxMatch) return handleMyTransactions(request, response, decodeURIComponent(myTxMatch[1]).toLowerCase());
  const referralInfoMatch = url.match(/^\/api\/referral\/info\/([^/?]+)$/);
  if (method === "GET" && referralInfoMatch) return handleReferralInfo(request, response, decodeURIComponent(referralInfoMatch[1]).toLowerCase());

  // Admin endpoints — transactions
  if (method === "POST" && url === "/api/admin/transactions/list") return handleAdminListTx(request, response);
  const txApproveMatch = url.match(/^\/api\/admin\/transactions\/([\w-]+)\/approve$/);
  if (method === "POST" && txApproveMatch) return handleAdminApproveTx(request, response, txApproveMatch[1]);
  const txRejectMatch = url.match(/^\/api\/admin\/transactions\/([\w-]+)\/reject$/);
  if (method === "POST" && txRejectMatch) return handleAdminRejectTx(request, response, txRejectMatch[1]);

  if (method === "GET") return serveStatic(request, response);

  sendJson(response, 404, { ok: false, message: "Không tìm thấy API." });
}

let storageReady = null;

function ensureStorageReady() {
  if (!storageReady) {
    storageReady = initStorage();
  }
  return storageReady;
}

async function vercelHandler(request, response) {
  try {
    await ensureStorageReady();
    return appHandler(request, response);
  } catch (error) {
    console.error("[storage] init failed:", error.message);
    return sendJson(response, 500, { ok: false, message: "KhÃ´ng thá»ƒ káº¿t ná»‘i database." });
  }
}

if (require.main === module) {
  ensureStorageReady()
    .then(() => {
      const server = http.createServer(appHandler);
      server.listen(port, host, () => {
      console.log(`Server running at http://${host}:${port}`);
      console.log(`Storage: ${USE_SUPABASE ? `Supabase ${SUPABASE_TABLE}` : "local JSON"}`);
      console.log(`Initial admin password (if first run): ${INITIAL_ADMIN_PASSWORD}`);
    });
    })
    .catch((error) => {
      console.error("[storage] Supabase init failed:", error.message);
      console.error("[storage] Create the app_store table in Supabase, or set USE_SUPABASE=0 to use local JSON.");
      process.exit(1);
    });
}

module.exports = vercelHandler;
