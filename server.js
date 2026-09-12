require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || '';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENVIRONMENT = String(process.env.PAYPAL_ENVIRONMENT || '').trim().toLowerCase();
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ORDER_EMAIL_TO = process.env.ORDER_EMAIL_TO || 'Lostsignal320@gmail.com';
const ORDER_EMAIL_FROM = process.env.ORDER_EMAIL_FROM || 'orders@lostsignal.dev';
const NEWSLETTER_EMAIL_FROM = process.env.NEWSLETTER_EMAIL_FROM || ORDER_EMAIL_FROM;
const NEWSLETTER_ADMIN_TOKEN = process.env.NEWSLETTER_ADMIN_TOKEN;
const UPS_SHIPPING_MODE = String(process.env.UPS_SHIPPING_MODE || '').trim().toUpperCase();
const UPS_TEST_SHIPPING_RATE = Number(process.env.UPS_TEST_SHIPPING_RATE || 10);
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;
const UPS_ACCOUNT_NUMBER = process.env.UPS_ACCOUNT_NUMBER;
const ORDER_EMAIL_DEDUPE = new Set();
const DATA_DIR = path.join(__dirname, 'data');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'newsletter-subscribers.json');
const COUPONS_FILE = path.join(DATA_DIR, 'coupons.json');
const NEWSLETTERS_FILE = path.join(DATA_DIR, 'newsletters.json');

const isProductionDeployment = process.env.CONTEXT === 'production' || process.env.NODE_ENV === 'production';
const isSandbox = PAYPAL_ENVIRONMENT === 'sandbox';
const PAYPAL_API_BASE = isSandbox
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

function getConfigurationError({ requirePayPal = false, requireUps = false } = {}) {
  if (!['sandbox', 'production'].includes(PAYPAL_ENVIRONMENT)) {
    return 'PayPal environment configuration is missing or invalid.';
  }

  if (isProductionDeployment && PAYPAL_ENVIRONMENT !== 'production') {
    return 'PayPal production configuration is missing.';
  }

  if (requirePayPal && (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)) {
    return 'PayPal configuration is incomplete.';
  }

  if (!['TEST', 'LIVE'].includes(UPS_SHIPPING_MODE)) {
    return 'UPS shipping mode configuration is missing or invalid.';
  }

  if (isProductionDeployment && UPS_SHIPPING_MODE !== 'LIVE') {
    return 'UPS production configuration is missing.';
  }

  if (requireUps && UPS_SHIPPING_MODE === 'LIVE' && (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET || !UPS_ACCOUNT_NUMBER)) {
    return 'UPS production configuration is incomplete.';
  }

  return null;
}

const PRODUCT_CATALOG = {
  1: { id: 1, name: 'Dead Air Shell', price: 168 },
  2: { id: 2, name: 'Off-Grid Knit', price: 94 },
  3: { id: 3, name: 'Null Cargo', price: 132 },
  4: { id: 4, name: 'Low Frequency Tee', price: 58 },
  test: { id: 'test', name: 'Test Signal', price: 29 }
};

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      FRONTEND_URL,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:8888',
      'http://127.0.0.1:8888',
      'http://localhost:3999',
      'http://127.0.0.1:3999'
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin is not allowed by the server CORS policy.'));
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function readDataFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeDataFile(filePath, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function requireNewsletterAdmin(req, res, next) {
  if (!NEWSLETTER_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Newsletter admin is not configured.' });
  }

  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token !== NEWSLETTER_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized newsletter admin request.' });
  }

  return next();
}

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || 'Unable to get PayPal access token');
  }

  return data.access_token;
}

function dedupeKeyForOrder(orderId = '') {
  return String(orderId).trim();
}

