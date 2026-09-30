// ============================================================
// Expense Tracker API  |  Node.js + Express + MongoDB (Mongoose)
// Run: node server.js
// ============================================================
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const PAYMENT_METHODS = ['Cash', 'Credit Card', 'Debit Card', 'UPI', 'Other'];
const DEFAULT_CATEGORIES = ['Food', 'Travel', 'Shopping', 'Bills', 'Entertainment', 'Other'];

// ---------- Models ----------
const categorySchema = new mongoose.Schema(
  { name: { type: String, required: true, trim: true, maxlength: 50, unique: true } },
  { timestamps: true }
);
const Category = mongoose.model('Category', categorySchema);

const expenseSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    date: { type: Date, required: true, index: true },
    paymentMethod: { type: String, required: true, enum: PAYMENT_METHODS },
  },
  { timestamps: true }
);
const Expense = mongoose.model('Expense', expenseSchema);

// ---------- Helpers ----------
const isId = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n) => Math.round((n || 0) * 100) / 100;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error {
  constructor(status, message, errors) { super(message); this.status = status; this.errors = errors; }
}

// Parses "YYYY-MM-DD" (or ISO string) into a UTC-midnight Date; returns null if invalid (e.g. 2026-02-31)
function parseDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00.000Z');
  if (isNaN(d.getTime()) || d.toISOString().substring(0, 10) !== s) return null;
  return d;
}

function validateExpense(b) {
  const errors = [];
  const out = {};
  b = b || {};

  const amount = Number(b.amount);
  if (b.amount === undefined || b.amount === null || b.amount === '' || !Number.isFinite(amount)) {
    errors.push('Amount is required and must be a number');
  } else if (amount <= 0) {
    errors.push('Amount must be greater than zero');
  } else {
    out.amount = round2(amount);
  }

  if (!isId(b.category)) errors.push('A valid category is required');
  else out.category = b.category;

  const d = parseDate(b.date);
  if (!b.date) errors.push('Date is required');
  else if (!d) errors.push('Date is invalid (use YYYY-MM-DD)');
  else out.date = d;

  if (!PAYMENT_METHODS.includes(b.paymentMethod)) {
    errors.push('Payment method must be one of: ' + PAYMENT_METHODS.join(', '));
  } else out.paymentMethod = b.paymentMethod;

  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string') errors.push('Description must be text');
    else if (b.description.trim().length > 200) errors.push('Description must be 200 characters or less');
    else out.description = b.description.trim();
  }
  return { errors, out };
}

function validateCategoryName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Category name is required';
  if (name.trim().length > 50) return 'Category name must be 50 characters or less';
  return null;
}

async function ensureCategoryExists(id) {
  const exists = await Category.exists({ _id: id });
  if (!exists) throw new HttpError(400, 'Validation failed', ['Selected category does not exist']);
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ----- Categories -----
app.get('/api/categories', wrap(async (req, res) => {
  res.json(await Category.find().sort({ name: 1 }));
}));

app.post('/api/categories', wrap(async (req, res) => {
  const e = validateCategoryName(req.body && req.body.name);
  if (e) throw new HttpError(400, 'Validation failed', [e]);
  const name = req.body.name.trim();
  const dup = await Category.findOne({ name: new RegExp('^' + escapeRegex(name) + '$', 'i') });
  if (dup) throw new HttpError(409, 'Category already exists');
  res.status(201).json(await Category.create({ name }));
}));

app.put('/api/categories/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(400, 'Invalid category id');
  const e = validateCategoryName(req.body && req.body.name);
  if (e) throw new HttpError(400, 'Validation failed', [e]);
  const name = req.body.name.trim();
  const dup = await Category.findOne({
    _id: { $ne: req.params.id },
    name: new RegExp('^' + escapeRegex(name) + '$', 'i'),
  });
  if (dup) throw new HttpError(409, 'Another category with this name already exists');
  const cat = await Category.findByIdAndUpdate(req.params.id, { name }, { new: true, runValidators: true });
  if (!cat) throw new HttpError(404, 'Category not found');
  res.json(cat);
}));

app.delete('/api/categories/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(400, 'Invalid category id');
  const used = await Expense.countDocuments({ category: req.params.id });
  if (used > 0) throw new HttpError(409, `Cannot delete: ${used} expense(s) use this category. Move or delete them first.`);
  const cat = await Category.findByIdAndDelete(req.params.id);
  if (!cat) throw new HttpError(404, 'Category not found');
  res.json({ message: 'Category deleted' });
}));

