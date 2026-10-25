const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RATE = { VAT15: 0.15 };               // estimate only; the final amounts come from EIMS
let menu = [], cart = {}, cat = 'All', orders = [];
let storeInfo = {
  name: 'Addis Bistro & Lounge',
  legalName: 'CLICKADDIS IT SOLUTION PLC',
  tin: '0101969836',
  vatNumber: '43256663343256663322',
  phone: '+251 937 609 277',
  address: 'Kirkos Sub-City, Bole Road, Addis Ababa',
};

async function api(path, opt = {}) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opt, body: opt.body && JSON.stringify(opt.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== b.dataset.view));
  if (b.dataset.view === 'orders') loadOrders();
});

/* ---------- EIMS badge + payment modes ---------- */
async function loadStatus() {
  const badge = $('#eimsBadge');
  try {
    const s = await api('/eims/status');
    if (s.store) storeInfo = Object.assign(storeInfo, s.store);
    badge.className = 'pill ' + (s.ok ? 's-ok' : 's-bad');
    badge.textContent = s.ok ? `EIMS connected · ${s.key.company.legalName} · ${s.key.role}` : 'EIMS: ' + s.error;
    if (s.ok && s.key.role !== 'OPERATOR') badge.textContent += ' (read only, cannot register)';
  } catch (e) { badge.className = 'pill s-bad'; badge.textContent = 'EIMS unreachable'; }
  try {
    const l = await api('/lookups');
    const modes = (l.data.paymentModes || []).filter(m => m.length <= 18); // invoice paymentMode max 18 chars
    $('#pay').innerHTML = modes.map(m => `<option>${esc(m)}</option>`).join('');
  } catch {}
}

/* ---------- menu & cart ---------- */
function renderMenu() {
  const cats = ['All', ...new Set(menu.map(m => m.category))];
  $('#cats').innerHTML = cats.map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $('#grid').innerHTML = menu.filter(m => cat === 'All' || m.category === cat)
    .map(m => `<button class="item" data-id="${m._id}"><b>${esc(m.name)}</b><span>${money(m.price)} ETB</span></button>`).join('');
}
$('#cats').onclick = e => { if (e.target.dataset.c) { cat = e.target.dataset.c; renderMenu(); } };
$('#grid').onclick = e => { const b = e.target.closest('.item'); if (b) { cart[b.dataset.id] = (cart[b.dataset.id] || 0) + 1; renderCart(); } };
$('#lines').onclick = e => {
  const id = e.target.dataset.id; if (!id) return;
  cart[id] += +e.target.dataset.d; if (cart[id] <= 0) delete cart[id]; renderCart();
};

function renderCart() {
  let sub = 0, vat = 0;
  const rows = Object.entries(cart);
  $('#lines').innerHTML = rows.length ? rows.map(([id, q]) => {
    const m = menu.find(x => x._id === id), t = m.price * q;
    sub += t; vat += t * (RATE[m.taxCode] || 0);
    return `<li><span>${esc(m.name)}</span><span class="qty"><button data-d="-1" data-id="${id}">−</button>${q}<button data-d="1" data-id="${id}">+</button></span><span>${money(t)}</span></li>`;
  }).join('') : '<li class="empty">Tap a dish to start an order.</li>';
  $('#sub').textContent = money(sub); $('#vat').textContent = money(vat); $('#tot').textContent = money(sub + vat);
  $('#charge').disabled = !rows.length;
}

$('#b2b').onchange = e => $('#b2bFields').classList.toggle('hidden', !e.target.checked);
$('#cashier').value = localStorage.getItem('cashier') || '';

$('#charge').onclick = async () => {
  const btn = $('#charge'), box = $('#result');
  btn.disabled = true; btn.textContent = 'Registering with EIMS…';
  box.classList.add('hidden');
  localStorage.setItem('cashier', $('#cashier').value);
  try {
    const o = await api('/orders', { method: 'POST', body: {
      items: Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty })),
      table: $('#table').value, cashierName: $('#cashier').value, paymentMode: $('#pay').value,
      customer: $('#b2b').checked ? { tin: $('#tin').value.trim(), legalName: $('#cname').value.trim(), vatNumber: $('#vatno').value.trim() } : undefined,
    } });
    cart = {}; renderCart();
    const ok = o.eims.status === 'REGISTERED';
    box.innerHTML = `<b>${esc(o.number)}</b> · ${money(o.total)} ETB <span class="pill s-${o.eims.status}">${o.eims.status}</span>` +
      (ok ? `<div class="irn">IRN ${esc(o.eims.irn)}</div><div class="acts"><button onclick="printReceipt('${o._id}')">Print receipt</button></div>`
          : `<div class="err">${esc(o.eims.lastError || 'Waiting for the Ministry. The server keeps trying; check the Orders tab.')}</div>`);
  } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  box.classList.remove('hidden');
  btn.textContent = 'Charge and register'; btn.disabled = !Object.keys(cart).length;
};