function sanitizeText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim() || fallback;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatPayPalAddress(address = {}) {
  if (!address || typeof address !== 'object') {
    return 'Not provided';
  }

  const line1 = sanitizeText(address.address_line_1, '');
  const city = sanitizeText(address.admin_area_2, '');
  const state = sanitizeText(address.admin_area_1, '');
  const postal = sanitizeText(address.postal_code, '');
  const country = sanitizeText(address.country_code, '');

  const cityLine = city ? city : '';
  const stateLine = state ? state : '';
  const postalLine = postal ? postal : '';
  const localityParts = [cityLine, stateLine, postalLine].filter(Boolean);
  const combinedLocality = localityParts.length ? (
    localityParts.length === 1
      ? localityParts[0]
      : localityParts.length === 2
        ? `${localityParts[0]}, ${localityParts[1]}`
        : `${localityParts[0]}, ${localityParts[1]} ${localityParts[2]}`
  ) : '';
  const parts = [line1, combinedLocality, country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Not provided';
}

function buildOrderEmailPayload(paypalData = {}, fallback = {}) {
  const purchaseUnit = Array.isArray(paypalData.purchase_units) ? paypalData.purchase_units[0] || {} : {};
  const amount = purchaseUnit.amount || {};
  const breakdown = amount.breakdown || {};
  const orderIdValue = sanitizeText(paypalData.id || paypalData.orderId || fallback.orderId, 'N/A');

  const normalizedItems = Array.isArray(purchaseUnit.items)
    ? purchaseUnit.items.map((item, index) => {
        const quantity = safeNumber(item.quantity, 1);
        const unitValue = safeNumber(item.unit_amount?.value || item.amount?.value, 0);
        return {
          name: sanitizeText(item.name, `Item ${index + 1}`),
          quantity,
          unitPrice: Number(unitValue.toFixed(2)),
          price: Number((unitValue * quantity).toFixed(2))
        };
      })
    : [];

  const subtotalValue = safeNumber(breakdown.item_total?.value || amount.value || 0, 0);
  const shippingValue = safeNumber(breakdown.shipping?.value, 0);
  const taxValue = safeNumber(breakdown.tax_total?.value, 0);
  const totalValue = safeNumber(amount.value || subtotalValue + shippingValue + taxValue, 0);

  const shippingAddress = sanitizeText(fallback.shippingAddress, 'Not provided');
  const payPalAddress = purchaseUnit.shipping?.address ? formatPayPalAddress(purchaseUnit.shipping.address) : 'Not provided';

  return {
    subject: 'New Lost Signal Order',
    orderId: orderIdValue,
    paypalOrderId: orderIdValue,
    paymentStatus: sanitizeText(paypalData.status || fallback.status, 'UNKNOWN'),
    customerName: sanitizeText(fallback.customerName, 'Guest'),
    customerEmail: sanitizeText(fallback.customerEmail, 'Not provided'),
    shippingAddress: shippingAddress !== 'Not provided' ? shippingAddress : payPalAddress,
    subtotal: subtotalValue.toFixed(2),
    shippingCost: shippingValue.toFixed(2),
    tax: taxValue.toFixed(2),
    total: totalValue.toFixed(2),
    currency: sanitizeText(amount.currency_code || 'USD', 'USD'),
    date: new Date().toISOString(),
    items: normalizedItems.length ? normalizedItems : (Array.isArray(fallback.items) ? fallback.items.map((item) => ({
      name: sanitizeText(item.name, 'Product'),
      quantity: safeNumber(item.quantity, 1),
      unitPrice: safeNumber(item.price, 0),
      price: safeNumber(item.price, 0) * safeNumber(item.quantity, 1)
    })) : [])
  };
}

function normalizeCartItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    throw new Error('Invalid cart payload');
  }

  return rawItems.map((item) => {
    const product = PRODUCT_CATALOG[item.id];
    if (!product) {
      throw new Error(`Unknown product: ${item.id}`);
    }

    const quantity = Number(item.quantity || 1);
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new Error(`Invalid quantity for product ${item.id}`);
    }

    return {
      id: product.id,
      name: product.name,
      unitPrice: Number(product.price),
      quantity,
      currency: 'USD'
    };
  });
}

function calculateCartTotal(items) {
  return items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
}

function findCoupon(code, subtotal, now = new Date(), couponCatalog = readDataFile(COUPONS_FILE, [])) {
  const normalizedCode = sanitizeText(code, '').toUpperCase();
  if (!normalizedCode) {
    return { coupon: null, discount: 0, subtotal };
  }

  const coupon = couponCatalog.find((item) => item.code?.toUpperCase() === normalizedCode);
  if (!coupon || coupon.active === false) {
    throw new Error('Invalid or inactive discount code.');
  }

  const currentTime = now.getTime();
  if (coupon.startsAt && currentTime < new Date(coupon.startsAt).getTime()) {
    throw new Error('This discount code is not active yet.');
  }
  if (coupon.endsAt && currentTime > new Date(coupon.endsAt).getTime()) {
    throw new Error('This discount code has expired.');
  }

  const minimumPurchase = safeNumber(coupon.minimumPurchase ?? coupon.minPurchase, 0);
  if (subtotal < minimumPurchase) {
    throw new Error(`This code requires a minimum purchase of $${minimumPurchase.toFixed(2)}.`);
  }

  const requestedDiscount = coupon.type === 'fixed'
    ? safeNumber(coupon.amount, 0)
    : subtotal * (safeNumber(coupon.amount, 0) / 100);
  const maximumDiscount = safeNumber(coupon.maximumDiscount ?? coupon.maxDiscount, 0);
  const discount = Math.min(requestedDiscount, maximumDiscount > 0 ? maximumDiscount : requestedDiscount, subtotal);

  return {
    coupon,
    discount: Number(discount.toFixed(2)),
    subtotal: Number(subtotal.toFixed(2)),
    total: Number((subtotal - discount).toFixed(2))
  };
}

