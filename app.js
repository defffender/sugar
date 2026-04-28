// =============================================================
// Конфиг — отредактируй под себя
// =============================================================
const CONFIG = {
  // SHA-256 хэш пароля. Сгенерируй: см. README.md → "Как поставить пароль"
  // Если хэш пустой ("") — гейт пропускает всех.
  PWD_SHA256: "",

  // Откуда брать CSV
  CSV_URL: "data.csv",

  // Целевой диапазон (ммоль/л)
  TIR_LOW: 3.9,
  TIR_HIGH: 10.0,
  // Тяжёлые гипо/гипер
  VLOW: 3.0,
  VHIGH: 13.9,

  // Парсер CSV: попробуем эти колонки в указанном порядке
  COL_TIME_CANDIDATES: ["Time", "Datetime", "Date Time", "Дата и время", "Дата/время", "Дата", "Timestamp", "Date"],
  COL_GLU_CANDIDATES:  ["Glucose (mmol/L)", "Glucose", "Glucose Value", "Глюкоза", "Glucose mmol/L", "BG", "Value"],
};

// =============================================================
// Парольный гейт (хэш SHA-256, не банковская защита, но отсечёт случайных)
// =============================================================
async function sha256(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function gate(){
  const gateEl = document.getElementById("gate");
  const appEl  = document.getElementById("app");
  const err    = document.getElementById("err");

  const open = ()=>{ gateEl.style.display="none"; appEl.hidden=false; init(); };

  if(!CONFIG.PWD_SHA256){ open(); return; }
  if(localStorage.getItem("sg_ok")==="1"){ open(); return; }

  document.getElementById("enter").onclick = async ()=>{
    err.textContent="";
    const v = document.getElementById("pwd").value;
    const h = await sha256(v);
    if(h===CONFIG.PWD_SHA256){ localStorage.setItem("sg_ok","1"); open(); }
    else err.textContent="Неверный пароль";
  };
  document.getElementById("pwd").addEventListener("keydown",e=>{
    if(e.key==="Enter") document.getElementById("enter").click();
  });
}

// =============================================================
// CSV парсер (минималистичный, но устойчивый к запятым в кавычках)
// =============================================================
function parseCSV(text){
  const rows = [];
  let row=[], cur="", inQ=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(inQ){
      if(c==='"' && n==='"'){ cur+='"'; i++; }
      else if(c==='"'){ inQ=false; }
      else cur+=c;
    }else{
      if(c==='"') inQ=true;
      else if(c===',' || c===';' || c==='\t'){ row.push(cur); cur=""; }
      else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=""; }
      else if(c==='\r'){ /* skip */ }
      else cur+=c;
    }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=>r.length && r.some(x=>x!==""));
}

function pickColumn(headers, candidates){
  const norm = h => h.trim().toLowerCase();
  const H = headers.map(norm);
  for(const c of candidates){
    const idx = H.indexOf(c.toLowerCase());
    if(idx>=0) return idx;
  }
  // мягкий поиск по подстроке
  for(const c of candidates){
    const idx = H.findIndex(h=>h.includes(c.toLowerCase()));
    if(idx>=0) return idx;
  }
  return -1;
}

function parseTime(s){
  if(!s) return null;
  s=s.trim();
  // ISO, dd.mm.yyyy hh:mm, yyyy-mm-dd hh:mm
  let d=new Date(s);
  if(!isNaN(d)) return d;
  const m=s.match(/^(\d{2})[./](\d{2})[./](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +(m[6]||0));
  }
  return null;
}

function loadData(text){
  const rows = parseCSV(text);
  if(rows.length<2) throw new Error("CSV пустой");
  // ищем строку с заголовками: первая, где есть и time, и glucose
  let hdrIdx = 0;
  for(let i=0;i<Math.min(rows.length,10);i++){
    const t = pickColumn(rows[i], CONFIG.COL_TIME_CANDIDATES);
    const g = pickColumn(rows[i], CONFIG.COL_GLU_CANDIDATES);
    if(t>=0 && g>=0){ hdrIdx=i; break; }
  }
  const hdr = rows[hdrIdx];
  const ti = pickColumn(hdr, CONFIG.COL_TIME_CANDIDATES);
  const gi = pickColumn(hdr, CONFIG.COL_GLU_CANDIDATES);
  if(ti<0 || gi<0){
    throw new Error("Не нашёл колонки времени и глюкозы. Проверь заголовки: "+hdr.join(" | "));
  }
  const data = [];
  for(let i=hdrIdx+1;i<rows.length;i++){
    const r = rows[i];
    const t = parseTime(r[ti]);
    let v = r[gi];
    if(typeof v==="string") v = v.replace(",", ".").trim();
    const g = parseFloat(v);
    if(t && !isNaN(g)) data.push({t, g});
  }
  data.sort((a,b)=>a.t-b.t);
  return data;
}

// =============================================================
// Метрики
// =============================================================
function computeMetrics(data){
  if(!data.length) return null;
  const xs = data.map(d=>d.g);
  const n = xs.length;
  const sum = xs.reduce((a,b)=>a+b,0);
  const avg = sum/n;
  const sd  = Math.sqrt(xs.reduce((a,b)=>a+(b-avg)*(b-avg),0)/n);
  const cv  = (sd/avg)*100;
  // GMI (mmol/L formula): GMI = 12.71 + 4.7587 * mmol/L → no, that's mg/dL
  // For mmol/L: GMI(%) = 3.31 + 0.02392 * (mean mg/dL); mean mg/dL = mean mmol/L * 18.018
  const gmi = 3.31 + 0.02392 * (avg*18.018);

  let vlow=0,low=0,inr=0,high=0,vhigh=0;
  for(const v of xs){
    if(v<CONFIG.VLOW) vlow++;
    else if(v<CONFIG.TIR_LOW) low++;
    else if(v<=CONFIG.TIR_HIGH) inr++;
    else if(v<=CONFIG.VHIGH) high++;
    else vhigh++;
  }
  const pct = x => (100*x/n);
  return {
    n, avg, sd, cv, gmi,
    pct_vlow: pct(vlow), pct_low: pct(low), pct_in: pct(inr), pct_high: pct(high), pct_vhigh: pct(vhigh),
    from: data[0].t, to: data[data.length-1].t
  };
}

function fmt(x, d=1){ return (x==null||isNaN(x))?"—":x.toFixed(d); }
function fmtDate(d){ return d.toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"2-digit"}); }

function renderMetrics(m){
  if(!m) return;
  document.getElementById("m_avg").textContent = fmt(m.avg,1);
  document.getElementById("m_gmi").textContent = fmt(m.gmi,1);
  document.getElementById("m_sd").textContent  = fmt(m.sd,1);
  document.getElementById("m_cv").textContent  = fmt(m.cv,0);
  document.getElementById("m_n").textContent   = m.n;
  document.getElementById("m_period").textContent = fmtDate(m.from)+" — "+fmtDate(m.to);

  const set = (id,p)=>{ document.getElementById(id).style.width=p+"%"; };
  set("seg_vlow", m.pct_vlow);
  set("seg_low", m.pct_low);
  set("seg_in", m.pct_in);
  set("seg_high", m.pct_high);
  set("seg_vhigh", m.pct_vhigh);

  document.getElementById("p_vlow").textContent = fmt(m.pct_vlow,1)+"%";
  document.getElementById("p_low").textContent  = fmt(m.pct_low,1)+"%";
  document.getElementById("p_in").textContent   = fmt(m.pct_in,1)+"%";
  document.getElementById("p_high").textContent = fmt(m.pct_high,1)+"%";
  document.getElementById("p_vhigh").textContent= fmt(m.pct_vhigh,1)+"%";
}

// =============================================================
// Графики
// =============================================================
let chart=null, hourly=null;

