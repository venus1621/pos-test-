const { Schema, model } = require('mongoose');

const MenuItem = model('MenuItem', new Schema({
  code: { type: String, required: true, unique: true, maxlength: 15 }, // EIMS itemCode (max 15)
  name: { type: String, required: true, minlength: 3 },                // EIMS description (min 3)
  category: String,
  price: { type: Number, required: true },                             // price BEFORE VAT
  taxCode: { type: String, default: 'VAT15' },
  nature: { type: String, default: 'Goods' },                          // "Goods" or "Service"
}));

const docState = { invoiceId: String, status: String, documentNumber: String, irn: String, hasQr: Boolean, lastError: String };

const Order = model('Order', new Schema({
  number: { type: String, unique: true },   // also used as EIMS externalRef (idempotency key)
  table: String, cashierName: String, paymentMode: { type: String, default: 'CASH' },
  customer: { tin: String, legalName: String, vatNumber: String, phone: String },
  items: [{ code: String, name: String, price: Number, qty: Number, taxCode: String, nature: String }],
  total: Number, tax: Number,
  eims: docState,        // the invoice
  creditNote: docState,  // refund (docType CRE)
  receipt: { receiptId: String, status: String, rrn: String, lastError: String }, // sales receipt
}, { timestamps: true }));

const Counter = model('Counter', new Schema({ _id: String, n: Number }));
const Event = model('Event', new Schema({ _id: String }, { timestamps: true })); // webhook dedupe

module.exports = { MenuItem, Order, Counter, Event };