function calculateOrderAmounts(items, couponCode = '') {
  const subtotal = Number(calculateCartTotal(items).toFixed(2));
  const appliedCoupon = findCoupon(couponCode, subtotal);
  return {
    subtotal,
    discount: appliedCoupon.discount,
    total: Number((subtotal - appliedCoupon.discount).toFixed(2)),
    coupon: appliedCoupon.coupon
  };
}

function calculateRefundSummary({
  items = [],
  discount = 0,
  shippingCost = 0,
  returnedItems = [],
  policy = {},
  reason = 'customer_preference'
}) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeReturnedItems = Array.isArray(returnedItems) ? returnedItems : [];
  const baseDiscount = safeNumber(discount, 0);
  const baseShippingCost = safeNumber(shippingCost, 0);
  const policySettings = {
    originalShippingNonRefundable: true,
    shippingRefundableForError: false,
    discountRefundableAsCash: false,
    ...policy
  };

  const itemRefund = safeReturnedItems.reduce((sum, item) => {
    const quantity = safeNumber(item.quantity, 1);
    const unitPrice = safeNumber(item.unitPrice ?? item.price, 0);
    const discountAllocated = safeNumber(item.discountAllocated ?? item.discount ?? 0, 0);
    const itemAmount = Number((unitPrice * quantity).toFixed(2));
    const discountedAmount = Math.max(0, Number((itemAmount - discountAllocated).toFixed(2)));
    return Number((sum + discountedAmount).toFixed(2));
  }, 0);

  const eligibleShippingRefund = (() => {
    if (!baseShippingCost) {
      return 0;
    }

    const isCustomerPreference = ['customer_preference', 'change_of_mind', 'wrong_size', 'wrong_item', 'incorrect_size', 'customer_choice'].includes(String(reason).toLowerCase());
    if (isCustomerPreference) {
      return 0;
    }

    if (policySettings.originalShippingNonRefundable === true) {
      return 0;
    }

    if (policySettings.shippingRefundableForError === true) {
      return Number(baseShippingCost.toFixed(2));
    }

    return 0;
  })();

  const finalRefund = Number((itemRefund + eligibleShippingRefund).toFixed(2));

  return {
    originalItemTotal: Number(safeItems.reduce((sum, item) => sum + safeNumber(item.unitPrice ?? item.price, 0) * safeNumber(item.quantity, 1), 0).toFixed(2)),
    discount: Number(baseDiscount.toFixed(2)),
    returnedItemAmount: Number(itemRefund.toFixed(2)),
    discountedItemAmount: Number(itemRefund.toFixed(2)),
    originalShipping: Number(baseShippingCost.toFixed(2)),
    eligibleShippingRefund: Number(eligibleShippingRefund.toFixed(2)),
    itemRefund: Number(itemRefund.toFixed(2)),
    finalRefund: Number(finalRefund.toFixed(2)),
    policy: {
      originalShippingNonRefundable: Boolean(policySettings.originalShippingNonRefundable),
      shippingRefundableForError: Boolean(policySettings.shippingRefundableForError),
      discountRefundableAsCash: Boolean(policySettings.discountRefundableAsCash)
    }
  };
}

function selectCheapestEligibleShipment(rates = []) {
  const eligible = Array.isArray(rates)
    ? rates.filter((rate) => {
        const cost = safeNumber(rate.cost, 0);
        const carrier = sanitizeText(rate.carrier, '');
        const service = sanitizeText(rate.service, '');
        return cost > 0 && carrier && service;
      })
    : [];

  if (!eligible.length) {
    return null;
  }

  const chosen = eligible.sort((a, b) => safeNumber(a.cost, 0) - safeNumber(b.cost, 0))[0];
  return {
    carrier: sanitizeText(chosen.carrier, 'UPS'),
    service: sanitizeText(chosen.service, 'TEST'),
    cost: Number(safeNumber(chosen.cost, 0).toFixed(2)),
    raw: chosen
  };
}