function renderChart(data){
  const ctx=document.getElementById("chart");
  const points=data.map(d=>({x:d.t, y:d.g}));
  if(chart) chart.destroy();
  chart = new Chart(ctx,{
    type:"line",
    data:{ datasets:[{
      label:"Глюкоза, ммоль/л",
      data: points,
      borderColor:"#58a6ff",
      backgroundColor:"rgba(88,166,255,0.1)",
      fill:true,
      tension:0.25,
      pointRadius:0,
      borderWidth:1.5
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      animation:false,
      plugins:{ legend:{display:false} },
      scales:{
        x:{ type:"time", time:{tooltipFormat:"dd.MM.yyyy HH:mm"}, ticks:{color:"#8b949e"}, grid:{color:"#22272e"} },
        y:{
          min:2, max:22,
          ticks:{color:"#8b949e"},
          grid:{
            color: ctx => {
              const v = ctx.tick.value;
              if(v===CONFIG.TIR_LOW || v===CONFIG.TIR_HIGH) return "rgba(63,185,80,0.5)";
              return "#22272e";
            }
          }
        }
      }
    }
  });
}

function renderHourly(data){
  const buckets=Array.from({length:24},()=>[]);
  for(const d of data) buckets[d.t.getHours()].push(d.g);
  const med = arr => {
    if(!arr.length) return null;
    const s=[...arr].sort((a,b)=>a-b);
    const m=Math.floor(s.length/2);
    return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
  };
  const q = (arr,p) => {
    if(!arr.length) return null;
    const s=[...arr].sort((a,b)=>a-b);
    return s[Math.min(s.length-1, Math.floor(p*s.length))];
  };
  const meds = buckets.map(med);
  const q25  = buckets.map(b=>q(b,0.25));
  const q75  = buckets.map(b=>q(b,0.75));
  const labels = Array.from({length:24},(_,i)=>i+":00");

  if(hourly) hourly.destroy();
  hourly = new Chart(document.getElementById("hourly"),{
    type:"line",
    data:{ labels, datasets:[
      { label:"75-й перц.", data:q75, borderColor:"#d29922", backgroundColor:"rgba(210,153,34,0.15)", fill:"+1", pointRadius:0, borderWidth:1 },
      { label:"Медиана",    data:meds, borderColor:"#58a6ff", backgroundColor:"transparent", pointRadius:2, borderWidth:2 },
      { label:"25-й перц.", data:q25, borderColor:"#f0883e", backgroundColor:"transparent", pointRadius:0, borderWidth:1 }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{labels:{color:"#8b949e"}} },
      scales:{
        x:{ ticks:{color:"#8b949e"}, grid:{color:"#22272e"} },
        y:{ min:2, max:18, ticks:{color:"#8b949e"}, grid:{color:"#22272e"} }
      }
    }
  });
}

// =============================================================
// Фильтр диапазона
// =============================================================
let ALL=[];
function applyRange(rangeKey){
  let from=null;
  if(rangeKey!=="all"){
    const days=parseInt(rangeKey,10);
    from=new Date(Date.now()-days*86400000);
  }
  const filtered = from ? ALL.filter(d=>d.t>=from) : ALL;
  renderMetrics(computeMetrics(filtered));
  renderChart(filtered);
  renderHourly(filtered);
}

// =============================================================
// Init
// =============================================================
async function init(){
  const status = document.getElementById("status");
  try{
    status.textContent = "Загружаю CSV…";
    const r = await fetch(CONFIG.CSV_URL+"?t="+Date.now());
    if(!r.ok) throw new Error("HTTP "+r.status);
    const text = await r.text();
    ALL = loadData(text);
    if(!ALL.length) throw new Error("Нет валидных записей");
    status.textContent = "Записей: "+ALL.length;
    applyRange("7");
    document.querySelectorAll(".range button").forEach(b=>{
      b.onclick=()=>{
        document.querySelectorAll(".range button").forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        applyRange(b.dataset.range);
      };
    });
  }catch(e){
    status.textContent = "Ошибка: "+e.message;
    console.error(e);
  }
}

gate();
