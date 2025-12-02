// index.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const app = express();

const UPSTREAM = process.env.SOURCE_API;
const UPSTREAM_USER = process.env.SOURCE_USER;
const UPSTREAM_PASS = process.env.SOURCE_PASS;
const PORT = process.env.PORT || 3000;

// OData incoming auth credentials (protects clients calling /odata/*)
const ODATA_USER = process.env.ODATA_USER; // e.g. set in .env
const ODATA_PASS = process.env.ODATA_PASS;

const basicAuthHeaderForUpstream = UPSTREAM_USER && UPSTREAM_PASS
  ? 'Basic ' + Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString('base64')
  : null;

// helper: safe equals (prevents timing attacks) for Buffers
function safeEqual(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Middleware: require Basic Auth for /odata routes when ODATA_USER/ODATA_PASS are present
function requireBasicAuth(req, res, next) {
  // If no ODATA credentials configured, skip auth (but log)
  if (!ODATA_USER || !ODATA_PASS) {
    console.warn('ODATA_USER/ODATA_PASS not set — skipping incoming OData Basic Auth (not recommended for production).');
    return next();
  }

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="OData"');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const base64Cred = auth.slice('Basic '.length);
  let decoded;
  try {
    decoded = Buffer.from(base64Cred, 'base64').toString('utf8');
  } catch (e) {
    res.set('WWW-Authenticate', 'Basic realm="OData"');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const split = decoded.split(':');
  const user = split.shift();
  const pass = split.join(':'); // allow colons in password

  // perform timing-safe comparison
  if (safeEqual(user, ODATA_USER) && safeEqual(pass, ODATA_PASS)) {
    return next();
  } else {
    res.set('WWW-Authenticate', 'Basic realm="OData"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Attach auth middleware to OData routes
app.use('/odata', requireBasicAuth);


// --- existing proxy implementation below ---

// Normalize data types from sample API
function normalizeItem(item) {
  const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  return {
    id: toNum(item.id),
    outlet: item.outlet ?? null,
    date: item.date ?? null,
    day: item.day ?? null,
    guest_count: toNum(item.guest_count),
    category: item.category ?? null,
    quantity: toNum(item.quantity),
    cost_price: toNum(item.cost_price),
    selling_price: toNum(item.selling_price),
    total_sales: toNum(item.total_sales),
    total_cost_price: toNum(item.total_cost_price),
    profit: toNum(item.profit)
  };
}

// Simple OData $filter parser
function parseSimpleFilter(filter) {
  if (!filter) return null;

  filter = filter.trim();

  // Field eq 'string'
  let m = filter.match(/^([\w\d_]+)\s+eq\s+'([^']*)'$/);
  if (m) return { field: m[1], value: m[2], type: "string" };

  // Field eq 123
  m = filter.match(/^([\w\d_]+)\s+eq\s+([+-]?\d+(\.\d+)?)$/);
  if (m) return { field: m[1], value: Number(m[2]), type: "number" };

  // Field eq 2025-08-01
  m = filter.match(/^([\w\d_]+)\s+eq\s+(\d{4}-\d{2}-\d{2})$/);
  if (m) return { field: m[1], value: m[2], type: "date" };

  return null;
}

app.get('/odata/Transactions', async (req, res) => {
  try {
    const { $top, $skip, $orderby, $filter, $count } = req.query;

    const upstreamUrl = UPSTREAM;

    // add a short timeout using AbortController to avoid long hangs
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s

    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        ...(basicAuthHeaderForUpstream ? { Authorization: basicAuthHeaderForUpstream } : {}),
        Accept: "application/json"
      },
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      return res.status(500).json({ error: "Upstream API error", status: response.status });
    }

    let data = await response.json();
    let items = Array.isArray(data) ? data : [];

    // Normalize all records
    items = items.map(normalizeItem);

    // Apply server-side $filter (simple eq)
    const parsedFilter = parseSimpleFilter($filter);
    if (parsedFilter) {
      items = items.filter((i) => {
        const val = i[parsedFilter.field];
        if (parsedFilter.type === "number") return Number(val) === parsedFilter.value;
        if (parsedFilter.type === "date") return String(val).startsWith(parsedFilter.value);
        return String(val) === parsedFilter.value;
      });
    }

    // Apply $orderby
    if ($orderby) {
      const [field, direction] = $orderby.split(" ");
      const dir = direction === "desc" ? -1 : 1;

      items.sort((a, b) => {
        if (a[field] > b[field]) return dir;
        if (a[field] < b[field]) return -dir;
        return 0;
      });
    }

    // Apply $skip
    if ($skip) items = items.slice(Number($skip));

    // Apply $top
    if ($top) items = items.slice(0, Number($top));

    const odataResponse = {
      "@odata.context": `${req.protocol}://${req.get("host")}/odata/$metadata#Transactions`,
      value: items
    };

    if ($count === "true") {
      odataResponse["@odata.count"] = items.length;
    }

    res.json(odataResponse);
  } catch (error) {
    console.error("ERROR:", error);
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    res.status(500).json({ error: error.message });
  }
});

// OData metadata endpoint
app.get('/odata/$metadata', (req, res) => {
  const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0"
 xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Proxy"
     xmlns="http://docs.oasis-open.org/odata/ns/schema">

      <EntityType Name="Transaction">
        <Key><PropertyRef Name="id"/></Key>

        <Property Name="id" Type="Edm.Int32"/>
        <Property Name="outlet" Type="Edm.String"/>
        <Property Name="date" Type="Edm.String"/>
        <Property Name="day" Type="Edm.String"/>
        <Property Name="guest_count" Type="Edm.Int32"/>
        <Property Name="category" Type="Edm.String"/>
        <Property Name="quantity" Type="Edm.Double"/>
        <Property Name="cost_price" Type="Edm.Double"/>
        <Property Name="selling_price" Type="Edm.Double"/>
        <Property Name="total_sales" Type="Edm.Double"/>
        <Property Name="total_cost_price" Type="Edm.Double"/>
        <Property Name="profit" Type="Edm.Double"/>
      </EntityType>

      <EntityContainer Name="Container">
        <EntitySet Name="Transactions" EntityType="Proxy.Transaction"/>
      </EntityContainer>

    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  res.set("Content-Type", "application/xml");
  res.send(metadata);
});

app.listen(PORT, () =>
  console.log(`OData service running on port ${PORT}`)
);