function buildUpsShippingRate({
  carrier = 'UPS',
  service = 'TEST',
  amount = UPS_TEST_SHIPPING_RATE,
  currency = 'USD',
  estimatedDays = null,
  isTestRate = UPS_SHIPPING_MODE === 'TEST'
} = {}) {
  const normalizedAmount = Number(safeNumber(amount, UPS_TEST_SHIPPING_RATE).toFixed(2));
  return {
    carrier: sanitizeText(carrier, 'UPS'),
    service: sanitizeText(service, 'TEST'),
    amount: normalizedAmount,
    currency: sanitizeText(currency, 'USD'),
    estimatedDays: estimatedDays === undefined || estimatedDays === null ? null : Number(estimatedDays),
    isTestRate: Boolean(isTestRate),
    isLiveRate: !Boolean(isTestRate)
  };
}

function getShippingRateConfigStatus() {
  return {
    provider: 'UPS',
    mode: UPS_SHIPPING_MODE === 'TEST' ? 'TEST' : 'LIVE',
    isTestMode: UPS_SHIPPING_MODE === 'TEST',
    rate: Number(UPS_TEST_SHIPPING_RATE.toFixed(2)),
    requiresCredentials: Boolean(!UPS_CLIENT_ID || !UPS_CLIENT_SECRET || !UPS_ACCOUNT_NUMBER),
    supportsLiveUpsApi: Boolean(UPS_CLIENT_ID && UPS_CLIENT_SECRET && UPS_ACCOUNT_NUMBER),
    payPalRefundsConfigured: Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET)
  };
}

async function fetchCarrierRates({ items = [], destination = {}, origin = {} } = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const destinationPostal = sanitizeText(destination.postalCode || destination.zip || '', '');

  if (!normalizedItems.length || !destinationPostal) {
    return [];
  }

  const testRate = buildUpsShippingRate({
    carrier: 'UPS',
    service: 'TEST',
    amount: UPS_TEST_SHIPPING_RATE,
    isTestRate: UPS_SHIPPING_MODE === 'TEST'
  });

  if (UPS_SHIPPING_MODE === 'TEST') {
    return [{
      carrier: testRate.carrier,
      service: testRate.service,
      cost: testRate.amount,
      currency: testRate.currency,
      estimatedDays: testRate.estimatedDays,
      isTestRate: testRate.isTestRate,
      raw: testRate
    }];
  }

  if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET || !UPS_ACCOUNT_NUMBER) {
    throw new Error('UPS production configuration is incomplete.');
  }

  return [];
}

async function resolveShippingQuote({ items = [], destination = {}, origin = {} } = {}) {
  const trustedItems = Array.isArray(items) ? normalizeCartItems(items) : [];
  const rates = await fetchCarrierRates({ items: trustedItems, destination, origin });
  const selected = selectCheapestEligibleShipment(rates);

  if (!selected && UPS_SHIPPING_MODE === 'LIVE') {
    throw new Error('UPS production shipping rates are unavailable.');
  }

  const resolved = selected || {
    carrier: 'UPS',
    service: 'TEST',
    cost: Number(UPS_TEST_SHIPPING_RATE.toFixed(2)),
    raw: buildUpsShippingRate({ amount: UPS_TEST_SHIPPING_RATE, service: 'TEST', isTestRate: true })
  };

  return {
    carrier: sanitizeText(resolved.carrier, 'UPS'),
    service: sanitizeText(resolved.service, 'TEST'),
    cost: Number(safeNumber(resolved.cost, UPS_TEST_SHIPPING_RATE).toFixed(2)),
    currency: 'USD',
    estimatedDays: null,
    isTestRate: UPS_SHIPPING_MODE === 'TEST' || !UPS_CLIENT_ID || !UPS_CLIENT_SECRET || !UPS_ACCOUNT_NUMBER,
    raw: resolved.raw || buildUpsShippingRate({ amount: resolved.cost, service: resolved.service, isTestRate: true })
  };
}

function createTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

