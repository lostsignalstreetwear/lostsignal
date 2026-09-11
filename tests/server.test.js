const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOrderEmailPayload,
  buildUpsShippingRate,
  calculateOrderAmounts,
  calculateRefundSummary,
  dedupeKeyForOrder,
  findCoupon,
  getShippingRateConfigStatus,
  selectCheapestEligibleShipment
} = require('../server');

test('calculateOrderAmounts applies a percentage coupon from the coupon catalog', () => {
  const result = calculateOrderAmounts([{ id: 1, unitPrice: 100, quantity: 1 }], 'SIGNAL15');
  assert.equal(result.subtotal, 100);
  assert.equal(result.discount, 15);
  assert.equal(result.total, 85);
});

test('findCoupon applies fixed discounts and rejects expired or minimum-purchase codes', () => {
  const catalog = [
    { code: 'FIXED10', type: 'fixed', amount: 10, active: true },
    { code: 'EXPIRED', type: 'percent', amount: 10, active: true, endsAt: '2026-08-30' },
    { code: 'MINIMUM', type: 'percent', amount: 10, active: true, minimumPurchase: 50 }
  ];
  assert.equal(findCoupon('FIXED10', 50, new Date('2026-08-31'), catalog).discount, 10);
  assert.throws(() => findCoupon('EXPIRED', 100, new Date('2026-08-31'), catalog), /expired/);
  assert.throws(() => findCoupon('MINIMUM', 20, new Date('2026-08-31'), catalog), /minimum purchase/);
});

test('buildOrderEmailPayload creates a clean store-owner email payload', () => {
  const payload = buildOrderEmailPayload({
    orderId: 'PAY-123',
    status: 'COMPLETED',
    payer: {
      name: { given_name: 'Alex', surname: 'Signal' },
      email_address: 'alex@example.com'
    },
    purchase_units: [{
      amount: {
        currency_code: 'USD',
        value: '140.00',
        breakdown: {
          item_total: { currency_code: 'USD', value: '120.00' },
          shipping: { currency_code: 'USD', value: '15.00' },
          tax_total: { currency_code: 'USD', value: '5.00' }
        }
      },
      items: [
        { name: 'Dead Air Shell', quantity: '1', unit_amount: { value: '120.00' } }
      ],
      shipping: {
        address: {
          address_line_1: '123 Noise Lane',
          admin_area_2: 'Brooklyn',
          admin_area_1: 'NY',
          postal_code: '11201',
          country_code: 'US'
        },
        name: { full_name: 'Alex Signal' }
      }
    }]
  }, {
    customerName: 'Alex Signal',
    customerEmail: 'alex@example.com'
  });

  assert.equal(payload.subject, 'New Lost Signal Order');
  assert.equal(payload.orderId, 'PAY-123');
  assert.equal(payload.total, '140.00');
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].name, 'Dead Air Shell');
  assert.equal(payload.customerName, 'Alex Signal');
  assert.equal(payload.shippingAddress, '123 Noise Lane, Brooklyn, NY 11201, US');
});

test('dedupeKeyForOrder normalizes repeated order notifications', () => {
  assert.equal(dedupeKeyForOrder('PAY-123'), 'PAY-123');
  assert.equal(dedupeKeyForOrder(' pay-123 '), 'pay-123');
});

test('calculateRefundSummary uses the discounted purchase amount and non-refundable shipping when policy says so', () => {
  const summary = calculateRefundSummary({
    items: [
      { id: 1, name: 'Dead Air Shell', quantity: 1, unitPrice: 120, discountAllocated: 20 },
      { id: 2, name: 'Off-Grid Knit', quantity: 1, unitPrice: 60, discountAllocated: 10 }
    ],
    discount: 30,
    shippingCost: 12,
    returnedItems: [
      { id: 1, quantity: 1, unitPrice: 120, discountAllocated: 20 }
    ],
    policy: {
      originalShippingNonRefundable: true,
      shippingRefundableForError: false,
      discountRefundableAsCash: false
    }
  });

  assert.equal(summary.itemRefund, 100);
  assert.equal(summary.eligibleShippingRefund, 0);
  assert.equal(summary.finalRefund, 100);
  assert.equal(summary.discountedItemAmount, 100);
});

test('selectCheapestEligibleShipment chooses the least expensive valid service when multiple carriers are available', () => {
  const rates = [
    { carrier: 'UPS', service: 'Ground', cost: 11.2 },
    { carrier: 'UPS', service: 'Priority Mail', cost: 8.75 },
    { carrier: 'UPS', service: 'Express', cost: 18.5 }
  ];

  const chosen = selectCheapestEligibleShipment(rates);
  assert.equal(chosen.carrier, 'UPS');
  assert.equal(chosen.service, 'Priority Mail');
  assert.equal(chosen.cost, 8.75);
});

test('buildUpsShippingRate creates a clearly marked UPS test shipping rate', () => {
  const rate = buildUpsShippingRate({ amount: 10, service: 'TEST', isTestRate: true });

  assert.equal(rate.carrier, 'UPS');
  assert.equal(rate.service, 'TEST');
  assert.equal(rate.amount, 10);
  assert.equal(rate.isTestRate, true);
  assert.equal(rate.currency, 'USD');
});

test('getShippingRateConfigStatus identifies the UPS test-mode configuration', () => {
  const status = getShippingRateConfigStatus();

  assert.equal(status.provider, 'UPS');
  assert.equal(status.mode, 'TEST');
  assert.equal(status.isTestMode, true);
  assert.equal(status.rate, 10);
});
