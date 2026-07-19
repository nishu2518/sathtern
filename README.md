# Sathtern Cashfree Backend on Render

Use this small backend only for Cashfree order creation. Your main website stays on Firebase.

## Render settings

- Service type: Web Service
- Root directory: `render-cashfree`
- Build command: `npm install`
- Start command: `npm start`

## Environment variables

Add these in Render Dashboard > Environment:

```bash
CASHFREE_CLIENT_ID=your_cashfree_client_id
CASHFREE_CLIENT_SECRET=your_cashfree_client_secret
CASHFREE_ENV=production
CASHFREE_API_VERSION=2025-01-01
```

For sandbox testing use:

```bash
CASHFREE_ENV=sandbox
```

## After Render deploy

Copy your Render URL, then update:

```js
// ../js/payment-config.js
window.SATHTERN_CASHFREE_CREATE_ORDER_URL = 'https://your-render-service.onrender.com/create-cashfree-order';
```

Then deploy only Firebase hosting/rules:

```bash
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

No Firebase Functions deployment is needed when using Render.
