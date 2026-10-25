require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { MenuItem, Order, Counter, Event } = require('./models');
const { eims, errText, sourceSystemId } = require('./eims');

const app = express();
const RATE = { VAT15: 0.15, VAT0: 0, VATEX: 0 }; // only for the local estimate; EIMS totals win

/* ---------- helpers ---------- */
const info = (inv, error) => ({
  invoiceId: inv && inv.id, status: (inv && inv.status) || 'ERROR', documentNumber: inv && inv.documentNumber,
  irn: inv && inv.eims && inv.eims.irn, hasQr: !!(inv && inv.eims && inv.eims.hasQr),
  lastError: error || (inv && inv.delivery && inv.delivery.lastError) || null,
});

function invoicePayload(o, sourceSystemId, extra = {}) {
  const b2b = !!(o.customer && o.customer.tin);
  const c = o.customer || {};
  return {
    sourceSystemId, externalRef: o.number, docType: 'INV', transactionType: b2b ? 'B2B' : 'B2C',
    paymentMode: o.paymentMode,
    ...(b2b && { buyer: { tin: c.tin, legalName: c.legalName, ...(c.vatNumber && { vatNumber: c.vatNumber }), ...(c.phone && { phone: c.phone }) } }),
    items: o.items.map(i => ({
      natureOfSupplies: i.nature, itemCode: i.code, description: i.name,
      unitPrice: i.price.toFixed(2), quantity: String(i.qty), unit: 'PCS', taxCode: i.taxCode,
    })),
    ...extra,
  };
}

// create (idempotent on externalRef) -> reopen if rejected -> finalize/submit "now". Safe to call again after any failure.
async function pushInvoice(payload) {
  let r = await eims('POST', '/invoices', payload);          // 201 new, 200 = already exists
  if (r.status >= 400) return { error: errText(r) };
  let inv = r.body.data;
  if (inv.status === 'REJECTED') {
    r = await eims('POST', `/invoices/${inv.id}/reopen`);
    if (r.status === 200) inv = r.body.data;
  }
  if (inv.status === 'DRAFT') r = await eims('POST', `/invoices/${inv.id}/finalize`, { submit: 'now' });
  else if (inv.status === 'FINAL') r = await eims('POST', `/invoices/${inv.id}/submit`, { mode: 'now' });
  else r = { status: 200, body: { data: inv } };
  // 200 registered | 422 refused (data present) | 202 in progress (RETRY) -> all carry the invoice
  if (r.body && r.body.data) inv = r.body.data;
  return { inv, error: r.body && r.body.error ? errText(r) : null };
}

async function syncOrder(o) {
  try {
    const { inv, error } = await pushInvoice(invoicePayload(o, await sourceSystemId()));
    o.set('eims', info(inv, error));
    if (inv && inv.totalValue) { o.total = +inv.totalValue; o.tax = +inv.taxValue; }
  } catch (e) { // timeout / network: keep the order, retry later with the SAME externalRef
    o.set('eims.status', (o.eims && o.eims.status) || 'PENDING');
    o.set('eims.lastError', 'Network problem, press Retry: ' + e.message);
  }
  await o.save();
  return o;
}

/* ---------- webhook (raw body BEFORE express.json) ---------- */
app.post('/webhooks/eims', express.raw({ type: 'application/json' }), async (req, res) => {
  const ts = req.headers['x-eims-timestamp'];
  const raw = req.body.toString('utf8');
  const expected = 'v1=' + crypto.createHmac('sha256', process.env.EIMS_WEBHOOK_SECRET || '').update(`${ts}.${raw}`).digest('hex');
  const given = String(req.headers['x-eims-signature'] || '');
  const ok = ts && Math.abs(Date.now() / 1000 - Number(ts)) <= 300 && given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);
  res.sendStatus(204);                                   // answer fast, work afterwards
  const ev = JSON.parse(raw);
  try { await Event.create({ _id: ev.id }); } catch { return; } // already processed
  applyEvent(ev).catch(console.error);
});

async function applyEvent({ type, data: d }) {
  const ref = d.externalRef || '';
  if (type.startsWith('receipt.')) {
    return Order.updateOne({ number: ref.replace(/^PAY-/, '') },
      { $set: { 'receipt.status': d.status, 'receipt.rrn': d.rrn, 'receipt.lastError': d.lastError || null } });
  }
  if (!type.startsWith('invoice.') && type !== 'cancellation.rejected') return;
  const cn = ref.startsWith('CN-'), k = cn ? 'creditNote' : 'eims', set = {};
  if (d.status) set[`${k}.status`] = d.status;
  if (d.irn) set[`${k}.irn`] = d.irn;
  if (d.documentNumber) set[`${k}.documentNumber`] = d.documentNumber;
  if (type === 'invoice.registered') set[`${k}.hasQr`] = true;
  set[`${k}.lastError`] = d.lastError || d.attentionReason || d.message || null;
  await Order.updateOne({ number: cn ? ref.slice(3) : ref }, { $set: set });
  console.log('webhook', type, ref);
}

app.use(express.json());
app.use(express.static('public'));

/* ---------- EIMS status & look-ups ---------- */
app.get('/api/eims/status', async (_q, r) => {
  try {
    const [k, s] = await Promise.all([eims('GET', '/api-keys/current'), eims('GET', '/source-systems')]);
    r.json({ ok: k.status === 200, key: k.body && k.body.data, sources: s.body && s.body.data, error: k.status === 200 ? null : errText(k) });
  } catch (e) { r.json({ ok: false, error: e.message }); }
});
app.get('/api/lookups', async (_q, r) => { const x = await eims('GET', '/lookups'); r.status(x.status).json(x.body); });

/* ---------- menu ---------- */
app.get('/api/menu', async (_q, r) => r.json(await MenuItem.find().sort('category name')));
app.post('/api/menu', async (q, r) => r.status(201).json(await MenuItem.create(q.body)));
app.delete('/api/menu/:id', async (q, r) => { await MenuItem.findByIdAndDelete(q.params.id); r.sendStatus(204); });

/* ---------- orders ---------- */
app.post('/api/orders', async (q, r) => {
  const { items = [], table, cashierName, paymentMode, customer } = q.body;
  if (!items.length) return r.status(400).json({ error: 'The cart is empty' });
  if (customer && customer.tin && !customer.legalName) return r.status(400).json({ error: 'Customer name is required with a TIN' });
  const menu = await MenuItem.find({ _id: { $in: items.map(i => i.menuItemId) } });
  const lines = items.map(i => {
    const m = menu.find(x => x.id === i.menuItemId);
    return m && { code: m.code, name: m.name, price: m.price, qty: Math.max(1, parseInt(i.qty) || 1), taxCode: m.taxCode, nature: m.nature };
  }).filter(Boolean);
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const tax = lines.reduce((s, l) => s + l.price * l.qty * (RATE[l.taxCode] || 0), 0);
  const { n } = await Counter.findOneAndUpdate({ _id: 'order' }, { $inc: { n: 1 } }, { upsert: true, new: true });
  const o = await Order.create({
    number: `${process.env.ORDER_PREFIX || 'POS'}-${String(n).padStart(6, '0')}`, // this is the externalRef: never change it
    table, cashierName, paymentMode: paymentMode || 'CASH', customer: customer && customer.tin ? customer : undefined,
    items: lines, tax, total: sub + tax, eims: { status: 'PENDING' },
  });
  r.status(201).json(await syncOrder(o));
});

// List; in-flight documents are refreshed from EIMS so it works even without webhooks.
const IN_FLIGHT = ['RETRY', 'SUBMITTING', 'CANCEL_PENDING'];
app.get('/api/orders', async (_q, r) => {
  const list = await Order.find().sort('-createdAt').limit(50);
  await Promise.all(list.map(async o => {
    for (const k of ['eims', 'creditNote']) {
      const d = o[k];
      if (d && d.invoiceId && IN_FLIGHT.includes(d.status)) {
        const x = await eims('GET', `/invoices/${d.invoiceId}`).catch(() => null);
        if (x && x.body && x.body.data) { o.set(k, info(x.body.data)); await o.save(); }
      }
    }
  }));
  r.json(list);
});

app.post('/api/orders/:id/retry', async (q, r) => {
  const o = await Order.findById(q.params.id);
  r.json(['REGISTERED', 'CANCELLED'].includes(o.eims.status) ? o : await syncOrder(o));
});

