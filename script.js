const products = [
  { id: 1, name: 'Dead Air Shell', price: 168, meta: '01 / OUTERWEAR', image: 'https://images.unsplash.com/photo-1548883354-7622d03aca27?auto=format&fit=crop&w=700&q=85', tag: 'SIGNAL 01' },
  { id: 2, name: 'Off-Grid Knit', price: 94, meta: '02 / KNIT SYSTEM', image: 'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=700&q=85', tag: 'SIGNAL 02' },
  { id: 3, name: 'Null Cargo', price: 132, meta: '03 / FIELD TROUSER', image: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=700&q=85', tag: 'SIGNAL 03' },
  { id: 4, name: 'Low Frequency Tee', price: 58, meta: '04 / BASE LAYER', image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=700&q=85', tag: 'SIGNAL 04' }
];
const BRAND_EMAIL = 'Lostsignal320@gmail.com';
let PAYPAL_CLIENT_ID = '';
let PAYPAL_SDK_READY = false;
let PAYPAL_SDK_PROMISE = null;
let shippingQuote = {
  carrier: 'UPS',
  service: 'TEST',
  cost: 10,
  currency: 'USD',
  isTestRate: true
};
let isShippingLoading = false;
const NEWSLETTER_STORAGE_KEY = 'lostsignal-newsletter-dismissed';
const testPrice = 29;
const testProduct = { id: 'test', name: 'Test Signal', price: testPrice, image: 'logo/logo.jpeg' };
const cart = [];
let appliedCoupon = null;
const $ = (id) => document.getElementById(id);
const navPanel = $('navPanel');

function canUseStorage() {
  try {
    const testKey = '__lostsignal_storage__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch (error) {
    return false;
  }
}

function rememberNewsletterState(state) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(NEWSLETTER_STORAGE_KEY, JSON.stringify({ state, updatedAt: Date.now() }));
}

function showNewsletterMessage(message, isError = false) {
  const feedback = $('newsletterFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('is-error', isError);
}

async function handleNewsletterSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const emailInput = $('newsletterEmail');
  const email = (emailInput?.value || '').trim();

  if (!email || !email.includes('@')) {
    showNewsletterMessage('Please enter a valid email.', true);
    emailInput?.focus();
    return;
  }

  showNewsletterMessage('Sending…');

  try {
    const response = await fetch('/api/newsletter/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Unable to sign up right now.');
    }

    form.reset();
    const button = form.querySelector('.newsletter-submit');
    if (button) button.disabled = true;
    showNewsletterMessage('Subscription received.');
    rememberNewsletterState('submitted');
  } catch (error) {
    showNewsletterMessage(error.message || 'Unable to sign up right now.', true);
  }
}

async function getPayPalClientConfig() {
  try {
    const response = await fetch('/api/paypal/config', { method: 'GET' });
    const data = await response.json();
    if (!response.ok || !data.clientId) {
      throw new Error(data.error || 'PayPal config was not available.');
    }
    return data;
  } catch (error) {
    console.error('PayPal config fetch failed:', error);
    throw error;
  }
}

