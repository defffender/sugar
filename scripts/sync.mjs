// Tidepool → data.csv
// Запускается из GitHub Actions раз в 5 минут.
// Требует env: TIDEPOOL_EMAIL, TIDEPOOL_PASSWORD, DAYS_BACK (опционально).

import { writeFile } from "node:fs/promises";

const TIDEPOOL_API = "https://api.tidepool.org";

const email = process.env.TIDEPOOL_EMAIL;
const password = process.env.TIDEPOOL_PASSWORD;
const daysBack = parseInt(process.env.DAYS_BACK || "30", 10);

if (!email || !password) {
  console.error("Missing TIDEPOOL_EMAIL or TIDEPOOL_PASSWORD");
  process.exit(1);
}

// 1) Логин
const auth = Buffer.from(`${email}:${password}`).toString("base64");
const loginRes = await fetch(`${TIDEPOOL_API}/auth/login`, {
  method: "POST",
  headers: { Authorization: `Basic ${auth}` },
});
if (!loginRes.ok) {
  throw new Error(`Tidepool login failed: ${loginRes.status} ${await loginRes.text()}`);
}
const sessionToken = loginRes.headers.get("x-tidepool-session-token");
if (!sessionToken) throw new Error("No session token in Tidepool response");
const { userid: userId } = await loginRes.json();
if (!userId) throw new Error("No userid in Tidepool response");

// 2) Данные глюкозы за последние N дней
const endDate = new Date().toISOString();
const startDate = new Date(Date.now() - daysBack * 86400000).toISOString();
const dataUrl =
  `${TIDEPOOL_API}/data/${userId}?type=cbg,smbg` +
  `&startDate=${encodeURIComponent(startDate)}` +
  `&endDate=${encodeURIComponent(endDate)}`;
const dataRes = await fetch(dataUrl, {
  headers: { "x-tidepool-session-token": sessionToken },
});
if (!dataRes.ok) {
  throw new Error(`Tidepool data fetch failed: ${dataRes.status} ${await dataRes.text()}`);
}
const entries = await dataRes.json();

// 3) Фильтр + конвертация (в Tidepool иногда mg/dL — эвристика по >30)
const filtered = entries
  .filter((e) => e.value != null && e.time)
  .map((e) => ({
    time: new Date(e.time),
    glucose: e.value > 30 ? e.value / 18.018 : e.value,
  }))
  .sort((a, b) => a.time - b.time);

// Защита от перезаписи CSV пустым ответом (например, при сетевом сбое Tidepool)
if (filtered.length === 0) {
  console.error("Tidepool returned 0 entries — aborting to avoid wiping data.csv");
  process.exit(2);
}

// 4) Пишем CSV (ISO 8601 UTC; app.js рисует в Asia/Novosibirsk)
let csv = "Time,Glucose (mmol/L)\n";
for (const r of filtered) {
  csv += `${r.time.toISOString().substring(0, 19)}Z,${r.glucose.toFixed(2)}\n`;
}
await writeFile("data.csv", csv);

console.log(
  `OK: ${filtered.length} entries, ${csv.length} bytes, ` +
    `range ${filtered[0].time.toISOString()} → ${filtered.at(-1).time.toISOString()}`
);