// ----- Expenses -----
app.get('/api/expenses', wrap(async (req, res) => {
  const { search, category, paymentMethod, from, to } = req.query;
  const sortBy = ['date', 'amount', 'createdAt'].includes(req.query.sortBy) ? req.query.sortBy : 'date';
  const dir = req.query.order === 'asc' ? 1 : -1;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);

  const q = {};
  if (search && String(search).trim()) {
    const re = new RegExp(escapeRegex(String(search).trim()), 'i');
    const cats = await Category.find({ name: re }, '_id');
    q.$or = [{ description: re }, { category: { $in: cats.map((c) => c._id) } }];
  }
  if (category) {
    if (!isId(category)) throw new HttpError(400, 'Invalid category filter');
    q.category = category;
  }
  if (paymentMethod) {
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw new HttpError(400, 'Invalid payment method filter');
    q.paymentMethod = paymentMethod;
  }
  if (from || to) {
    q.date = {};
    if (from) {
      const d = parseDate(from);
      if (!d) throw new HttpError(400, 'Invalid "from" date');
      q.date.$gte = d;
    }
    if (to) {
      const d = parseDate(to);
      if (!d) throw new HttpError(400, 'Invalid "to" date');
      q.date.$lte = d;
    }
  }

  const [data, total] = await Promise.all([
    Expense.find(q)
      .populate('category', 'name')
      .sort({ [sortBy]: dir, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Expense.countDocuments(q),
  ]);
  res.json({ data, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) });
}));

app.get('/api/expenses/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(400, 'Invalid expense id');
  const e = await Expense.findById(req.params.id).populate('category', 'name');
  if (!e) throw new HttpError(404, 'Expense not found');
  res.json(e);
}));

app.post('/api/expenses', wrap(async (req, res) => {
  const { errors, out } = validateExpense(req.body);
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);
  await ensureCategoryExists(out.category);
  const created = await Expense.create(out);
  res.status(201).json(await created.populate('category', 'name'));
}));

app.put('/api/expenses/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(400, 'Invalid expense id');
  const { errors, out } = validateExpense(req.body);
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);
  await ensureCategoryExists(out.category);
  const updated = await Expense.findByIdAndUpdate(req.params.id, out, { new: true, runValidators: true })
    .populate('category', 'name');
  if (!updated) throw new HttpError(404, 'Expense not found');
  res.json(updated);
}));

app.delete('/api/expenses/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(400, 'Invalid expense id');
  const e = await Expense.findByIdAndDelete(req.params.id);
  if (!e) throw new HttpError(404, 'Expense not found');
  res.json({ message: 'Expense deleted' });
}));

// ----- Dashboard -----
app.get('/api/dashboard', wrap(async (req, res) => {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(today - ((now.getDay() + 6) % 7) * 86400000); // week starts Monday
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const sixStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 5, 1));

  const sum = (match = {}) =>
    Expense.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]);

  const [all, month, week, highest, byCat, monthlyRaw] = await Promise.all([
    sum(),
    sum({ date: { $gte: monthStart } }),
    sum({ date: { $gte: weekStart } }),
    Expense.findOne().sort({ amount: -1 }).populate('category', 'name'),
    Expense.aggregate([
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $lookup: { from: Category.collection.name, localField: '_id', foreignField: '_id', as: 'c' } },
      { $project: { _id: 0, category: { $ifNull: [{ $arrayElemAt: ['$c.name', 0] }, 'Unknown'] }, total: 1, count: 1 } },
      { $sort: { total: -1 } },
    ]),
    Expense.aggregate([
      { $match: { date: { $gte: sixStart } } },
      { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' } }, total: { $sum: '$amount' } } },
    ]),
  ]);

  const map = new Map(monthlyRaw.map((r) => [`${r._id.y}-${r._id.m}`, r.total]));
  const monthly = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 5 + i, 1));
    monthly.push({
      label: d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      total: round2(map.get(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`) || 0),
    });
  }

  const pick = (r) => ({ total: round2(r[0] ? r[0].total : 0), count: r[0] ? r[0].count : 0 });
  res.json({
    totalExpenses: pick(all).total,
    transactions: pick(all).count,
    currentMonth: pick(month).total,
    currentWeek: pick(week).total,
    highestExpense: highest,
    byCategory: byCat.map((c) => ({ ...c, total: round2(c.total) })),
    monthly,
  });
}));

// ---------- Error handling ----------
app.use((req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, errors: err.errors || [] });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
  if (err.name === 'ValidationError') {
    return res.status(400).json({ message: 'Validation failed', errors: Object.values(err.errors).map((e) => e.message) });
  }
  if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid value for ' + err.path });
  if (err.code === 11000) return res.status(409).json({ message: 'Duplicate value' });
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

// ---------- Start ----------
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');
    if ((await Category.countDocuments()) === 0) {
      await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ name })));
      console.log('Default categories seeded');
    }
    app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });