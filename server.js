require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const PDFDocument = require('pdfkit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Enable CORS
// For dev, allow all origins. For prod, change "*" to your actual frontend domains.
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

const UPDATE_INTERVAL = 15 * 60 * 1000; // 15 min
const BASE_ENTRIES = 500;
const MAX_ENTRIES = 10_000_000;

let cachedLeaderboard = [];
let lastUpdate = null;
let isUpdating = false;
let cachedPrice = 0;
let lastPriceSource = "cache";

// === Blacklist addresses here ===
const BLACKLIST = [
  "11111111111111111111111111111111", // Example burn
  "YourTreasuryWalletHere",
  "LPVaultWalletHere"
];

// --- Smooth multiplier logic (continuous, capped at 10x) ---
function getMultiplier(pct) {
  if (pct < 0.001) return 8.0;

  if (pct < 0.01) {
    const t = (pct - 0.001) / (0.01 - 0.001);
    return Number((8.0 + t * 1.0).toFixed(4));
  }

  if (pct < 0.1) {
    const t = (pct - 0.01) / (0.1 - 0.01);
    return Number((9.0 + t * 1.0).toFixed(4));
  }

  return 10.0; // cap
}

// --- Dynamic min token thresholds based on market cap ---
function getMinTokensForEntries(marketCap) {
  if (marketCap < 200_000) return 100;   // under $200k → 100 tokens
  if (marketCap < 2_000_000) return 10;  // under $2M → 10 tokens
  return 1;                              // $2M+ → 1 token
}

// --- Helper: Get decimals and supply ---
async function getTokenDecimalsAndSupply(apiKey, token) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenSupply",
    params: [token]
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!data.result || !data.result.value) throw new Error("Couldn't fetch token supply or decimals");
  const decimals = data.result.value.decimals;
  const supplyRaw = data.result.value.amount;
  const supply = Number(supplyRaw) / Math.pow(10, decimals);
  return { decimals, supply };
}

// --- Helper: Fetch all holders paginated ---
async function fetchAllHolders(apiKey, token, decimals) {
  const owners = {};
  let page = 1;
  const limit = 1000;
  let hasMore = true;
  while (hasMore) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const body = {
      jsonrpc: "2.0",
      method: "getTokenAccounts",
      id: "1",
      params: { mint: token, page, limit, displayOptions: {} }
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!data.result?.token_accounts) break;
    data.result.token_accounts.forEach(acc => {
      owners[acc.owner] = (owners[acc.owner] || 0) + Number(acc.amount) / Math.pow(10, decimals);
    });
    if (data.result.token_accounts.length < limit) {
      hasMore = false;
    } else {
      page++;
    }
  }
  return owners;
}

// --- Helper: Fetch token price (PumpFun → DexScreener → Jupiter) ---
async function fetchTokenPrice(mint) {
  try {
    // PumpFun
    const pumpUrl = `https://frontend-api.pump.fun/coins/${mint}`;
    const pumpResp = await fetch(pumpUrl);
    if (pumpResp.ok) {
      const pumpData = await pumpResp.json();
      if (pumpData?.usdPrice) {
        cachedPrice = Number(pumpData.usdPrice);
        lastPriceSource = "pumpfun";
        console.log(`[PRICE] ${mint} from Pump.fun: $${cachedPrice}`);
        return cachedPrice;
      }
    }

    // DexScreener
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const dexResp = await fetch(dexUrl);
    if (dexResp.ok) {
      const dexData = await dexResp.json();
      if (dexData?.pairs?.[0]?.priceUsd) {
        cachedPrice = Number(dexData.pairs[0].priceUsd);
        lastPriceSource = "dexscreener";
        console.log(`[PRICE] ${mint} from DexScreener: $${cachedPrice}`);
        return cachedPrice;
      }
    }

    // Jupiter
    const jupUrl = `https://price.jup.ag/v6/price?ids=${mint}&vsToken=USDC`;
    const jupResp = await fetch(jupUrl);
    if (jupResp.ok) {
      const jupData = await jupResp.json();
      if (jupData?.data?.[mint]?.price) {
        cachedPrice = Number(jupData.data[mint].price);
        lastPriceSource = "jupiter";
        console.log(`[PRICE] ${mint} from Jupiter: $${cachedPrice}`);
        return cachedPrice;
      }
    }
  } catch (err) {
    console.error("Price fetch failed:", err);
  }
  lastPriceSource = "cache";
  return cachedPrice;
}

// --- Main leaderboard calculation and cache ---
async function updateLeaderboard() {
  try {
    isUpdating = true;
    const token = process.env.DEFAULT_TOKEN || '';
    const apiKey = process.env.HELIUS_KEY;
    if (!token || !apiKey) throw new Error('Missing token or API key');

    const { decimals, supply } = await getTokenDecimalsAndSupply(apiKey, token);
    const owners = await fetchAllHolders(apiKey, token, decimals);
    const tokenPrice = await fetchTokenPrice(token);

    const marketCap = supply * tokenPrice;
    const minTokens = getMinTokensForEntries(marketCap);
    console.log(`[THRESHOLD] Market cap $${marketCap.toLocaleString()} → minTokens = ${minTokens}`);

    const holdersArray = Object.entries(owners)
      .map(([wallet, balance]) => ({ wallet, balance: Number(balance) }))
      .filter(holder => !BLACKLIST.includes(holder.wallet))
      .sort((a, b) => b.balance - a.balance);

    const leaderboard = holdersArray.map((holder, idx) => {
      const pct = (holder.balance / supply) * 100;
      let multiplier = 0;
      let entries = 0;
      let multipliedEntries = 0;
      let baseEntries = 0;
      let formRequired = false;

      if (holder.balance >= minTokens) {
        multiplier = Math.min(getMultiplier(pct), 10);
        multipliedEntries = Math.floor(holder.balance * multiplier);
        baseEntries = BASE_ENTRIES;
        entries = baseEntries + multipliedEntries;
        if (entries > MAX_ENTRIES) entries = MAX_ENTRIES;
      } else {
        multiplier = 0;
        entries = 0;
        formRequired = true;
      }

      const currentValue = holder.balance * tokenPrice;

      return {
        rank: idx + 1,
        wallet: holder.wallet,
        balance: holder.balance,
        pct,
        multiplier,
        multipliedEntries,
        baseEntries,
        entries,
        currentValue,
        source: lastPriceSource,
        formRequired,
      };
    });

    cachedLeaderboard = leaderboard;
    lastUpdate = new Date();
    isUpdating = false;
    console.log(`Leaderboard updated: ${cachedLeaderboard.length} holders (after blacklist) at ${lastUpdate.toISOString()}`);
  } catch (err) {
    isUpdating = false;
    console.error('Leaderboard update error:', err);
  }
}

// --- Leaderboard endpoint ---
app.get('/leaderboard', (req, res) => {
  if (isUpdating && !cachedLeaderboard.length) return res.json([]);
  res.json(cachedLeaderboard.slice(0, 250));
});

// --- PDF Download endpoint ---
app.get('/download', (req, res) => {
  if (!cachedLeaderboard.length) return res.status(503).send('Leaderboard not ready');
  const doc = new PDFDocument({ margin: 30 });
  res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.pdf"');
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  doc.fontSize(18).text('Leaderboard Snapshot', { align: 'center' });
  doc.fontSize(10).moveDown();
  doc.text(`Snapshot Date: ${new Date().toLocaleString()}`);
  doc.moveDown();
  doc.text(`Rules: Hold >= dynamic min tokens (100 / 10 / 1), +500 base entries, max 10x multiplier, max 10M entries.`);
  doc.moveDown();
  doc.font('Helvetica-Bold').text(
    'Rank    Wallet    Balance    % Supply    Multiplier   Multiplied   Base   Entries   Current Value   Source   Form Required'
  );
  doc.font('Helvetica').moveDown(0.5);

  cachedLeaderboard.forEach(entry => {
    doc.text(
      String(entry.rank).padEnd(6) +
      String(entry.wallet).padEnd(45) +
      String(entry.balance).padEnd(15) +
      String(entry.pct.toFixed(6)).padEnd(12) +
      String(entry.multiplier).padEnd(12) +
      String(entry.multipliedEntries).padEnd(12) +
      String(entry.baseEntries).padEnd(8) +
      String(entry.entries).padEnd(10) +
      String(entry.currentValue.toFixed(2)).padEnd(15) +
      String(entry.source).padEnd(12) +
      (entry.formRequired ? 'YES' : 'NO')
    );
  });

  doc.end();
});

// --- /myentries endpoint ---
app.get('/myentries', (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet) return res.status(400).json({ error: 'Wallet address required' });
  if (BLACKLIST.includes(wallet)) return res.json({ error: "This wallet is blacklisted" });

  const found = cachedLeaderboard.find(entry => entry.wallet === wallet);
  if (found) return res.json(found);
  res.json({
    rank: null, wallet, balance: 0,
    multiplier: 0, multipliedEntries: 0, baseEntries: 0,
    entries: 0, pct: 0, currentValue: 0,
    source: lastPriceSource, formRequired: true,
    message: "Not ranked or no tokens held"
  });
});

// --- /wallet/:address endpoint ---
app.get('/wallet/:address', (req, res) => {
  const address = req.params.address;
  if (!address) return res.status(400).json({ error: "Wallet address required" });
  if (BLACKLIST.includes(address)) return res.json({ error: "This wallet is blacklisted" });

  const found = cachedLeaderboard.find(entry => entry.wallet === address);
  if (found) return res.json(found);
  res.json({
    rank: null, wallet: address, balance: 0,
    multiplier: 0, multipliedEntries: 0, baseEntries: 0,
    entries: 0, pct: 0, currentValue: 0,
    source: lastPriceSource, formRequired: true,
    message: "Not ranked or no tokens held"
  });
});

// --- /price endpoint ---
app.get('/price', async (req, res) => {
  const token = process.env.DEFAULT_TOKEN || '';
  if (!token) return res.status(400).json({ error: 'Missing DEFAULT_TOKEN' });
  const price = await fetchTokenPrice(token);
  res.json({ token, price, source: lastPriceSource, lastUpdated: new Date().toISOString() });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Server live on http://localhost:${PORT}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, UPDATE_INTERVAL);
});
