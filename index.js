const express = require('express');
const crypto = require('crypto');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { google } = require('googleapis');

const app = express();

const DROPP_API_KEY = process.env.DROPP_API_KEY;
const WEBHOOK_SECRET = process.env.DROPP_WEBHOOK_SECRET;
const SALES_CHANNEL_ID = '1475643785307492557';
const SHEET_ID = process.env.SHEET_ID;

const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function findEmailInSheet(email) {
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
}

async function updateTotalInSheet(rowIndex, newTotal) {
  const sheets = google.sheets({ version: 'v4', auth: await sheetsAuth.getClient() });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Feuille 1!I${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[newTotal]] }
  });
}

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
let discordReady = false;
discordClient.once('ready', () => {
  console.log('✅ Discord bot prêt');
  discordReady = true;
});
discordClient.login(process.env.DISCORD_BOT_TOKEN);

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

async function waitForDiscord() {
  if (discordReady) return;
  await new Promise(resolve => discordClient.once('ready', resolve));
}

app.post('/webhook', async (req, res) => {
  const rawBody = req.body;

  if (!verifySignature(rawBody, req.headers)) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(rawBody);
  console.log(`📩 Event reçu: ${payload.event}`);

  if (payload.event === 'order.paid') {
    await waitForDiscord();

    const orderId = payload.data.id;
    const montantCents = payload.data.amount.total_cents;
    const montant = (montantCents / 100).toFixed(2);
    const linkName = payload.data.link?.name || 'inconnu';

    const order = await getOrderDetails(orderId);
    const email = order?.data?.buyer?.email || 'inconnu';
    const clientName = order?.data?.buyer?.name || 'N/A';

    console.log(`💰 Vente: ${montant}€ | ${email}`);

    // Cherche l'email dans Sheets
    const sheetResult = await findEmailInSheet(email);

    const channel = await discordClient.channels.fetch(SALES_CHANNEL_ID);

    if (sheetResult.found) {
      // Email déjà connu → update le total
      const newTotal = sheetResult.currentTotal + parseFloat(montant);
      await updateTotalInSheet(sheetResult.rowIndex, newTotal);
      console.log(`🔄 Spender connu, total mis à jour: ${newTotal}€`);

      // Notif Discord sans bouton lier telegram
      const CHATTERS = {
        '1': 'Daniel', '2': 'Hélène', '3': 'Rozen', '4': 'Temad', '5': 'Canal'
      };
      const keys = Object.keys(CHATTERS);
      const msg = await channel.send({
        content: `@everyone **New payment received** 🤑 *(spender connu)*\n**Montant :** ${montant} EUR\n**Client :** ${clientName}\n**Email :** ${email}\n**Produit :** ${linkName}\n**Total dépensé :** ${newTotal.toFixed(2)} EUR`
      });

      const realRows = [];
      for (let i = 0; i < keys.length; i += 4) {
        const row = new ActionRowBuilder();
        keys.slice(i, i + 4).forEach(key => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`claim_${key}_${msg.id}`)
              .setLabel(CHATTERS[key])
              .setStyle(ButtonStyle.Primary)
          );
        });
        realRows.push(row);
      }
      await msg.edit({ components: realRows });

    } else {
      // Nouveau spender → notif avec bouton lier telegram
      const CHATTERS = {
        '1': 'Daniel', '2': 'Hélène', '3': 'Rozen', '4': 'Temad', '5': 'Canal'
      };
      const keys = Object.keys(CHATTERS);

      const msg = await channel.send({
        content: `@everyone **New payment received** 🤑\n**Montant :** ${montant} EUR\n**Client :** ${clientName}\n**Email :** ${email}\n**Produit :** ${linkName}`
      });

      const realRows = [];
      for (let i = 0; i < keys.length; i += 4) {
        const row = new ActionRowBuilder();
        keys.slice(i, i + 4).forEach(key => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`claim_${key}_${msg.id}`)
              .setLabel(CHATTERS[key])
              .setStyle(ButtonStyle.Primary)
          );
        });
        realRows.push(row);
      }

      const realLinkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`link_telegram_${msg.id}`)
          .setLabel('🔗 Lier le Telegram')
          .setStyle(ButtonStyle.Secondary)
      );
      realRows.push(realLinkRow);

      await msg.edit({ components: realRows });
    }
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Dropp webhook running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server sur port ${PORT}`));