/* ---------- orders ---------- */
const pill = d => d && d.status ? `<span class="pill s-${d.status}">${d.status.replace('_', ' ')}</span>` : '';
function renderOrders() {
  $('#noOrders').classList.toggle('hidden', !!orders.length);
  $('#orderRows').innerHTML = orders.map(o => {
    const st = o.eims.status, cn = o.creditNote || {}, rc = o.receipt || {};
    const acts = [];
    if (st === 'REGISTERED') {
      acts.push(['print', 'Print']);
      if (!rc.status || rc.status === 'ERROR' || rc.status === 'REJECTED') acts.push(['receipt', 'Payment receipt']);
      if (!cn.status) { acts.push(['cancel', 'Cancel']); acts.push(['refund', 'Credit note']); }
      else if (['ERROR', 'REJECTED', 'DRAFT'].includes(cn.status)) acts.push(['refund', 'Retry credit note']);
    } else if (!['RETRY', 'SUBMITTING', 'CANCEL_PENDING', 'CANCELLED'].includes(st)) acts.push(['retry', 'Retry']);
    return `<tr>
      <td><b>${esc(o.number)}</b><br><small>${new Date(o.createdAt).toLocaleString()}</small></td>
      <td>${esc(o.table || '-')}</td><td>${money(o.total)}</td>
      <td>${pill(o.eims)} ${cn.status ? 'Credit note ' + pill(cn) : ''} ${rc.status ? 'Receipt ' + pill(rc) : ''}
        ${o.eims.irn ? `<div class="irn">${esc(o.eims.irn)}</div>` : ''}
        ${[o.eims.lastError, cn.lastError, rc.lastError].filter(Boolean).map(t => `<div class="err">${esc(t)}</div>`).join('')}</td>
      <td class="acts">${acts.map(([a, l]) => `<button data-a="${a}" data-id="${o._id}">${l}</button>`).join('')}</td></tr>`;
  }).join('');
}
async function loadOrders() { try { orders = await api('/orders'); renderOrders(); } catch (e) { console.error(e); } }
setInterval(() => { if (!$('#orders').classList.contains('hidden')) loadOrders(); }, 8000);

$('#orderRows').onclick = async e => {
  const { a, id } = e.target.dataset; if (!a) return;
  const body = {};
  if (a === 'print') return printReceipt(id);
  if (a === 'cancel') {
    const c = prompt('Cancel reason: 1 duplicate, 2 data entry mistake, 3 order cancelled, 4 other', '3'); if (!c) return;
    body.reasonCode = c; body.remark = prompt('Remark (optional)') || undefined;
  }
  if (a === 'refund') { body.reason = prompt('Reason for the credit note', 'Customer refund'); if (!body.reason) return; }
  if (a === 'receipt') {
    body.collectorName = prompt('Collector name', $('#cashier').value); if (!body.collectorName) return;
    body.paymentServiceProvider = prompt('Bank or provider', 'Commercial Bank of Ethiopia');
    body.accountNumber = prompt('Account number');
    body.transactionNumber = prompt('Transaction reference');
    body.modeOfPayment = 'Local Bank Transfer';
    if (!body.paymentServiceProvider || !body.accountNumber || !body.transactionNumber) return alert('All fields are required.');
  }
  e.target.disabled = true;
  try { await api(`/orders/${id}/${a}`, { method: 'POST', body }); } catch (err) { alert(err.message); }
  loadOrders();
};

