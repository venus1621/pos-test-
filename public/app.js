const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RATE = { VAT15: 0.15 };               // estimate only; the final amounts come from EIMS
let menu = [], cart = {}, cat = 'All', orders = [];

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

/* ---------- printable customer copy: IRN + QR ---------- */
function printReceipt(id) {
  const o = orders.find(x => x._id === id) || null;
  const draw = o => {
    const w = window.open('', '_blank', 'width=380,height=640');
    w.document.write(`<title>${esc(o.number)}</title><body style="font:13px monospace;max-width:320px;margin:12px auto">
      <h3 style="text-align:center;margin:0">Restaurant POS</h3><p style="text-align:center">Tax invoice ${esc(o.eims.documentNumber)} · ${esc(o.number)}<br>Table ${esc(o.table || '-')}</p><hr>
      ${o.items.map(i => `<div style="display:flex;justify-content:space-between"><span>${i.qty} × ${esc(i.name)}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}<hr>
      <div style="display:flex;justify-content:space-between"><span>VAT</span><span>${money(o.tax)}</span></div>
      <div style="display:flex;justify-content:space-between"><b>TOTAL ETB</b><b>${money(o.total)}</b></div><hr>
      <div style="word-break:break-all">IRN: ${esc(o.eims.irn)}</div>
      <p style="text-align:center"><img src="${location.origin}/api/orders/${o._id}/qr" width="160" onload="print()"></p></body>`);
    w.document.close();
  };
  if (o) return draw(o);
  api('/orders').then(l => { orders = l; draw(l.find(x => x._id === id)); });
}

/* ---------- start ---------- */
(async () => { menu = await api('/menu'); renderMenu(); renderCart(); loadStatus(); })();