async function sendOrderEmail(orderData) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn('Order email skipped: SMTP credentials not configured.');
    return { ok: true, skipped: true };
  }

  const itemRows = (orderData.items || []).map((item) => {
    const quantity = safeNumber(item.quantity, 1);
    const unitPrice = safeNumber(item.unitPrice ?? item.price, 0);
    const totalLine = Number((unitPrice * quantity).toFixed(2));
    return `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #e9e2d6;">${sanitizeText(item.name, 'Product')}</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #e9e2d6; text-align: center;">${quantity}</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #e9e2d6; text-align: right;">$${unitPrice.toFixed(2)}</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #e9e2d6; text-align: right;">$${totalLine.toFixed(2)}</td>
      </tr>
    `;
  }).join('');

  const mail = {
    from: ORDER_EMAIL_FROM,
    to: ORDER_EMAIL_TO,
    subject: 'New Lost Signal Order',
    html: `
      <div style="font-family: Arial, sans-serif; color: #111; background: #f3f0ea; padding: 24px;">
        <div style="max-width: 700px; margin: 0 auto; background: #fff; border: 1px solid #d9d1c7; border-radius: 18px; padding: 24px;">
          <p style="margin: 0 0 14px; font-size: 12px; letter-spacing: 0.16em; color: #7b776f; text-transform: uppercase;">Lost Signal / Order Alert</p>
          <h2 style="margin: 0 0 18px; font-size: 30px; letter-spacing: -0.05em;">New Lost Signal Order</h2>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; font-size: 14px; line-height: 1.6;">
            <div><strong>Order ID:</strong><br>${sanitizeText(orderData.orderId, 'N/A')}</div>
            <div><strong>PayPal Status:</strong><br>${sanitizeText(orderData.paymentStatus, 'UNKNOWN')}</div>
            <div><strong>Customer:</strong><br>${sanitizeText(orderData.customerName, 'Guest')}</div>
            <div><strong>Email:</strong><br>${sanitizeText(orderData.customerEmail, 'Not provided')}</div>
            <div style="grid-column: 1 / -1;"><strong>Shipping:</strong><br>${sanitizeText(orderData.shippingAddress, 'Not provided')}</div>
            <div style="grid-column: 1 / -1;"><strong>Date:</strong><br>${new Date(orderData.date || Date.now()).toLocaleString()}</div>
          </div>

          <table style="width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px;">
            <thead>
              <tr style="background: #f8f5f0; color: #111; text-transform: uppercase; font-size: 12px; letter-spacing: 0.12em;">
                <th style="padding: 10px 0; text-align: left;">Product</th>
                <th style="padding: 10px 0; text-align: center;">Qty</th>
                <th style="padding: 10px 0; text-align: right;">Unit</th>
                <th style="padding: 10px 0; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>${itemRows || '<tr><td colspan="4" style="padding: 12px 0;">No item details were returned.</td></tr>'}</tbody>
          </table>

          <div style="margin-top: 18px; font-size: 14px; line-height: 1.8; border-top: 1px solid #e9e2d6; padding-top: 14px;">
            <div><strong>Subtotal:</strong> $${Number(orderData.subtotal || 0).toFixed(2)}</div>
            <div><strong>Shipping:</strong> $${Number(orderData.shippingCost || 0).toFixed(2)}</div>
            <div><strong>Tax:</strong> $${Number(orderData.tax || 0).toFixed(2)}</div>
            <div><strong>Total Paid:</strong> $${Number(orderData.total || 0).toFixed(2)} ${sanitizeText(orderData.currency, 'USD')}</div>
          </div>
        </div>
      </div>
    `
  };

  await transporter.sendMail(mail);
  return { ok: true, skipped: false };
}

async function sendNewsletterSignupEmail(email) {
  const transporter = createTransporter();
  if (!transporter) {
    throw new Error('Newsletter email service is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS before launch.');
  }

  await transporter.sendMail({
    from: NEWSLETTER_EMAIL_FROM,
    to: email,
    subject: 'Welcome to the Lost Signal / Fall Transmission',
    text: 'SIGNAL RECEIVED. You are on the Lost Signal list. Your first fall offer is 15% off your first signal. Watch for early access and new drop alerts.',
    html: `
      <div style="font-family: Arial, sans-serif; color: #17120f; background: #f1e6d7; padding: 24px;">
        <div style="max-width: 560px; margin: 0 auto; background: #fffaf2; border: 1px solid #c58b55; padding: 28px;">
          <p style="margin:0 0 10px; color:#9a5528; font-size:12px; letter-spacing:.14em; text-transform:uppercase;">Fall Transmission / 001</p>
          <h1 style="margin:0 0 16px; font-size:34px; letter-spacing:-.06em;">SIGNAL RECEIVED.</h1>
          <p style="font-size:16px; line-height:1.55;">You are on the Lost Signal list. You will receive early access, new drop alerts, and seasonal offers.</p>
          <p style="margin:24px 0 0; color:#9a5528; font-size:14px; letter-spacing:.1em; text-transform:uppercase;">15% off your first signal</p>
        </div>
      </div>
    `
  });
}

async function sendNewsletterToSubscribers(newsletter) {
  const transporter = createTransporter();
  if (!transporter) {
    throw new Error('SMTP credentials are not configured.');
  }

  const subscribers = readDataFile(SUBSCRIBERS_FILE, []).filter((subscriber) => subscriber.active !== false);
  const results = await Promise.allSettled(subscribers.map((subscriber) => transporter.sendMail({
    from: NEWSLETTER_EMAIL_FROM,
    to: subscriber.email,
    subject: sanitizeText(newsletter.subject, 'Lost Signal transmission'),
    text: sanitizeText(newsletter.text, ''),
    html: sanitizeText(newsletter.html, `<p>${sanitizeText(newsletter.text, '')}</p>`)
  })));

  return {
    total: subscribers.length,
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length
  };
}

app.get('/api/health', (req, res) => {
  const configurationError = getConfigurationError({ requirePayPal: isProductionDeployment, requireUps: isProductionDeployment });
  if (configurationError) {
    return res.status(503).json({ ok: false, error: configurationError });
  }
  return res.json({ ok: true, environment: PAYPAL_ENVIRONMENT });
});

app.get('/api/paypal/config', (req, res) => {
  const configurationError = getConfigurationError({ requirePayPal: true });
  if (configurationError) {
    return res.status(503).json({ ok: false, error: configurationError });
  }

  res.json({
    ok: true,
    clientId: PAYPAL_CLIENT_ID,
    environment: PAYPAL_ENVIRONMENT,
    sandbox: isSandbox
  });
});

