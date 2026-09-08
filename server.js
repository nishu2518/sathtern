const http = require('http');
const admin = require('firebase-admin');

const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || 'sathtern-2bce6';
if (!admin.apps.length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: firebaseProjectId
    });
  } else {
    admin.initializeApp({ projectId: firebaseProjectId });
  }
}

const ALLOWED_ITEMS = new Map([
  ['certificate', { name: 'Certificate of Completion', price: 199 }],
  ['lor', { name: 'Letter of Recommendation (LOR)', price: 199 }],
  ['offer', { name: 'Offer Letter', price: 199 }],
  ['skill-certificate', { name: 'Skill Course Certificate', dynamicPrice: true }]
]);

const allowedOrigins = new Set([
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:5002',
  'http://127.0.0.1:5002',
  'https://sathtern-2bce6.web.app',
  'https://sathtern.in',
  'https://www.sathtern.in'
]);

function sendJson(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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

async function verifyFirebaseUser(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Login is required to create a payment order.');
  return admin.auth().verifyIdToken(match[1]);
}

async function getSkillCoursePrice(courseId) {
  const { course, price, isFree } = await getSkillCoursePricing(courseId);
  if (isFree) throw new Error('This skill certificate is free and does not need payment.');
  if (course.active === false) throw new Error('Skill course is not active.');
  return price;
}

async function getSkillCoursePricing(courseId) {
  if (!courseId) throw new Error('Skill course ID is required.');
  const snap = await admin.firestore().collection('skillCourses').doc(courseId).get();
  if (!snap.exists) throw new Error('Skill course was not found.');
  const course = snap.data() || {};
  if (course.active === false) throw new Error('Skill course is not active.');
  if (course.certificateAccess === 'free' || course.certificateFree === true) {
    return { course, price: 0, isFree: true };
  }
  const price = Number(course.certificatePrice);
  if (!Number.isFinite(price) || price < 1 || price > 999) {
    throw new Error('Skill course price is invalid.');
  }
  return { course, price: Math.round(price), isFree: false };
}

async function validateOrder(body) {
  const amount = Number(body.amount);
  const items = Array.isArray(body.items) ? body.items : [];
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const name = String(body.name || '').trim();

  if (!email || !phone || !name) throw new Error('Student name, email, and phone are required.');
  if (!items.length || items.length > 3) throw new Error('Select a valid document item.');

  const hasSkillCertificate = items.some(item => item.id === 'skill-certificate');
  if (hasSkillCertificate && items.length !== 1) throw new Error('Skill certificate must be ordered separately.');
  const skillCourseId = hasSkillCertificate ? String(items[0].courseId || body.courseId || '').trim() : '';
  const skillCoursePrice = hasSkillCertificate ? await getSkillCoursePrice(skillCourseId) : null;

  const cleanItems = items.map(item => {
    const allowed = ALLOWED_ITEMS.get(item.id);
    if (!allowed) throw new Error('Invalid document item.');
    return {
      id: item.id,
      name: allowed.name,
      price: allowed.dynamicPrice ? skillCoursePrice : allowed.price,
      courseId: item.id === 'skill-certificate' ? skillCourseId : undefined
    };
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
  let decodedToken;
  try {
    const body = await getBody(req);
    decodedToken = await verifyFirebaseUser(req);
    order = await validateOrder(body);
    if (order.uid !== decodedToken.uid || order.email !== decodedToken.email) {
      sendJson(res, 403, { error: 'Payment user does not match the logged-in account.' }, origin);
      return;
    }
  } catch (error) {
    const message = error.code && String(error.code).startsWith('auth/')
      ? 'Login is required to create a payment order.'
      : error.message;
    sendJson(res, message.includes('Login is required') ? 401 : 400, { error: message }, origin);
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
      console.error('Cashfree order creation failed:', data);
      sendJson(res, response.status, {
        error: data.message || data.error_description || data.type || 'Cashfree order creation failed.'
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

function getCashfreeKeys() {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  const apiVersion = process.env.CASHFREE_API_VERSION || '2025-01-01';
  if (!clientId || !clientSecret) {
    throw new Error('Cashfree keys are not configured on Render.');
  }
  return { clientId, clientSecret, apiVersion };
}

async function cashfreeRequest(path) {
  const { clientId, clientSecret, apiVersion } = getCashfreeKeys();
  const response = await fetch(`${getCashfreeBaseUrl()}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': apiVersion,
      'x-client-id': clientId,
      'x-client-secret': clientSecret
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error_description || data.type || 'Cashfree verification failed.');
  }
  return data;
}

async function verifyPaidCashfreeOrder({ orderId, amount, uid, email }) {
  if (!orderId) throw new Error('Cashfree order ID is required.');
  const order = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}`);
  const customer = order.customer_details || {};
  const orderAmount = Number(order.order_amount);
  if (orderAmount !== amount || order.order_currency !== 'INR') {
    throw new Error('Cashfree order amount does not match this certificate.');
  }
  if (customer.customer_id !== uid || String(customer.customer_email || '').toLowerCase() !== String(email || '').toLowerCase()) {
    throw new Error('Cashfree order does not belong to the logged-in student.');
  }

  const payments = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}/payments`);
  const list = Array.isArray(payments) ? payments : (payments.payments || []);
  const success = list.some(payment => {
    const status = String(payment.payment_status || payment.status || '').toUpperCase();
    const paidAmount = Number(payment.payment_amount || payment.order_amount || amount);
    return status === 'SUCCESS' && paidAmount === amount;
  });
  if (!success) throw new Error('Cashfree payment is not successful yet.');
}

async function generateSkillCertificateId(db) {
  const year = new Date().getFullYear();
  for (let i = 0; i < 8; i++) {
    const random = Math.floor(1 + Math.random() * 9999);
    const id = `SAT-SC-${year}-${String(random).padStart(4, '0')}`;
    const snap = await db.collection('certificates').doc(id).get();
    if (!snap.exists) return id;
  }
  return `SAT-SC-${year}-${Date.now().toString().slice(-4)}`;
}

async function claimSkillCertificate(req, res, origin) {
  let decodedToken;
  let body;
  try {
    body = await getBody(req);
    decodedToken = await verifyFirebaseUser(req);
  } catch (error) {
    sendJson(res, 401, { error: 'Login is required to unlock a skill certificate.' }, origin);
    return;
  }

  try {
    const courseId = String(body.courseId || '').trim();
    const orderId = String(body.cashfreeOrderId || body.orderId || '').trim();
    const { course, price, isFree } = await getSkillCoursePricing(courseId);
    const db = admin.firestore();
    const attemptId = `${decodedToken.uid}_${courseId}`;
    const attemptSnap = await db.collection('skillCourseAttempts').doc(attemptId).get();
    if (!attemptSnap.exists) throw new Error('Pass this skill course before claiming the certificate.');

    const attempt = attemptSnap.data() || {};
    const passingPercentage = Number(course.passingPercentage || attempt.passingPercentage || 60);
    if (
      attempt.uid !== decodedToken.uid ||
      String(attempt.email || '').toLowerCase() !== String(decodedToken.email || '').toLowerCase() ||
      attempt.passed !== true ||
      Number(attempt.score || 0) < passingPercentage
    ) {
      throw new Error('This account has not passed the skill course.');
    }

    const existing = await db.collection('certificates')
      .where('uid', '==', decodedToken.uid)
      .where('courseId', '==', courseId)
      .where('type', '==', 'skill_course')
      .limit(1)
      .get();
    if (!existing.empty) {
      sendJson(res, 200, { certificateId: existing.docs[0].id, alreadyIssued: true }, origin);
      return;
    }

    if (!isFree) {
      await verifyPaidCashfreeOrder({
        orderId,
        amount: price,
        uid: decodedToken.uid,
        email: decodedToken.email
      });
    }

    const certId = await generateSkillCertificateId(db);
    const issuedAt = admin.firestore.FieldValue.serverTimestamp();
    const courseTitle = course.title || course.domainName || attempt.courseTitle || 'Skill Course';
    const domainName = course.domainName || attempt.domainName || '';
    const level = course.level || attempt.level || 'beginner';
    const batch = db.batch();
    batch.set(db.collection('skillCertificateOrders').doc(certId), {
      uid: decodedToken.uid,
      email: String(decodedToken.email || '').toLowerCase(),
      studentName: attempt.studentName || decodedToken.name || decodedToken.email || '',
      courseId,
      courseTitle,
      domainName,
      level,
      amount: price,
      currency: 'INR',
      paymentStatus: isFree ? 'free' : 'paid',
      cashfreeOrderId: isFree ? '' : orderId,
      verifiedByBackend: true,
      createdAt: issuedAt
    });
    batch.set(db.collection('certificates').doc(certId), {
      type: 'skill_course',
      uid: decodedToken.uid,
      studentName: attempt.studentName || decodedToken.name || decodedToken.email || '',
      email: String(decodedToken.email || '').toLowerCase(),
      domain: domainName,
      courseId,
      courseTitle,
      level,
      score: Number(attempt.score || 0),
      passingPercentage,
      verified: true,
      issueDate: issuedAt
    });
    await batch.commit();
    sendJson(res, 200, { certificateId: certId }, origin);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Could not unlock skill certificate.' }, origin);
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
      paymentEndpoint: '/create-cashfree-order',
      skillCertificateEndpoint: '/claim-skill-certificate'
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

  if (req.method === 'GET' && req.url === '/claim-skill-certificate') {
    sendJson(res, 200, {
      ok: true,
      message: 'Use POST /claim-skill-certificate from the Sathtern website.'
    }, origin);
    return;
  }

  if (req.method === 'POST' && (req.url === '/create-cashfree-order' || req.url === '/')) {
    await createCashfreeOrder(req, res, origin);
    return;
  }

  if (req.method === 'POST' && req.url === '/claim-skill-certificate') {
    await claimSkillCertificate(req, res, origin);
    return;
  }

  sendJson(res, 404, { error: 'Not found' }, origin);
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`Sathtern Cashfree backend listening on ${port}`);
});


