const express = require('express');
const crypto = require('crypto');
const app = express();

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const DROPP_API_KEY = process.env.DROPP_API_KEY;
const WEBHOOK_SECRET = process.env.DROPP_WEBHOOK_SECRET;

app.use(express.raw({ type: 'application/json' }));

function verifySignature(rawBody, headers) {
  const timestamp = headers['x-dropp-timestamp'];
  const signature = headers['x-dropp-signature'];
  if (!timestamp || !signature) return false;
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp) > 300) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function getOrderDetails(orderId) {
  const res = await fetch(`https://api.external.dropp.fans/v1/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${DROPP_API_KEY}` }
  });
  return await res.json();
}

async function sendDiscord(montant, clientName, email, linkName) {
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `@everyone **New payment received** 🤑\n**Montant :** ${montant} EUR\n**Client :** ${clientName}\n**Email :** ${email}\n**Produit :** ${linkName}`
    })
  });
}

app.post('/webhook', async (req, res) => {
  const rawBody = req.body;

  if (!verifySignature(rawBody, req.headers)) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(rawBody);
  console.log(`📩 Event reçu: ${payload.event}`);

 if (payload.event === 'order.paid'  {
    const orderId = payload.data.id;
    const montantCents = payload.data.amount.total_cents;
    const montant = (montantCents / 100).toFixed(2);
    const linkName = payload.data.link?.name || 'inconnu';

    // Récupère les détails de l'order pour avoir l'email
    const order = await getOrderDetails(orderId);
    const email = order?.buyer?.email || 'inconnu';
    const clientName = order?.buyer?.name || 'N/A';

    console.log(`💰 Vente: ${montant}€ | ${email}`);
    await sendDiscord(montant, clientName, email, linkName);
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Dropp webhook running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server sur port ${PORT}`));