/* ---------- professional printable customer copy: IRN + QR ---------- */
function printReceipt(id) {
  const o = orders.find(x => x._id === id) || null;
  const draw = o => {
    if (!o) return;
    const w = window.open('', '_blank', 'width=420,height=760');
    const createdDate = new Date(o.createdAt || Date.now()).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
    const subtotal = Math.max(0, (o.total || 0) - (o.tax || 0));
    const isRegistered = o.eims && o.eims.status === 'REGISTERED';
    const hasQr = !!(o.eims && (o.eims.hasQr || o.eims.irn));
    const customer = o.customer || {};

    w.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(o.number)}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 14px 10px;
    background: #eef2f6;
    font-family: 'Courier New', Courier, Consolas, monospace;
    font-size: 12px; line-height: 1.35; color: #111;
    display: flex; flex-direction: column; align-items: center;
    -webkit-font-smoothing: antialiased;
  }
  .toolbar {
    width: 100%; max-width: 320px; margin-bottom: 12px;
    display: flex; gap: 8px;
  }
  .toolbar button {
    flex: 1; padding: 9px 12px; font-size: 13px; font-weight: 700;
    border: none; border-radius: 6px; cursor: pointer;
    box-shadow: 0 2px 4px rgba(0,0,0,0.12);
  }
  .btn-print { background: #0f172a; color: #fff; }
  .btn-close { background: #fff; color: #333; border: 1px solid #cbd5e1 !important; }
  .btn-print:hover { background: #1e293b; }
  .btn-close:hover { background: #f1f5f9; }

  .receipt-card {
    width: 100%; max-width: 320px; background: #fff;
    padding: 18px 14px; border-radius: 4px;
    box-shadow: 0 4px 18px rgba(0,0,0,0.08);
  }
  @media print {
    body { background: transparent !important; padding: 0 !important; }
    .toolbar { display: none !important; }
    .receipt-card {
      max-width: 100% !important; width: 100% !important;
      padding: 0 !important; box-shadow: none !important; border-radius: 0 !important;
    }
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: bold; }
  .store-title {
    font-size: 16px; font-weight: 900; letter-spacing: 0.5px;
    text-transform: uppercase; margin: 0 0 2px 0;
  }
  .store-legal { font-size: 11px; font-weight: 700; color: #333; margin-bottom: 2px; }
  .store-meta { font-size: 10.5px; color: #444; line-height: 1.3; }
  .doc-type {
    display: inline-block; margin: 8px 0; padding: 3px 8px;
    border: 1.5px solid #000; font-size: 11px; font-weight: 800;
    letter-spacing: 0.5px; text-transform: uppercase;
  }
  .divider { border: none; border-top: 1px dashed #444; margin: 8px 0; }
  .divider-double { border: none; border-top: 2px double #000; margin: 8px 0; }
  
  .meta-table { width: 100%; font-size: 11px; border-collapse: collapse; margin: 4px 0; }
  .meta-table td { padding: 1.5px 0; vertical-align: top; }
  .meta-table .lbl { color: #555; width: 38%; }
  .meta-table .val { font-weight: 700; text-align: right; }

  .items-table { width: 100%; font-size: 11.5px; border-collapse: collapse; margin: 6px 0; }
  .items-table th { border-bottom: 1px dashed #000; padding: 4px 0; font-weight: 800; }
  .items-table td { padding: 3px 0 1px 0; vertical-align: top; }
  .item-desc { font-weight: 700; word-break: break-word; }
  .item-sub { color: #555; font-size: 10.5px; }

  .summary-table { width: 100%; font-size: 11.5px; border-collapse: collapse; margin: 6px 0; }
  .summary-table td { padding: 2px 0; }
  .total-row td {
    font-size: 14.5px; font-weight: 900; padding: 6px 0;
    border-top: 1px dashed #000; border-bottom: 2px double #000;
  }

  .fiscal-box {
    border: 1px solid #111; border-radius: 4px;
    padding: 8px 6px; margin: 10px 0 6px 0;
    text-align: center; background: #fafafa;
  }
  .fiscal-heading {
    font-size: 10.5px; font-weight: 800; letter-spacing: 0.5px;
    text-transform: uppercase; margin-bottom: 4px; color: #111;
  }
  .status-tag {
    display: inline-block; padding: 1px 6px; font-size: 10px; font-weight: 800;
    background: #0f172a; color: #fff; border-radius: 3px; margin-bottom: 4px;
  }
  .irn-box {
    font-size: 9px; font-family: Consolas, monospace; word-break: break-all;
    background: #fff; border: 1px dashed #94a3b8; padding: 4px; margin: 5px 0;
    text-align: left;
  }
  .qr-wrap { margin: 6px 0; }
  .qr-wrap img { width: 135px; height: 135px; image-rendering: pixelated; }
  .qr-caption { font-size: 9.5px; color: #555; margin-top: 2px; }

  .footer-msg {
    text-align: center; font-size: 11px; font-weight: 700;
    margin: 12px 0 2px 0; color: #222;
  }
  .sub-footer { text-align: center; font-size: 9.5px; color: #64748b; margin-top: 4px; }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-print" onclick="window.print()">🖨️ Print Receipt</button>
    <button class="btn-close" onclick="window.close()">✕ Close</button>
  </div>

  <div class="receipt-card">
    <div class="center">
      <div class="store-title">${esc(storeInfo.name)}</div>
      <div class="store-legal">${esc(storeInfo.legalName)}</div>
      <div class="store-meta">TIN: <b>${esc(storeInfo.tin)}</b> · VAT: <b>${esc(storeInfo.vatNumber)}</b></div>
      <div class="store-meta">${esc(storeInfo.address)}</div>
      <div class="store-meta">Tel: ${esc(storeInfo.phone)}</div>
      <div class="doc-type">Official Tax Invoice</div>
    </div>

    <hr class="divider">

    <table class="meta-table">
      <tr><td class="lbl">Order Ref:</td><td class="val">${esc(o.number)}</td></tr>
      <tr><td class="lbl">FS / Doc No:</td><td class="val">${esc((o.eims && o.eims.documentNumber) || o.number)}</td></tr>
      <tr><td class="lbl">Date & Time:</td><td class="val">${esc(createdDate)}</td></tr>
      <tr><td class="lbl">Table:</td><td class="val">${esc(o.table || 'Walk-in / Takeaway')}</td></tr>
      <tr><td class="lbl">Cashier:</td><td class="val">${esc(o.cashierName || 'Cashier')}</td></tr>
      ${customer.legalName ? `<tr><td class="lbl">Customer:</td><td class="val">${esc(customer.legalName)}</td></tr>` : ''}
      ${customer.tin ? `<tr><td class="lbl">Buyer TIN:</td><td class="val">${esc(customer.tin)}</td></tr>` : ''}
    </table>

    <hr class="divider-double">

    <table class="items-table">
      <thead>
        <tr>
          <th style="text-align:left">Description</th>
          <th class="right" style="width:25%">Total ETB</th>
        </tr>
      </thead>
      <tbody>
        ${o.items.map(i => `
          <tr>
            <td class="item-desc">${esc(i.name)}</td>
            <td class="right bold">${money(i.price * i.qty)}</td>
          </tr>
          <tr>
            <td colspan="2" class="item-sub">${i.qty} × ${money(i.price)} ETB &nbsp;[VAT 15%]</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <hr class="divider">

    <table class="summary-table">
      <tr>
        <td>Subtotal (Taxable):</td>
        <td class="right">${money(subtotal)} ETB</td>
      </tr>
      <tr>
        <td>VAT (15%):</td>
        <td class="right">${money(o.tax)} ETB</td>
      </tr>
      <tr class="total-row">
        <td>TOTAL:</td>
        <td class="right">${money(o.total)} ETB</td>
      </tr>
      <tr>
        <td style="padding-top:5px; color:#555">Payment Mode:</td>
        <td class="right bold" style="padding-top:5px">${esc(o.paymentMode || 'CASH')}</td>
      </tr>
    </table>

    <div class="fiscal-box">
      <div class="fiscal-heading">Ministry of Revenues · EIMS</div>
      <div class="status-tag">${isRegistered ? 'REGISTERED & VERIFIED' : esc((o.eims && o.eims.status) || 'PENDING')}</div>
      ${o.eims && o.eims.irn ? `<div class="irn-box"><b>IRN:</b> ${esc(o.eims.irn)}</div>` : ''}
      ${hasQr ? `
        <div class="qr-wrap">
          <img src="${location.origin}/api/orders/${o._id}/qr" alt="EIMS Fiscal QR" onload="setTimeout(() => window.print(), 350)">
        </div>
        <div class="qr-caption">Scan QR to verify invoice with MoR EIMS</div>
      ` : `
        <div class="qr-caption" style="margin-top:4px">Invoice registered with ClickAddis EIMS</div>
      `}
    </div>

    <div class="footer-msg">Thank you for dining with us!</div>
    <div class="center" style="font-size:10px; color:#444">Please come again</div>
    <div class="sub-footer">ClickAddis EIMS Electronic POS · Solution Certified</div>
  </div>
</body>
</html>`);
    w.document.close();
  };
  if (o) return draw(o);
  api('/orders').then(l => { orders = l; draw(l.find(x => x._id === id)); });
}

/* ---------- start ---------- */
(async () => { menu = await api('/menu'); renderMenu(); renderCart(); loadStatus(); })();
