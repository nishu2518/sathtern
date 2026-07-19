const http = require('http');

const ALLOWED_ITEMS = new Map([
  ['certificate', { name: 'Certificate of Completion', price: 199 }],
  ['lor', { name: 'Letter of Recommendation (LOR)', price: 199 }],
  ['offer', { name: 'Offer Letter', price: 199 }]
]);

const allowedOrigins = new Set([
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'https://sathtern-2bce6.web.app',
  'https://sathtern.in',
  'https://www.sathtern.in'
]);

function sendJson(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 100) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function getCashfreeBaseUrl() {
  return (process.env.CASHFREE_ENV || 'sandbox') === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function validateOrder(body) {
  const amount = Number(body.amount);
  const items = Array.isArray(body.items) ? body.items : [];
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const name = String(body.name || '').trim();

  if (!email || !phone || !name) throw new Error('Student name, email, and phone are required.');
  if (!items.length || items.length > 3) throw new Error('Select Certificate, LOR, Offer Letter, or any combination.');

  const cleanItems = items.map(item => {
    const allowed = ALLOWED_ITEMS.get(item.id);
    if (!allowed) throw new Error('Invalid document item.');
    return { id: item.id, name: allowed.name, price: allowed.price };
  });

  const uniqueIds = new Set(cleanItems.map(item => item.id));
  if (uniqueIds.size !== cleanItems.length) throw new Error('Duplicate document item.');

  const expectedAmount = cleanItems.reduce((sum, item) => sum + item.price, 0);
  if (amount !== expectedAmount) throw new Error('Invalid order amount.');

  return {
    amount,
    items: cleanItems,
    email,
    phone,
    name,
    uid: String(body.uid || '').trim(),
    domainName: String(body.domainName || 'Internship').trim()
  };
}

async function createCashfreeOrder(req, res, origin) {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  const apiVersion = process.env.CASHFREE_API_VERSION || '2025-01-01';

  if (!clientId || !clientSecret) {
    sendJson(res, 500, { error: 'Cashfree keys are not configured on Render.' }, origin);
    return;
  }

  let order;
  try {
    order = validateOrder(await getBody(req));
  } catch (error) {
    sendJson(res, 400, { error: error.message }, origin);
    return;
  }

  const orderId = `SATH_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const payload = {
    order_id: orderId,
    order_amount: order.amount,
    order_currency: 'INR',
    customer_details: {
      customer_id: order.uid || order.email.replace(/[^a-zA-Z0-9_-]/g, '_'),
      customer_name: order.name,
      customer_email: order.email,
      customer_phone: order.phone
    },
    order_note: `${order.domainName}: ${order.items.map(item => item.name).join(', ')}`
  };

  try {
    const response = await fetch(`${getCashfreeBaseUrl()}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': apiVersion,
        'x-client-id': clientId,
        'x-client-secret': clientSecret
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendJson(res, response.status, {
        error: data.message || data.error_description || data.type || 'Cashfree order creation failed.',
        cashfree: data
      }, origin);
      return;
    }

    sendJson(res, 200, {
      order_id: data.order_id,
      payment_session_id: data.payment_session_id
    }, origin);
  } catch (error) {
    sendJson(res, 500, { error: 'Could not connect to Cashfree.' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    sendJson(res, 200, {
      ok: true,
      service: 'Sathtern Cashfree backend',
      paymentEndpoint: '/create-cashfree-order'
    }, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/create-cashfree-order') {
    sendJson(res, 200, {
      ok: true,
      message: 'Use POST /create-cashfree-order from the Sathtern website.'
    }, origin);
    return;
  }

  if (req.method === 'POST' && (req.url === '/create-cashfree-order' || req.url === '/')) {
    await createCashfreeOrder(req, res, origin);
    return;
  }

  sendJson(res, 404, { error: 'Not found' }, origin);
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`Sathtern Cashfree backend listening on ${port}`);
});
