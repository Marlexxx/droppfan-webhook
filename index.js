const express = require('express');
const crypto  = require('crypto');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { google } = require('googleapis');

const app = express();

const DROPP_API_KEY    = process.env.DROPP_API_KEY;
const WEBHOOK_SECRET   = process.env.DROPP_WEBHOOK_SECRET;
const SALES_CHANNEL_ID = '1475643785307492557';
const SHEET_ID         = process.env.SHEET_ID;

const CHATTERS = {
  '1': { name: 'Daniel',  channelId: '1475713586751078410' },
  '2': { name: 'Hélène',  channelId: '1475713792967970980' },
  '3': { name: 'Rozen',   channelId: '1475713925227216916' },
  '4': { name: 'Temad',   channelId: '1480372709496983621' },
  '5': { name: 'Canal',   channelId: '1475722814320283812' }
};

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function findEmailInSheet(email) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await sheetsAuth.getClient() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Feuille 1!A:I'
    });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][4] === email) {
        return { found: true, rowIndex: i + 1, currentTotal: parseFloat(rows[i][8]) || 0 };
      }
    }
    return { found: false };
  } catch (err) {
    console.error('❌ Erreur findEmailInSheet:', err.message);
    return { found: false };
  }
}

async function updateTotalInSheet(rowIndex, newTotal) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await sheetsAuth.getClient() });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Feuille 1!I${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newTotal]] }
    });
  } catch (err) {
    console.error('❌ Erreur updateTotalInSheet:', err.message);
  }
}

// ─── DISCORD ──────────────────────────────────────────────────────────────────
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
let discordReady = false;

discordClient.once('ready', () => {
  console.log('✅ Discord bot prêt');
  discordReady = true;
});
discordClient.login(process.env.DISCORD_BOT_TOKEN);

async function waitForDiscord() {
  if (discordReady) return;
  await Promise.race([
    new Promise(resolve => discordClient.once('ready', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Discord timeout')), 10000))
  ]);
}

// ─── VERIFY SIGNATURE ─────────────────────────────────────────────────────────
function verifySignature(rawBody, headers) {
  const timestamp = headers['x-dropp-timestamp'];
  const signature = headers['x-dropp-signature'];

  if (!timestamp || !signature) {
    console.log('❌ Signature: headers manquants', { timestamp: !!timestamp, signature: !!signature });
    return false;
  }

  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) {
    console.log(`❌ Signature: timestamp trop vieux (${age}s)`);
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  try {
    const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) console.log('❌ Signature: hash incorrect');
    return valid;
  } catch (err) {
    console.log('❌ Signature: erreur comparaison', err.message);
    return false;
  }
}

// ─── ORDER DETAILS ────────────────────────────────────────────────────────────
async function getOrderDetails(orderId) {
  try {
    const res = await fetch(`https://api.external.dropp.fans/v1/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${DROPP_API_KEY}` }
    });
    return await res.json();
  } catch (err) {
    console.error('❌ Erreur getOrderDetails:', err.message);
    return null;
  }
}

// ─── BUILD BUTTONS ────────────────────────────────────────────────────────────
function buildClaimRows(msgId, withLinkButton = false) {
  const keys = Object.keys(CHATTERS);
  const rows = [];

  for (let i = 0; i < keys.length; i += 4) {
    const row = new ActionRowBuilder();
    keys.slice(i, i + 4).forEach(key => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_${key}_${msgId}`)
          .setLabel(CHATTERS[key].name)
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  if (withLinkButton) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`link_telegram_${msgId}`)
          .setLabel('🔗 Lier le Telegram')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  return rows;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.use(express.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
  const rawBody = req.body;

  if (!verifySignature(rawBody, req.headers)) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(rawBody);
  console.log(`📩 Event reçu: ${payload.event}`);

  if (payload.event === 'order.paid') {
    // Répond immédiatement à Dropp → évite les retries et le délai
    res.status(200).send('OK');

    try {
      await waitForDiscord();

      const orderId      = payload.data.id;
      const montantCents = payload.data.amount.total_cents;
      const montant      = (montantCents / 100).toFixed(2);
      const linkName     = payload.data.link?.name || 'inconnu';

      console.log(`💰 Vente reçue: ${montant}€ | order: ${orderId}`);

      const [order, channel] = await Promise.all([
        getOrderDetails(orderId),
        discordClient.channels.fetch(SALES_CHANNEL_ID)
      ]);

      const email      = order?.data?.buyer?.email || 'inconnu';
      const clientName = order?.data?.buyer?.name  || 'N/A';

      console.log(`📧 Email: ${email} | Client: ${clientName}`);

      const sheetResult = await findEmailInSheet(email);

      if (sheetResult.found) {
        const newTotal = sheetResult.currentTotal + parseFloat(montant);

        const [msg] = await Promise.all([
          channel.send({
            content: `@everyone **New payment received** 🤑 *(spender connu)*\n**Montant :** ${montant} EUR\n**Client :** ${clientName}\n**Email :** ${email}\n**Produit :** ${linkName}\n**Total dépensé :** ${newTotal.toFixed(2)} EUR`
          }),
          updateTotalInSheet(sheetResult.rowIndex, newTotal)
        ]);

        await msg.edit({ components: buildClaimRows(msg.id, false) });
        console.log(`✅ Notif envoyée (spender connu) | total: ${newTotal}€`);

      } else {
        const msg = await channel.send({
          content: `@everyone **New payment received** 🤑\n**Montant :** ${montant} EUR\n**Client :** ${clientName}\n**Email :** ${email}\n**Produit :** ${linkName}`
        });

        await msg.edit({ components: buildClaimRows(msg.id, true) });
        console.log(`✅ Notif envoyée (nouveau spender)`);
      }

    } catch (err) {
      console.error('❌ Erreur traitement webhook:', err.message || err);
    }

    return;
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Dropp webhook running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server sur port ${PORT}`));