async function loadPayPalSdk() {
  if (window.paypal && window.paypal.Buttons) {
    PAYPAL_SDK_READY = true;
    return;
  }

  if (PAYPAL_SDK_PROMISE) {
    return PAYPAL_SDK_PROMISE;
  }

  const config = await getPayPalClientConfig();
  PAYPAL_CLIENT_ID = String(config.clientId || '').trim();

  if (!PAYPAL_CLIENT_ID) {
    throw new Error('PayPal Client ID is not configured. Check your .env file for PAYPAL_CLIENT_ID.');
  }

  if (config.environment !== 'sandbox') {
    throw new Error('This checkout is locked to PayPal Sandbox mode for testing.');
  }

  PAYPAL_SDK_PROMISE = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-paypal-sdk]');
    const script = existingScript || document.createElement('script');

    const handleLoad = () => {
      if (!window.paypal || !window.paypal.Buttons) {
        PAYPAL_SDK_PROMISE = null;
        reject(new Error('PayPal SDK loaded without its Buttons API.'));
        return;
      }
      PAYPAL_SDK_READY = true;
      resolve();
    };

    const handleError = () => {
      PAYPAL_SDK_PROMISE = null;
      reject(new Error('PayPal SDK failed to load.'));
    };

    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });

    if (!existingScript) {
      script.setAttribute('data-paypal-sdk', 'true');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(PAYPAL_CLIENT_ID)}&currency=USD&intent=capture`;
      script.async = true;
      document.body.appendChild(script);
    } else if (window.paypal && window.paypal.Buttons) {
      handleLoad();
    }
  });

  return PAYPAL_SDK_PROMISE;
}

async function checkCheckoutServer() {
  try {
    const response = await fetch('/api/health', { method: 'GET' });
    if (!response.ok) {
      throw new Error('Checkout server unavailable');
    }
    return true;
  } catch (error) {
    console.error('Checkout server check failed:', error);
    return false;
  }
}

function openNavPanel(panelName) {
  if (panelName === 'home') { closeNavPanel(); return; }
  document.querySelectorAll('[data-panel-content]').forEach((panel) => { panel.hidden = panel.dataset.panelContent !== panelName; });
  navPanel.classList.add('open'); navPanel.setAttribute('aria-hidden', 'false'); $('backdrop').classList.add('open'); document.body.classList.add('locked');
}
function closeNavPanel() { navPanel.classList.remove('open'); navPanel.setAttribute('aria-hidden', 'true'); if (!$('cartDrawer').classList.contains('open') && !$('checkoutModal').classList.contains('open')) { $('backdrop').classList.remove('open'); document.body.classList.remove('locked'); } }

function renderProducts() {
  if (!$('productGrid')) return;
  $('productGrid').innerHTML = products.map((product) => `
    <article class="product-card">
      <div class="product-image-wrap"><img class="product-image" src="${product.image}" alt="${product.name}" loading="lazy"><span class="product-tag">${product.tag}</span><button class="quick-add" data-id="${product.id}" type="button" aria-label="Add ${product.name} to bag">+</button></div>
      <div class="product-info"><strong>${product.name}</strong><span>$${product.price}</span></div><div class="product-meta">${product.meta}</div>
    </article>`).join('');
  document.querySelectorAll('.quick-add').forEach((button) => button.addEventListener('click', () => addToCart(Number(button.dataset.id))));
}
function addToCart(id) { const product = products.find((item) => item.id === id); cart.push(product); renderCart(); openCart(); }
function addTestItem() { cart.push(testProduct); renderCart(); openCart(); }
function renderCart() {
  $('cartCount').textContent = cart.length; $('cartDrawerCount').textContent = cart.length; $('cartTotal').textContent = `$${cart.reduce((sum, item) => sum + item.price, 0)}`; $('checkoutButton').disabled = cart.length === 0;
  $('cartItems').innerHTML = cart.length ? cart.map((item, index) => `<div class="cart-item"><img src="${item.image}" alt=""><div><h4>${item.name}</h4><p>$${item.price} / ONE SIZE</p></div><button class="remove-item" data-index="${index}" type="button">REMOVE</button></div>`).join('') : '<div class="empty-cart"><span>∅</span><p>Nothing intercepted yet.</p><a href="#collection" id="emptyCartLink">SCAN THE DROP</a></div>';
  document.querySelectorAll('.remove-item').forEach((button) => button.addEventListener('click', () => { cart.splice(Number(button.dataset.index), 1); renderCart(); }));
  const emptyLink = $('emptyCartLink'); if (emptyLink) emptyLink.addEventListener('click', closeCart);
}
function openCart() { $('cartDrawer').classList.add('open'); $('backdrop').classList.add('open'); $('cartDrawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('locked'); }
function closeCart() { $('cartDrawer').classList.remove('open'); $('backdrop').classList.remove('open'); $('cartDrawer').setAttribute('aria-hidden', 'true'); document.body.classList.remove('locked'); }
async function loadShippingQuote() {
  if (!cart.length) {
    shippingQuote = { carrier: 'UPS', service: 'TEST', cost: 10, currency: 'USD', isTestRate: true };
    isShippingLoading = false;
    renderCheckoutSummary();
    return shippingQuote;
  }

  isShippingLoading = true;
  renderCheckoutSummary();

  try {
    const response = await fetch('/api/shipping/rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map((item) => ({ id: item.id, quantity: 1 })),
        destination: { country: 'US', zip: '10001' },
        origin: { postalCode: '10001' }
      })
    });

    const result = await response.json();
    if (!response.ok || !result?.shipping) {
      throw new Error(result?.error || 'Unable to load shipping quote.');
    }

    shippingQuote = {
      carrier: result.shipping.carrier || 'UPS',
      service: result.shipping.service || 'TEST',
      cost: Number(result.shipping.cost || 10),
      currency: result.shipping.currency || 'USD',
      isTestRate: Boolean(result.shipping.isTestRate)
    };
    isShippingLoading = false;
    renderCheckoutSummary();
    return shippingQuote;
  } catch (error) {
    console.error('Shipping quote failed:', error);
    shippingQuote = { carrier: 'UPS', service: 'TEST', cost: 10, currency: 'USD', isTestRate: true };
    isShippingLoading = false;
    renderCheckoutSummary();
    return shippingQuote;
  }
}

function formatCurrency(value) {
  const amount = Number(value);
  return `$${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`;
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Animates an element's displayed text toward a target dollar amount. Purely visual — the
// authoritative numbers used for order totals and PayPal live in cart/appliedCoupon/shippingQuote.
function animatePriceValue(el, targetValue) {
  if (!el) return;
  const target = Number(targetValue) || 0;
  const previous = Number(el.dataset.value);
  const startValue = Number.isFinite(previous) ? previous : target;
  el.dataset.value = target;

  if (el._priceAnimationFrame) {
    cancelAnimationFrame(el._priceAnimationFrame);
    el._priceAnimationFrame = null;
  }

  if (prefersReducedMotion() || startValue === target) {
    el.textContent = formatCurrency(target);
    return;
  }

  const duration = 750;
  const startTime = performance.now();
  const range = target - startValue;

  const step = (now) => {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatCurrency(startValue + range * eased);
    if (progress < 1) {
      el._priceAnimationFrame = requestAnimationFrame(step);
    } else {
      el.textContent = formatCurrency(target);
      el._priceAnimationFrame = null;
    }
  };

  el._priceAnimationFrame = requestAnimationFrame(step);
}

function buildOrderSummaryShell(container) {
  if (!container || container.dataset.summaryBuilt === 'true') return;
  container.innerHTML = `
    <div class="order-summary__section order-summary__discount" data-role="discount-section" hidden>
      <p class="order-summary__label">DISCOUNT</p>
      <div class="order-summary__row"><span data-role="discount-code"></span><strong class="order-summary__value price-value" data-role="discount">$0.00</strong></div>
    </div>
    <div class="order-summary__section order-summary__items">
      <p class="order-summary__label">ITEMS</p>
      <ul class="order-summary__items-list" data-role="items-list"></ul>
    </div>
    <div class="order-summary__section order-summary__shipping">
      <p class="order-summary__label">SHIPPING</p>
      <div class="order-summary__row"><span data-role="shipping-label">UPS Shipping</span><strong class="order-summary__value price-value" data-role="shipping">$0.00</strong></div>
    </div>
    <div class="order-summary__section order-summary__tax">
      <p class="order-summary__label">TAX</p>
      <div class="order-summary__row"><span>Sales Tax</span><strong class="order-summary__value price-value" data-role="tax">$0.00</strong></div>
    </div>
    <div class="order-summary__total">
      <span>TOTAL</span>
      <strong class="order-summary__value order-summary__value--total price-value" data-role="total">$0.00</strong>
    </div>
  `;
  container.dataset.summaryBuilt = 'true';
}

function updateOrderSummaryContainer(container, state) {
  if (!container) return;
  buildOrderSummaryShell(container);

  const discountSection = container.querySelector('[data-role="discount-section"]');
  const discountCodeEl = container.querySelector('[data-role="discount-code"]');
  const discountValueEl = container.querySelector('[data-role="discount"]');
  const itemsListEl = container.querySelector('[data-role="items-list"]');
  const shippingLabelEl = container.querySelector('[data-role="shipping-label"]');
  const shippingValueEl = container.querySelector('[data-role="shipping"]');
  const taxValueEl = container.querySelector('[data-role="tax"]');
  const totalValueEl = container.querySelector('[data-role="total"]');

  if (discountSection) {
    discountSection.hidden = !state.discount;
  }
  if (discountCodeEl) {
    discountCodeEl.textContent = state.couponCode ? `Code ${state.couponCode}` : 'Discount';
  }
  if (discountValueEl) {
    animatePriceValue(discountValueEl, -state.discount);
  }

  if (itemsListEl) {
    itemsListEl.innerHTML = state.items.length
      ? state.items.map((item) => `<li class="order-summary__row"><span>${item.name}</span><span class="order-summary__value">${formatCurrency(item.price)}</span></li>`).join('')
      : '<li class="order-summary__row"><span>No items yet.</span></li>';
  }

  if (shippingLabelEl) {
    shippingLabelEl.textContent = `${state.shippingCarrier} Shipping`;
  }
  if (shippingValueEl) {
    shippingValueEl.classList.toggle('is-loading', state.isShippingLoading);
    if (!state.isShippingLoading) {
      animatePriceValue(shippingValueEl, state.shippingCost);
    }
  }

  if (taxValueEl) {
    animatePriceValue(taxValueEl, state.tax);
  }

  if (totalValueEl) {
    animatePriceValue(totalValueEl, state.total);
  }
}

function renderCheckoutSummary() {
  const subtotal = cart.reduce((sum, item) => sum + item.price, 0);
  const discount = appliedCoupon ? Number(appliedCoupon.discount || 0) : 0;
  const shippingCost = Number(shippingQuote.cost || 0);
  const tax = 0;
  const total = subtotal - discount + shippingCost + tax;

  const state = {
    items: cart.map((item) => ({ name: item.name, price: item.price })),
    discount,
    couponCode: appliedCoupon?.code || '',
    shippingCarrier: shippingQuote.carrier || 'UPS',
    shippingCost,
    isShippingLoading,
    tax,
    total
  };

  updateOrderSummaryContainer($('checkoutSummary'), state);
  updateOrderSummaryContainer($('paymentSummary'), state);
}
function openCheckout() {
  closeCart();
  loadShippingQuote();
  renderCheckoutSummary();
  $('checkoutFormView').hidden = false;
  $('paymentView').hidden = true;
  $('orderStatus').hidden = true;
  $('checkoutModal').classList.add('open');
  $('backdrop').classList.add('open');
  $('checkoutModal').setAttribute('aria-hidden', 'false');
  document.body.classList.remove('locked');
}
function closeCheckout() { $('checkoutModal').classList.remove('open'); $('backdrop').classList.remove('open'); $('checkoutModal').setAttribute('aria-hidden', 'true'); document.body.classList.remove('locked'); }
async function applyCoupon() {
  const input = $('couponCode');
  const code = input.value.trim().toUpperCase();
  if (!code) return;

  $('couponFeedback').textContent = 'VALIDATING CODE...';
  try {
    const response = await fetch('/api/coupons/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart.map((item) => ({ id: item.id, quantity: 1 })), couponCode: code })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Invalid discount code.');
    appliedCoupon = { code: result.coupon.code, discount: Number(result.discount) };
    $('couponFeedback').textContent = `${result.coupon.description || 'Discount applied.'} / -$${Number(result.discount).toFixed(2)}`;
    $('removeCoupon').hidden = false;
    input.disabled = true;
    $('applyCoupon').disabled = true;
    renderCheckoutSummary();
  } catch (error) {
    $('couponFeedback').textContent = error.message;
    $('couponFeedback').classList.add('is-error');
  }
}
function removeCoupon() {
  appliedCoupon = null;
  $('couponCode').disabled = false;
  $('couponCode').value = '';
  $('applyCoupon').disabled = false;
  $('removeCoupon').hidden = true;
  $('couponFeedback').textContent = '';
  $('couponFeedback').classList.remove('is-error');
  renderCheckoutSummary();
}
function renderPayPalButton() {
  const container = $('paypalContainer');
  if (!container) return;

  if (container.dataset.paypalRendered === 'true') {
    return;
  }

  container.innerHTML = '<p class="checkout-disclaimer" id="paypalStatus">PayPal status: initializing…</p>';
  container.dataset.paypalRendered = 'false';

  const status = $('paypalStatus');

  const markStatus = (message) => {
    if (status) {
      status.textContent = message;
    }
  };

  if (!window.paypal || !window.paypal.Buttons) {
    markStatus('PayPal status: loading SDK…');
    let tries = 0;
    const retry = async () => {
      tries += 1;
      if (window.paypal && window.paypal.Buttons) {
        renderPayPalButton();
        return;
      }
      if (tries < 40) {
        try {
          await loadPayPalSdk();
          if (window.paypal && window.paypal.Buttons) {
            renderPayPalButton();
            return;
          }
        } catch (error) {
          markStatus(`PayPal status: SDK load error — ${error.message}`);
          return;
        }
        setTimeout(retry, 250);
      } else {
        markStatus('PayPal status: timeout — the SDK did not load. Check your network or PayPal client configuration.');
      }
    };
    setTimeout(retry, 250);
    return;
  }

  checkCheckoutServer().then((serverReady) => {
    if (!serverReady) {
      markStatus('PayPal status: backend unavailable — the local Node server must be running.');
      return;
    }

    markStatus('PayPal status: creating order…');
    const cartPayload = cart.map((item) => ({ id: item.id, quantity: 1 }));

    const buttons = window.paypal.Buttons({
      style: {
        layout: 'vertical',
        color: 'gold',
        shape: 'pill',
        label: 'paypal'
      },
      createOrder: async () => {
        try {
          markStatus('PayPal status: contacting PayPal…');
          const response = await fetch('/api/paypal/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: cartPayload,
              couponCode: appliedCoupon?.code || '',
              shipping: {
                carrier: shippingQuote.carrier,
                service: shippingQuote.service,
                cost: shippingQuote.cost
              }
            })
          });

          const data = await response.json();
          if (!response.ok || !data.id) {
            throw new Error(data.error || 'Unable to create PayPal order.');
          }

          markStatus('PayPal status: order ready — opening PayPal wallet…');
          return data.id;
        } catch (error) {
          console.error('createOrder failed:', error);
          const message = error.message || 'Could not create the PayPal order.';
          markStatus(`PayPal status: error — ${message}`);
          throw error;
        }
      },
      onApprove: async (data) => {
        try {
          markStatus('PayPal status: capturing payment…');
          const details = new FormData($('customerForm'));
          const payload = {
            orderId: data.orderID,
            customerName: details.get('name') || 'Guest',
            customerEmail: details.get('email') || '',
            shippingAddress: `${details.get('address') || ''}, ${details.get('location') || ''}`.trim(),
            items: cart.map((item) => ({
              name: item.name,
              price: item.price
            }))
          };

          const captureResponse = await fetch('/api/paypal/capture-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const result = await captureResponse.json();
          if (!captureResponse.ok || !result.captured) {
            markStatus(`PayPal status: capture failed — ${result.error || 'try again'}`);
            alert(result.error || 'PayPal capture failed. Please try again.');
            return;
          }

          markStatus('PayPal status: payment captured — finalizing order…');
          $('paymentView').hidden = true;
          $('orderStatus').hidden = false;
          cart.length = 0;
          renderCart();
        } catch (error) {
          console.error('Capture failed:', error);
          markStatus('PayPal status: capture error — check the backend logs and PayPal credentials.');
          alert('The payment was created but the capture step failed. Check the server logs and PayPal credentials.');
        }
      },
      onCancel: () => {
        markStatus('PayPal status: canceled by buyer.');
        alert('PayPal checkout was canceled.');
      },
      onError: (error) => {
        const errorDetails = error && error.details ? 
          error.details.map(d => `${d.field}: ${d.issue}`).join(' | ') :
          (error.message || (typeof error.toString === 'function' ? error.toString() : JSON.stringify(error)) || 'checkout failed.');
        console.error('PayPal checkout error:', error);
        console.error('PayPal error details:', { errorDetails, fullError: error });
        window.__PAYPAL_LAST_ERROR__ = error;
        container.dataset.paypalRendered = 'false';
        markStatus(`PayPal status: SDK error — ${errorDetails}`);
        alert(`PayPal SDK error: ${errorDetails}`);
      }
    });

    buttons.render('#paypalContainer').then(() => {
      container.dataset.paypalRendered = 'true';
    }).catch((error) => {
      console.error('PayPal render failed:', error);
      container.dataset.paypalRendered = 'false';
      markStatus('PayPal status: render failed — the SDK could not initialize the button.');
    });
  });
}

renderProducts(); renderCart();
$('testPrice').textContent = `$${testPrice}`;
$('addTestItem').addEventListener('click', addTestItem);
$('newsletterForm')?.addEventListener('submit', handleNewsletterSubmit);
$('applyCoupon')?.addEventListener('click', applyCoupon);
$('removeCoupon')?.addEventListener('click', removeCoupon);
$('[data-panel="home"]')?.addEventListener('click', (event) => { event.preventDefault(); closeNavPanel(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
document.querySelectorAll('[data-panel]:not([data-panel="home"])').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); openNavPanel(link.dataset.panel); }));
document.querySelectorAll('.panel-link').forEach((link) => link.addEventListener('click', closeNavPanel));
$('closeNavPanel').addEventListener('click', closeNavPanel);
$('cartTrigger').addEventListener('click', openCart); $('closeCart').addEventListener('click', closeCart); $('backdrop').addEventListener('click', () => { closeCart(); closeCheckout(); closeNavPanel(); }); $('checkoutButton').addEventListener('click', openCheckout); $('closeCheckout').addEventListener('click', closeCheckout);
$('skipIntro').addEventListener('click', () => { $('intro').style.animation = 'introOut .35s forwards'; $('site').style.animation = 'siteIn .35s forwards'; });
$('customerForm').addEventListener('submit', (event) => { event.preventDefault(); $('checkoutFormView').hidden = true; $('paymentView').hidden = false; renderPayPalButton(); });

const lostSignalMockupCatalog = {
  'mockup-1': {
    id: 'mockup-1',
    name: 'TRANSMISSION 05',
    description: 'A layered utility silhouette built for cold starts, late-night loops, and the kind of signal that never fully fades.',
    baseImage: 'images/mockup-1.PNG',
    currentImage: 'images/mockup-1.PNG',
    defaultColorKey: 'purple',
    colors: [
      { key: 'black', label: 'Black', ariaLabel: 'Select Black shirt', value: '#0b0d10', cloud: '#0b0d10' },
      { key: 'purple', label: 'Purple', ariaLabel: 'Select Purple shirt', value: '#7d5ef8', cloud: '#7d5ef8' },
      { key: 'white', label: 'White', ariaLabel: 'Select White shirt', value: '#f3f2ee', cloud: '#f3f2ee' }
    ]
  },
  'mockup-2': {
    id: 'mockup-2',
    name: 'TRANSMISSION 06',
    description: 'A quieter, hard-wearing tee designed to hold its shape through long shifts, rough nights, and repeat wear.',
    baseImage: 'images/mockup-2.PNG',
    currentImage: 'images/mockup-2.PNG',
    defaultColorKey: 'black',
    colors: [
      { key: 'black', label: 'Black', ariaLabel: 'Select Black shirt', value: '#0d0f12', cloud: '#0d0f12' },
      { key: 'white', label: 'White', ariaLabel: 'Select White shirt', value: '#f7f6f2', cloud: '#f7f6f2' }
    ]
  },
  'mockup-3': {
    id: 'mockup-3',
    name: 'TRANSMISSION 07',
    description: 'A structured overshirt feel with a low-glare finish and a clean, streetwear silhouette that sits easy in motion.',
    baseImage: 'images/mockup-3.PNG',
    currentImage: 'images/mockup-3.PNG',
    defaultColorKey: 'black',
    colors: [
      { key: 'black', label: 'Black', ariaLabel: 'Select Black shirt', value: '#111214', cloud: '#111214' },
      { key: 'white', label: 'White', ariaLabel: 'Select White shirt', value: '#f4f3ef', cloud: '#f4f3ef' }
    ]
  }
};

const lostSignalMockupState = {
  activeId: null,
  activeColor: null
};

function buildLostSignalMockupOverlay() {
  if ($('lostsignal-mockup-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'lostsignal-mockup-overlay';
  overlay.id = 'lostsignal-mockup-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="lostsignal-mockup-modal" role="dialog" aria-modal="true" aria-labelledby="lostsignal-mockup-name">
      <button class="lostsignal-mockup-close" type="button" aria-label="Close mockup viewer">×</button>
      <div class="lostsignal-mockup-layout">
        <div class="lostsignal-mockup-visual">
          <div class="lostsignal-mockup-image-wrap">
            <img class="lostsignal-mockup-image" id="lostsignal-mockup-image" src="" alt="" loading="eager">
          </div>
        </div>
        <div class="lostsignal-mockup-info">
          <p class="eyebrow">SIGNAL INCOMING</p>
          <h2 id="lostsignal-mockup-name">LOSTSIGNAL</h2>
          <div class="lostsignal-mockup-status">COMING SOON</div>
          <p class="lostsignal-mockup-description" id="lostsignal-mockup-description"></p>
          <div class="lostsignal-mockup-meta-block">
            <span class="lostsignal-mockup-label">AVAILABLE SHIRT COLORS</span>
            <div class="lostsignal-mockup-colors" id="lostsignal-mockup-colors" aria-label="Mockup color choices"></div>
          </div>
          <div class="lostsignal-mockup-size-wrap">
            <div class="lostsignal-mockup-size-header">
              <span class="lostsignal-mockup-label">GILDAN ADULT T-SHIRT</span>
            </div>
            <div class="lostsignal-mockup-size-table-wrap">
              <table class="lostsignal-mockup-size-table">
                <thead>
                  <tr>
                    <th>SIZE</th>
                    <th>BODY WIDTH</th>
                    <th>BODY LENGTH</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td>Small (S)</td><td>18"</td><td>28"</td></tr>
                  <tr><td>Medium (M)</td><td>20"</td><td>29"</td></tr>
                  <tr><td>Large (L)</td><td>22"</td><td>30"</td></tr>
                  <tr><td>Extra Large (XL)</td><td>24"</td><td>31"</td></tr>
                  <tr><td>2XL</td><td>26"</td><td>32"</td></tr>
                </tbody>
              </table>
            </div>
            <p class="lostsignal-mockup-note">Garment measurements shown in inches. There can be slight manufacturing tolerances.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('.lostsignal-mockup-close').addEventListener('click', closeLostSignalMockup);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeLostSignalMockup();
  });

  document.addEventListener('keydown', (event) => {
    if (overlay.classList.contains('is-open') && event.key === 'Escape') {
      closeLostSignalMockup();
    }
  });
}

const lostSignalImageViewerState = {
  scale: 1,
  minScale: 1,
  maxScale: 4,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  dragStartOffsetX: 0,
  dragStartOffsetY: 0
};

function buildLostSignalImageViewer() {
  if ($('lostsignal-image-viewer')) return;

  const viewer = document.createElement('div');
  viewer.className = 'lostsignal-image-viewer';
  viewer.id = 'lostsignal-image-viewer';
  viewer.setAttribute('aria-hidden', 'true');
  viewer.innerHTML = `
    <div class="lostsignal-image-viewer-shell" role="dialog" aria-modal="true" aria-label="Mockup image viewer">
      <div class="lostsignal-image-controls">
        <button class="lostsignal-image-zoom-out" type="button" aria-label="Zoom out">−</button>
        <button class="lostsignal-image-zoom-in" type="button" aria-label="Zoom in">+</button>
        <button class="lostsignal-image-reset" type="button" aria-label="Reset zoom">Reset</button>
        <button class="lostsignal-image-close" type="button" aria-label="Close image viewer">×</button>
      </div>
      <div class="lostsignal-image-stage" id="lostsignal-image-viewer-stage">
        <img class="lostsignal-image-viewer-image" id="lostsignal-image-viewer-image" src="" alt="" draggable="false">
      </div>
    </div>
  `;

  document.body.appendChild(viewer);

  const stage = $('lostsignal-image-viewer-stage');
  const image = $('lostsignal-image-viewer-image');

  viewer.querySelector('.lostsignal-image-close').addEventListener('click', closeLostSignalImageViewer);
  viewer.querySelector('.lostsignal-image-zoom-in').addEventListener('click', () => zoomLostSignalImage(0.25));
  viewer.querySelector('.lostsignal-image-zoom-out').addEventListener('click', () => zoomLostSignalImage(-0.25));
  viewer.querySelector('.lostsignal-image-reset').addEventListener('click', resetLostSignalImageZoom);
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer) closeLostSignalImageViewer();
  });

  stage?.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomLostSignalImage(event.deltaY < 0 ? 0.2 : -0.2);
  }, { passive: false });

  stage?.addEventListener('pointerdown', (event) => {
    if (lostSignalImageViewerState.scale <= lostSignalImageViewerState.minScale) return;
    lostSignalImageViewerState.isDragging = true;
    lostSignalImageViewerState.dragStartX = event.clientX;
    lostSignalImageViewerState.dragStartY = event.clientY;
    lostSignalImageViewerState.dragStartOffsetX = lostSignalImageViewerState.offsetX;
    lostSignalImageViewerState.dragStartOffsetY = lostSignalImageViewerState.offsetY;
    stage.setPointerCapture(event.pointerId);
    stage.style.cursor = 'grabbing';
  });

  stage?.addEventListener('pointermove', (event) => {
    if (!lostSignalImageViewerState.isDragging) return;
    lostSignalImageViewerState.offsetX = lostSignalImageViewerState.dragStartOffsetX + (event.clientX - lostSignalImageViewerState.dragStartX);
    lostSignalImageViewerState.offsetY = lostSignalImageViewerState.dragStartOffsetY + (event.clientY - lostSignalImageViewerState.dragStartY);
    updateLostSignalImageViewerTransform();
  });

  stage?.addEventListener('pointerup', () => {
    lostSignalImageViewerState.isDragging = false;
    if (stage) stage.style.cursor = lostSignalImageViewerState.scale > 1 ? 'grab' : 'default';
  });

  stage?.addEventListener('pointerleave', () => {
    lostSignalImageViewerState.isDragging = false;
    if (stage) stage.style.cursor = lostSignalImageViewerState.scale > 1 ? 'grab' : 'default';
  });

  image?.addEventListener('dblclick', () => {
    zoomLostSignalImage(lostSignalImageViewerState.scale >= 1.5 ? -0.5 : 0.75);
  });

  document.addEventListener('keydown', (event) => {
    const viewerOpen = $('lostsignal-image-viewer')?.classList.contains('is-open');
    if (!viewerOpen) return;
    if (event.key === 'Escape') closeLostSignalImageViewer();
    if (event.key === '+' || event.key === '=') zoomLostSignalImage(0.25);
    if (event.key === '-' || event.key === '_') zoomLostSignalImage(-0.25);
    if (event.key.toLowerCase() === 'r') resetLostSignalImageZoom();
  });
}

function updateLostSignalImageViewerTransform() {
  const image = $('lostsignal-image-viewer-image');
  if (!image) return;
  image.style.transform = `translate(${lostSignalImageViewerState.offsetX}px, ${lostSignalImageViewerState.offsetY}px) scale(${lostSignalImageViewerState.scale})`;
  image.style.cursor = lostSignalImageViewerState.scale > 1 ? 'grab' : 'default';
}

function zoomLostSignalImage(delta) {
  const viewer = $('lostsignal-image-viewer');
  if (!viewer || !viewer.classList.contains('is-open')) return;

  lostSignalImageViewerState.scale = Math.min(lostSignalImageViewerState.maxScale, Math.max(lostSignalImageViewerState.minScale, lostSignalImageViewerState.scale + delta));
  if (lostSignalImageViewerState.scale <= lostSignalImageViewerState.minScale) {
    lostSignalImageViewerState.scale = lostSignalImageViewerState.minScale;
    lostSignalImageViewerState.offsetX = 0;
    lostSignalImageViewerState.offsetY = 0;
  }
  updateLostSignalImageViewerTransform();
}

function resetLostSignalImageZoom() {
  lostSignalImageViewerState.scale = lostSignalImageViewerState.minScale;
  lostSignalImageViewerState.offsetX = 0;
  lostSignalImageViewerState.offsetY = 0;
  updateLostSignalImageViewerTransform();
}

function openLostSignalImageViewer(imageSrc) {
  buildLostSignalImageViewer();
  const viewer = $('lostsignal-image-viewer');
  const image = $('lostsignal-image-viewer-image');
  if (!viewer || !image || !imageSrc) return;

  image.src = imageSrc;
  image.alt = 'Selected Lostsignal mockup image';
  lostSignalImageViewerState.scale = 1;
  lostSignalImageViewerState.offsetX = 0;
  lostSignalImageViewerState.offsetY = 0;
  viewer.classList.add('is-open');
  viewer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('lostsignal-image-viewer-open');
  updateLostSignalImageViewerTransform();
}

function closeLostSignalImageViewer() {
  const viewer = $('lostsignal-image-viewer');
  if (!viewer) return;
  viewer.classList.remove('is-open');
  viewer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('lostsignal-image-viewer-open');
  resetLostSignalImageZoom();
}

function addLostSignalMockupTriggers() {
  const cards = document.querySelectorAll('.coming-card');

  cards.forEach((card, index) => {
    const mockupId = `mockup-${index + 1}`;
    const existingTrigger = card.querySelector('.lostsignal-mockup-trigger');
    if (existingTrigger) return;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'lostsignal-mockup-trigger';
    trigger.textContent = 'VIEW MOCKUP';
    trigger.setAttribute('aria-label', `Open ${lostSignalMockupCatalog[mockupId].name}`);
    trigger.addEventListener('click', () => openLostSignalMockup(mockupId));
    card.appendChild(trigger);

    card.setAttribute('tabindex', '0');
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLostSignalMockup(mockupId);
      }
    });
  });
}

function lostSignalMockupImageExists(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = `${src}?lostsignal=${Date.now()}`;
  });
}

async function selectLostSignalMockupColor(mockupId, colorKey) {
  const product = lostSignalMockupCatalog[mockupId];
  const overlay = $('lostsignal-mockup-overlay');
  const colorButtons = overlay?.querySelectorAll('.lostsignal-mockup-color');

  if (!product || !overlay || !colorButtons) return;

  const chosenColor = product.colors.find((item) => item.key === colorKey) || product.colors[0];
  lostSignalMockupState.activeId = mockupId;
  lostSignalMockupState.activeColor = chosenColor.key;

  const image = $('lostsignal-mockup-image');
  const candidates = [
    `images/${mockupId}-${chosenColor.key}.png`,
    `images/${mockupId}-${chosenColor.key}.PNG`,
    `images/${mockupId}-${chosenColor.key}.jpg`,
    `images/${mockupId}-${chosenColor.key}.jpeg`,
    `images/${mockupId}-${chosenColor.key}.webp`,
    `images/${mockupId}-${chosenColor.key}.svg`
  ];

  let selectedImage = product.currentImage || product.baseImage;
  for (const candidate of candidates) {
    if (await lostSignalMockupImageExists(candidate)) {
      selectedImage = candidate;
      break;
    }
  }

  image.src = selectedImage;
  image.alt = `${product.name} in ${chosenColor.label} shirt`;
  image.setAttribute('role', 'button');
  image.setAttribute('tabindex', '0');
  image.setAttribute('aria-label', `View ${product.name}`);
  image.dataset.mockupId = mockupId;
  image.style.filter = 'none';
  image.onclick = () => openLostSignalImageViewer(selectedImage);
  image.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openLostSignalImageViewer(selectedImage);
    }
  };

  colorButtons.forEach((button) => {
    const isSelected = button.dataset.colorKey === chosenColor.key;
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
    button.title = chosenColor.label;
  });
}

function renderLostSignalMockupColors(mockupId) {
  const product = lostSignalMockupCatalog[mockupId];
  const colorContainer = $('lostsignal-mockup-colors');
  if (!product || !colorContainer) return;

  colorContainer.innerHTML = product.colors.map((color) => `
    <button
      class="lostsignal-mockup-color"
      type="button"
      data-mockup-id="${mockupId}"
      data-color-key="${color.key}"
      aria-label="${color.ariaLabel}"
      aria-pressed="false"
      title="${color.label}"
      style="--cloud-color: ${color.cloud};"
    >
      <span class="sr-only">${color.label}</span>
    </button>
  `).join('');

  colorContainer.querySelectorAll('.lostsignal-mockup-color').forEach((button) => {
    button.addEventListener('click', () => selectLostSignalMockupColor(button.dataset.mockupId, button.dataset.colorKey));
  });
}

async function openLostSignalMockup(mockupId) {
  const product = lostSignalMockupCatalog[mockupId];
  const overlay = $('lostsignal-mockup-overlay');
  if (!product || !overlay) return;

  buildLostSignalMockupOverlay();
  const updatedOverlay = $('lostsignal-mockup-overlay');
  const name = $('lostsignal-mockup-name');
  const description = $('lostsignal-mockup-description');

  name.textContent = product.name;
  description.textContent = product.description;
  renderLostSignalMockupColors(mockupId);
  updatedOverlay.setAttribute('aria-hidden', 'false');
  updatedOverlay.classList.add('is-open');
  document.body.classList.add('lostsignal-mockup-open');

  const fallbackColor = product.defaultColorKey || product.colors[0]?.key || 'black';
  await selectLostSignalMockupColor(mockupId, fallbackColor);
}

function closeLostSignalMockup() {
  const overlay = $('lostsignal-mockup-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('lostsignal-mockup-open');
}

buildLostSignalMockupOverlay();
addLostSignalMockupTriggers();