app.post('/api/orders/:id/cancel', async (q, r) => {
  const o = await Order.findById(q.params.id);
  const x = await eims('POST', `/invoices/${o.eims.invoiceId}/cancel`, { reasonCode: parseInt(q.body.reasonCode) || 3, remark: q.body.remark });
  const inv = x.body && x.body.data && x.body.data.invoice;
  if (inv) o.set('eims', info(inv));
  else if (x.status === 202) o.set('eims.status', 'CANCEL_PENDING');
  if (x.status === 422 || (!inv && x.status !== 202)) o.set('eims.lastError', 'Cancel refused: ' + errText(x) + '. Issue a credit note instead.');
  await o.save(); r.json(o);
});

app.post('/api/orders/:id/refund', async (q, r) => { // credit note (CRE) related to the registered invoice
  const o = await Order.findById(q.params.id);
  if (o.eims.status !== 'REGISTERED' || !o.eims.irn) return r.status(409).json({ error: 'Only a registered invoice can be refunded' });
  const { inv, error } = await pushInvoice(invoicePayload(o, await sourceSystemId(), {
    externalRef: 'CN-' + o.number, docType: 'CRE', reason: q.body.reason || 'Customer refund', relatedDocument: o.eims.irn,
  }));
  o.set('creditNote', info(inv, error)); await o.save(); r.json(o);
});

app.post('/api/orders/:id/receipt', async (q, r) => { // sales receipt = payment received for the invoice
  const o = await Order.findById(q.params.id), b = q.body, amt = o.total.toFixed(2);
  let x = await eims('POST', '/receipts', {
    sourceSystemId: await sourceSystemId(), externalRef: 'PAY-' + o.number, reason: `Payment received for ${o.number}`,
    collectedAmount: amt, modeOfPayment: b.modeOfPayment || 'CASH', collectorName: b.collectorName,
    paymentServiceProvider: b.paymentServiceProvider, accountNumber: b.accountNumber, transactionNumber: b.transactionNumber,
    invoices: [{ invoiceId: o.eims.invoiceId, paymentCoverage: 'FULL', invoicePaidAmount: amt, totalAmount: amt }],
  });
  if (x.status >= 400) o.set('receipt', { status: 'ERROR', lastError: errText(x) });
  else {
    const id = x.body.data.id;
    x = await eims('POST', `/receipts/${id}/submit`, { mode: 'now' });
    const d = x.body && x.body.data;
    o.set('receipt', { receiptId: id, status: (d && d.status) || 'ERROR', rrn: d && d.eims && d.eims.rrn,
      lastError: (d && d.delivery && d.delivery.lastError) || (x.body && x.body.error ? errText(x) : null) });
  }
  await o.save(); r.json(o);
});

app.get('/api/orders/:id/qr', async (q, r) => { // QR proxied so the API key stays on the server
  const o = await Order.findById(q.params.id);
  const x = await eims('GET', `/invoices/${o.eims.invoiceId}/qr`);
  if (x.status !== 200) return r.sendStatus(404);
  r.type('png').send(x.body);
});

app.use((e, _q, r, _n) => { console.error(e); r.status(500).json({ error: e.message }); });

/* ---------- start ---------- */
const SEED = [
  ['DORO-WAT', 'Doro Wat', 'Food', 380], ['KITFO', 'Kitfo', 'Food', 420], ['TIBS', 'Beef Tibs', 'Food', 360],
  ['SHIRO', 'Shiro Tegabino', 'Food', 190], ['FIRFIR', 'Firfir', 'Food', 170], ['INJERA', 'Extra Injera', 'Food', 25],
  ['MACCHIATO', 'Macchiato', 'Drinks', 45], ['TEA', 'Spiced Tea', 'Drinks', 30], ['WATER', 'Water 0.5L', 'Drinks', 20], ['JUICE', 'Avocado Juice', 'Drinks', 90],
].map(([code, name, category, price]) => ({ code, name, category, price }));

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/restaurant_pos').then(async () => {
  if (!(await MenuItem.countDocuments())) await MenuItem.insertMany(SEED);
  app.listen(process.env.PORT || 3000, () => console.log('POS on http://localhost:' + (process.env.PORT || 3000)));
}).catch(e => { console.error(e); process.exit(1); });