app.post('/api/coupons/validate', (req, res) => {
  try {
    const trustedItems = normalizeCartItems(req.body?.items || []);
    const amounts = calculateOrderAmounts(trustedItems, req.body?.couponCode || '');
    return res.json({
      ok: true,
      subtotal: amounts.subtotal,
      discount: amounts.discount,
      total: amounts.total,
      coupon: amounts.coupon ? {
        code: amounts.coupon.code,
        description: amounts.coupon.description,
        type: amounts.coupon.type,
        amount: amounts.coupon.amount
      } : null
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Unable to validate discount code.' });
  }
});

app.post('/api/shipping/rates', async (req, res) => {
  try {
    const configurationError = getConfigurationError({ requireUps: true });
    if (configurationError) {
      return res.status(503).json({ ok: false, error: configurationError });
    }

    const trustedItems = normalizeCartItems(req.body?.items || []);
    const destination = req.body?.destination || {};
    const origin = req.body?.origin || {};
    const rates = await fetchCarrierRates({ items: trustedItems, destination, origin });
    const selected = selectCheapestEligibleShipment(rates) || {
      carrier: 'UPS',
      service: 'TEST',
      cost: Number(UPS_TEST_SHIPPING_RATE.toFixed(2)),
      raw: buildUpsShippingRate({ amount: UPS_TEST_SHIPPING_RATE, service: 'TEST', isTestRate: true })
    };

    const subtotal = Number(calculateCartTotal(trustedItems).toFixed(2));
    return res.json({
      ok: true,
      subtotal,
      shipping: {
        carrier: selected.carrier,
        service: selected.service,
        cost: selected.cost,
        currency: 'USD',
        isTestRate: Boolean(selected.raw?.isTestRate || selected.service === 'TEST')
      },
      total: Number((subtotal + selected.cost).toFixed(2)),
      rates,
      configuration: getShippingRateConfigStatus()
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Unable to calculate shipping rates.' });
  }
});

app.post('/api/refunds/preview', (req, res) => {
  try {
    const summary = calculateRefundSummary({
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      discount: safeNumber(req.body?.discount, 0),
      shippingCost: safeNumber(req.body?.shippingCost, 0),
      returnedItems: Array.isArray(req.body?.returnedItems) ? req.body.returnedItems : [],
      policy: {
        originalShippingNonRefundable: req.body?.policy?.originalShippingNonRefundable !== false,
        shippingRefundableForError: Boolean(req.body?.policy?.shippingRefundableForError),
        discountRefundableAsCash: Boolean(req.body?.policy?.discountRefundableAsCash)
      },
      reason: sanitizeText(req.body?.reason, 'customer_preference')
    });

    return res.json({
      ok: true,
      summary,
      requiresPayPalRefundCapability: !Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET),
      warning: 'Return requests are reviewed before refunds are approved. This preview is informational only and does not approve a refund.'
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Unable to preview refund.' });
  }
});

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const configurationError = getConfigurationError({ requirePayPal: true, requireUps: true });
    if (configurationError) {
      return res.status(503).json({ error: configurationError });
    }

    const trustedItems = normalizeCartItems(req.body.items || []);
    const amounts = calculateOrderAmounts(trustedItems, req.body.couponCode || '');
    const shippingQuote = await resolveShippingQuote({
      items: trustedItems,
      destination: req.body.destination || {},
      origin: req.body.origin || {}
    });
    const shippingAmount = safeNumber(req.body.shippingCost || req.body.shipping?.cost || shippingQuote.cost || 0, 0);
    const shippingCarrier = sanitizeText(req.body.shippingCarrier || req.body.shipping?.carrier || shippingQuote.carrier || 'UPS', 'UPS');
    const shippingService = sanitizeText(req.body.shippingService || req.body.shipping?.service || shippingQuote.service || 'TEST', 'TEST');
    const finalTotal = Number((amounts.total + shippingAmount).toFixed(2));

    const token = await getPayPalAccessToken();

    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `lostsignal-${Date.now()}`,
          description: 'Lostsignal clothing order',
          custom_id: `lostsignal-order-${Date.now()}`,
          amount: {
            currency_code: 'USD',
            value: finalTotal.toFixed(2),
            breakdown: {
              item_total: {
                currency_code: 'USD',
                value: amounts.subtotal.toFixed(2)
              },
              discount: {
                currency_code: 'USD',
                value: amounts.discount.toFixed(2)
              },
              shipping: {
                currency_code: 'USD',
                value: shippingAmount.toFixed(2)
              }
            }
          },
          items: trustedItems.map((item) => ({
            name: item.name,
            quantity: String(item.quantity),
            unit_amount: {
              currency_code: 'USD',
              value: item.unitPrice.toFixed(2)
            },
            category: 'PHYSICAL_GOODS'
          }))
        }],
        application_context: {
          brand_name: 'Lostsignal',
          landing_page: 'LOGIN',
          user_action: 'PAY_NOW',
          return_url: `${req.protocol}://${req.get('host')}/checkout/success`,
          cancel_url: `${req.protocol}://${req.get('host')}/checkout/cancel`
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('PayPal API error response:', JSON.stringify(data, null, 2));
      console.error('Response status:', response.status);
      return res.status(400).json({ error: data?.message || data?.error || JSON.stringify(data) || 'PayPal order creation failed.' });
    }

    res.json({
      ok: true,
      id: data.id,
      status: data.status,
      subtotal: amounts.subtotal,
      discount: amounts.discount,
      shipping: {
        carrier: shippingCarrier,
        service: shippingService,
        cost: shippingAmount
      },
      total: finalTotal,
      couponCode: amounts.coupon?.code || null,
      links: data.links || []
    });
  } catch (error) {
    console.error('create-order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create PayPal order.' });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderId, customerName, customerEmail, shippingAddress, items } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ error: 'Missing PayPal orderId.' });
    }

    const token = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        error: data.error_description || data.message || 'PayPal capture failed.'
      });
    }

    const isCaptured = data.status === 'COMPLETED';
    let emailStatus = 'not_needed';

    if (isCaptured) {
      const normalizedOrderKey = dedupeKeyForOrder(orderId);

      if (ORDER_EMAIL_DEDUPE.has(normalizedOrderKey)) {
        emailStatus = 'duplicate_skipped';
      } else {
        ORDER_EMAIL_DEDUPE.add(normalizedOrderKey);

        try {
          const payload = buildOrderEmailPayload(data, {
            orderId,
            customerName: customerName || 'Guest',
            customerEmail: customerEmail || 'Not provided',
            shippingAddress: shippingAddress || 'Not provided',
            status: data.status,
            items: Array.isArray(items) ? items : []
          });

          await sendOrderEmail(payload);
          emailStatus = 'sent';
        } catch (emailError) {
          console.error('Order email notification failed:', emailError);
          emailStatus = 'failed';
        }
      }
    }

    res.json({
      ok: true,
      captured: isCaptured,
      emailStatus,
      status: data.status,
      id: data.id,
      payer: data.payer || null,
      purchase_units: data.purchase_units || []
    });
  } catch (error) {
    console.error('capture-order error:', error);
    res.status(500).json({ error: error.message || 'Failed to capture PayPal payment.' });
  }
});

