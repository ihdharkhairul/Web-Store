require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '979797';
const DB_PATH = path.join(__dirname, 'data', 'db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- tiny JSON-file "database" with a write queue ----------
let writeChain = Promise.resolve();

function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(db) {
  // queue writes so two requests landing at the same time can't corrupt the file
  writeChain = writeChain.then(() => {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  });
  return writeChain;
}

function stockStatus(stock) {
  if (stock <= 0) return 'habis';
  if (stock <= 10) return 'low';
  return 'in';
}

function genOrderCode(existingOrders) {
  let code;
  const used = new Set(existingOrders.map(o => o.orderId));
  do {
    code = 'A97-' + Math.floor(100000 + Math.random() * 899999);
  } while (used.has(code));
  return code;
}

// ---------- admin auth (simple shared PIN, no accounts) ----------
function requireAdminPin(req, res, next) {
  const pin = req.header('x-admin-pin');
  if (!pin || pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'PIN admin salah atau belum diisi.' });
  }
  next();
}

// lets admin.html check a PIN without exposing any other data
app.post('/api/admin/verify-pin', (req, res) => {
  const { pin } = req.body || {};
  if (pin === ADMIN_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// ================= PUBLIC: products (read-only for customers) =================
app.get('/api/products', (req, res) => {
  const db = readDB();
  const products = db.products.map(p => ({ ...p, stockStatus: stockStatus(p.stock) }));
  res.json(products);
});

// ================= PUBLIC: place an order (no login, just fill the form) =================
app.post('/api/orders', async (req, res) => {
  const { customerName, phone, city, address, paymentMethod, items } = req.body || {};

  if (!customerName || !phone || !address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Nama, telepon, alamat, dan minimal 1 barang wajib diisi.' });
  }

  const db = readDB();

  // build the order from server-side product data, never trust prices sent by the browser
  let subtotal = 0;
  const orderItems = [];
  for (const it of items) {
    const product = db.products.find(p => p.id === Number(it.productId));
    const qty = Number(it.qty);
    if (!product || !qty || qty <= 0) {
      return res.status(400).json({ error: 'Ada barang di keranjang yang tidak valid.' });
    }
    if (product.stock < qty) {
      return res.status(409).json({ error: `Stok "${product.name}" tinggal ${product.stock}${product.unit}, tidak cukup untuk pesanan ini.` });
    }
    orderItems.push({ productId: product.id, name: product.name, unit: product.unit, price: product.price, qty });
    subtotal += product.price * qty;
  }

  const shipping = subtotal === 0 ? 0 : (subtotal >= 500000 ? 0 : 25000);
  const tax = Math.round(subtotal * 0.075);
  const total = subtotal + shipping + tax;

  // decrement stock now that the order is confirmed
  for (const it of orderItems) {
    const product = db.products.find(p => p.id === it.productId);
    product.stock -= it.qty;
  }

  const order = {
    id: Date.now(),
    orderId: genOrderCode(db.orders),
    createdAt: new Date().toISOString(),
    status: 'baru',
    customerName,
    phone,
    city: city || '',
    address,
    paymentMethod: paymentMethod || 'transfer',
    items: orderItems,
    subtotal, shipping, tax, total
  };

  db.orders.push(order);
  await writeDB(db);

  res.status(201).json(order);
});

// ================= ADMIN: orders queue (oldest / first-ordered on top) =================
app.get('/api/admin/orders', requireAdminPin, (req, res) => {
  const db = readDB();
  const sorted = [...db.orders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(sorted);
});

app.patch('/api/admin/orders/:id', requireAdminPin, async (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  const { status } = req.body || {};
  if (!['baru', 'diproses', 'dikirim', 'selesai', 'dibatalkan'].includes(status)) {
    return res.status(400).json({ error: 'Status tidak valid.' });
  }
  order.status = status;
  await writeDB(db);
  res.json(order);
});

// ================= ADMIN: products (upload stok, ubah harga) =================
app.post('/api/admin/products', requireAdminPin, async (req, res) => {
  const db = readDB();
  const { name, cat, brand, price, unit, stock, color, desc, specs } = req.body || {};
  if (!name || !cat || !brand || price == null || !unit || stock == null) {
    return res.status(400).json({ error: 'Nama, kategori, merek, harga, satuan, dan stok wajib diisi.' });
  }
  const product = {
    id: db.nextProductId++,
    name, cat, brand,
    color: color || '#8A8D92',
    price: Number(price),
    unit,
    stock: Number(stock),
    rating: 0,
    reviews: 0,
    desc: desc || '',
    specs: Array.isArray(specs) ? specs : []
  };
  db.products.push(product);
  await writeDB(db);
  res.status(201).json(product);
});

app.put('/api/admin/products/:id', requireAdminPin, async (req, res) => {
  const db = readDB();
  const product = db.products.find(p => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
  const { name, cat, brand, price, unit, stock, color } = req.body || {};
  if (name != null) product.name = name;
  if (cat != null) product.cat = cat;
  if (brand != null) product.brand = brand;
  if (unit != null) product.unit = unit;
  if (color != null) product.color = color;
  if (price != null) product.price = Number(price);
  if (stock != null) product.stock = Number(stock);
  await writeDB(db);
  res.json(product);
});

app.delete('/api/admin/products/:id', requireAdminPin, async (req, res) => {
  const db = readDB();
  const idx = db.products.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
  db.products.splice(idx, 1);
  await writeDB(db);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Ayat 97 server jalan di http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin.html (PIN: ${ADMIN_PIN})`);
});
