const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET = 'blue_lock_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const adapter = new JSONFile('db.json');
const db = new Low(adapter, { users: [], exchanges: [], purchases: [], blogs: [], settings: {
  paymentMethods: [{ name: "Airtel Money", number: "0347871139", holder: "Josiane" }],
  rates: { ff: { tokens: 200, reward: 110, type: "diamonds" }, pubg: { tokens: 200, reward: 60, type: "UC" } },
  tokenPrice: { amount: 50, price: 1200, currency: "Ar" }
}});

async function initDB() {
  await db.read();
  db.data ||= { users: [], exchanges: [], purchases: [], blogs: [], settings: {} };
  if (!db.data.users.find(u => u.role === 'admin')) {
    const hash = await bcrypt.hash('admin123', 10);
    db.data.users.push({ id: 1, email: 'admin@blue.com', password: hash, role: 'admin', tokens: 999 });
  }
  await db.write();
}
initDB();

const auth = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
};

const adminAuth = async (req, res, next) => {
  const user = db.data.users.find(u => u.id === req.user.id);
  if (user?.role!== 'admin') return res.status(403).json({ error: 'Admin uniquement' });
  next();
};

// Auth routes
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  await db.read();
  if (db.data.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email existe déjà' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: Date.now(), email, password: hash, role: 'user', tokens: 0, pseudo: '', uid: '' };
  db.data.users.push(user);
  await db.write();
  const token = jwt.sign({ id: user.id }, SECRET);
  res.json({ token, user: { email, role: 'user', tokens: 0 } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  await db.read();
  const user = db.data.users.find(u => u.email === email);
  if (!user ||!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Identifiants invalides' });
  const token = jwt.sign({ id: user.id }, SECRET);
  res.json({ token, user: { email: user.email, role: user.role, tokens: user.tokens } });
});

// User routes
app.get('/api/me', auth, async (req, res) => {
  await db.read();
  const user = db.data.users.find(u => u.id === req.user.id);
  res.json({ email: user.email, tokens: user.tokens, role: user.role, pseudo: user.pseudo, uid: user.uid });
});

app.post('/api/claim-daily', auth, async (req, res) => {
  await db.read();
  const user = db.data.users.find(u => u.id === req.user.id);
  const today = new Date().toDateString();
  if (user.lastClaim === today) return res.status(400).json({ error: 'Déjà réclamé aujourd\'hui' });
  user.tokens += 20;
  user.lastClaim = today;
  await db.write();
  res.json({ tokens: user.tokens, message: '20 jetons ajoutés!' });
});

// Exchange routes
app.post('/api/exchange', auth, async (req, res) => {
  const { type, uid, pseudo } = req.body;
  await db.read();
  const user = db.data.users.find(u => u.id === req.user.id);
  const rates = db.data.settings.rates;
  const cost = rates[type].tokens;
  if (user.tokens < cost) return res.status(400).json({ error: 'Jetons insuffisants' });
  user.tokens -= cost;
  user.pseudo = pseudo;
  user.uid = uid;
  const exchange = { id: Date.now(), userId: user.id, email: user.email, type, uid, pseudo, status: 'pending', date: new Date().toISOString() };
  db.data.exchanges.push(exchange);
  await db.write();
  res.json({ message: 'Demande envoyée, en attente de confirmation' });
});

app.post('/api/purchase', auth, async (req, res) => {
  const { amount, transactionMsg, method } = req.body;
  await db.read();
  const purchase = { id: Date.now(), userId: req.user.id, amount, transactionMsg, method, status: 'pending', date: new Date().toISOString() };
  db.data.purchases.push(purchase);
  await db.write();
  res.json({ message: 'Commande envoyée, en attente de validation' });
});

// Blog routes
app.get('/api/blogs', async (req, res) => {
  await db.read();
  res.json(db.data.blogs);
});

app.get('/api/settings', async (req, res) => {
  await db.read();
  res.json(db.data.settings);
});

// Admin routes
app.get('/api/admin/users', auth, adminAuth, async (req, res) => {
  await db.read();
  res.json(db.data.users.map(u => ({ id: u.id, email: u.email, tokens: u.tokens, role: u.role })));
});

app.post('/api/admin/add-tokens', auth, adminAuth, async (req, res) => {
  const { userId, amount } = req.body;
  await db.read();
  const user = db.data.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User non trouvé' });
  user.tokens += amount;
  await db.write();
  res.json({ message: `${amount} jetons ajoutés` });
});

app.get('/api/admin/exchanges', auth, adminAuth, async (req, res) => {
  await db.read();
  res.json(db.data.exchanges);
});

app.post('/api/admin/exchange-status', auth, adminAuth, async (req, res) => {
  const { id, status } = req.body;
  await db.read();
  const ex = db.data.exchanges.find(e => e.id === id);
  if (!ex) return res.status(404).json({ error: 'Non trouvé' });
  ex.status = status;
  await db.write();
  res.json({ message: 'Statut mis à jour' });
});

app.get('/api/admin/download-users', auth, adminAuth, async (req, res) => {
  await db.read();
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=users.pdf');
  doc.pipe(res);
  doc.fontSize(20).text('Liste des Users - Blue Lock', { align: 'center' });
  doc.moveDown();
  db.data.users.forEach(u => {
    doc.fontSize(12).text(`Email: ${u.email} | Tokens: ${u.tokens} | Role: ${u.role}`);
  });
  doc.end();
});

app.post('/api/admin/blog', auth, adminAuth, async (req, res) => {
  const { title, description, image, link } = req.body;
  await db.read();
  db.data.blogs.push({ id: Date.now(), title, description, image, link, date: new Date().toISOString() });
  await db.write();
  res.json({ message: 'Blog ajouté' });
});

app.post('/api/admin/settings', auth, adminAuth, async (req, res) => {
  await db.read();
  db.data.settings = {...db.data.settings,...req.body };
  await db.write();
  res.json({ message: 'Paramètres mis à jour' });
});

app.listen(PORT, () => console.log(`Serveur lancé sur http://localhost:${PORT}`));