app.post('/api/newsletter/subscribe', async (req, res) => {
  try {
    const email = sanitizeText(req.body?.email || '', '').toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }

    const subscribers = readDataFile(SUBSCRIBERS_FILE, []);
    const existingSubscriber = subscribers.find((subscriber) => subscriber.email === email);
    if (!existingSubscriber) {
      subscribers.push({ email, subscribedAt: new Date().toISOString(), active: true });
      writeDataFile(SUBSCRIBERS_FILE, subscribers);
    } else if (existingSubscriber.active === false) {
      existingSubscriber.active = true;
      existingSubscriber.resubscribedAt = new Date().toISOString();
      writeDataFile(SUBSCRIBERS_FILE, subscribers);
    }

    if (existingSubscriber?.active !== false && existingSubscriber?.welcomeSentAt) {
      return res.json({ ok: true, message: 'SIGNAL RECEIVED. You are already on the list.' });
    }

    try {
      await sendNewsletterSignupEmail(email);
      const savedSubscriber = subscribers.find((subscriber) => subscriber.email === email);
      if (savedSubscriber) {
        savedSubscriber.welcomeSentAt = new Date().toISOString();
        writeDataFile(SUBSCRIBERS_FILE, subscribers);
      }
      return res.json({ ok: true, message: 'SIGNAL RECEIVED. You are on the list.' });
    } catch (mailError) {
      console.warn('Newsletter signup service not configured:', mailError.message);
      return res.status(503).json({
        ok: false,
        error: 'The mailing-list email service is not configured yet. Add SMTP credentials before launch.'
      });
    }
  } catch (error) {
    console.error('newsletter subscribe error:', error);
    return res.status(500).json({ ok: false, error: 'Unable to process the signup request right now.' });
  }
});

app.get('/api/newsletter/subscribers', requireNewsletterAdmin, (req, res) => {
  res.json({ ok: true, subscribers: readDataFile(SUBSCRIBERS_FILE, []) });
});

app.get('/api/newsletter/coupons', requireNewsletterAdmin, (req, res) => {
  res.json({ ok: true, coupons: readDataFile(COUPONS_FILE, []) });
});

app.post('/api/newsletter/coupons', requireNewsletterAdmin, (req, res) => {
  const code = sanitizeText(req.body?.code, '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const description = sanitizeText(req.body?.description, 'Lost Signal offer');
  const amount = safeNumber(req.body?.amount, 0);
  const type = req.body?.type === 'fixed' ? 'fixed' : 'percent';

  if (!code || amount <= 0 || (type === 'percent' && amount > 100)) {
    return res.status(400).json({ error: 'Coupon code and a valid discount amount are required.' });
  }

  const coupons = readDataFile(COUPONS_FILE, []);
  const coupon = { code, description, type, amount, active: req.body?.active !== false, startsAt: req.body?.startsAt || null, endsAt: req.body?.endsAt || null };
  const existingIndex = coupons.findIndex((item) => item.code === code);
  if (existingIndex >= 0) coupons[existingIndex] = coupon;
  else coupons.push(coupon);
  writeDataFile(COUPONS_FILE, coupons);
  return res.status(existingIndex >= 0 ? 200 : 201).json({ ok: true, coupon });
});

app.get('/api/newsletter/drafts', requireNewsletterAdmin, (req, res) => {
  res.json({ ok: true, newsletters: readDataFile(NEWSLETTERS_FILE, []) });
});

app.post('/api/newsletter/publish', requireNewsletterAdmin, async (req, res) => {
  const subject = sanitizeText(req.body?.subject, 'Lost Signal transmission');
  const text = sanitizeText(req.body?.text, 'New Lost Signal transmission incoming.');
  const html = sanitizeText(req.body?.html, `<p>${text}</p>`);
  const newsletters = readDataFile(NEWSLETTERS_FILE, []);
  const newsletter = { id: `newsletter-${Date.now()}`, subject, text, html, createdAt: new Date().toISOString(), status: 'sending' };

  try {
    const result = await sendNewsletterToSubscribers(newsletter);
    newsletter.status = result.failed ? 'partial' : 'sent';
    newsletter.delivery = result;
    newsletters.push(newsletter);
    writeDataFile(NEWSLETTERS_FILE, newsletters);
    return res.json({ ok: true, newsletter });
  } catch (error) {
    newsletter.status = 'failed';
    newsletter.error = error.message;
    newsletters.push(newsletter);
    writeDataFile(NEWSLETTERS_FILE, newsletters);
    return res.status(503).json({ ok: false, error: 'Newsletter was not sent. Check SMTP configuration.', newsletter });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Lostsignal server running on http://localhost:${PORT}`);
    console.log(`PayPal environment: ${PAYPAL_ENVIRONMENT}`);
  });
}

module.exports = {
  app,
  buildOrderEmailPayload,
  buildUpsShippingRate,
  dedupeKeyForOrder,
  sendNewsletterSignupEmail,
  sendOrderEmail,
  normalizeCartItems,
  calculateCartTotal,
  findCoupon,
  calculateOrderAmounts,
  calculateRefundSummary,
  selectCheapestEligibleShipment,
  fetchCarrierRates,
  getShippingRateConfigStatus
};
