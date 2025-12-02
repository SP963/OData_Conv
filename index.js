// index.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();

const UPSTREAM = process.env.SOURCE_API;
const UPSTREAM_USER = process.env.SOURCE_USER;
const UPSTREAM_PASS = process.env.SOURCE_PASS;
const PORT = process.env.PORT || 3000;

// Basic Auth header
const basicAuthHeader = 'Basic ' + Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString('base64');

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

    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader,
        Accept: "application/json"
      }
    });

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
