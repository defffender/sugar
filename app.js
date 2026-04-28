// =============================================================
// Конфиг
// =============================================================
const CONFIG = {
  PWD_SHA256: "",                  // SHA-256 пароля; пусто = без пароля
  CSV_URL: "data.csv",
  TIR_LOW: 3.9, TIR_HIGH: 10.0,
  VLOW: 3.0,    VHIGH: 13.9,
  // Считается, что сенсор семплит каждые ~5 минут (стандарт CGM)
  EXPECTED_INTERVAL_MIN: 5,
  // Свежесть текущего значения для оценки тренда (минуты)
  CURRENT_FRESH_MIN: 20,
  TREND_WINDOW_MIN: 15,
  COL_TIME_CANDIDATES: ["Time","Datetime","Date Time","Дата и время","Дата/время","Дата","Timestamp","Date"],
  COL_GLU_CANDIDATES:  ["Glucose (mmol/L)","Glucose","Glucose Value","Глюкоза","Glucose mmol/L","BG","Value"],
};

// =============================================================
// Парольный гейт
// =============================================================
async function sha256(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function gate(){
  const gateEl=document.getElementById("gate"), appEl=document.getElementById("app"), err=document.getElementById("err");
  const open=()=>{ gateEl.style.display="none"; appEl.hidden=false; init(); };
  if(!CONFIG.PWD_SHA256){ open(); return; }
  if(localStorage.getItem("sg_ok")==="1"){ open(); return; }
  document.getElementById("enter").onclick = async ()=>{
    err.textContent="";
    const h = await sha256(document.getElementById("pwd").value);
    if(h===CONFIG.PWD_SHA256){ localStorage.setItem("sg_ok","1"); open(); }
    else err.textContent="Неверный пароль";
  };
  document.getElementById("pwd").addEventListener("keydown",e=>{
    if(e.key==="Enter") document.getElementById("enter").click();
  });
}

// =============================================================
// CSV
// =============================================================
function parseCSV(text){
  const rows=[]; let row=[],cur="",inQ=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(inQ){
      if(c==='"' && n==='"'){ cur+='"'; i++; }
      else if(c==='"'){ inQ=false; }
      else cur+=c;
    } else {
      if(c==='"') inQ=true;
      else if(c===',' || c===';' || c==='\t'){ row.push(cur); cur=""; }
      else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=""; }
      else if(c==='\r'){}
      else cur+=c;
    }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=>r.length && r.some(x=>x!==""));
}
function pickColumn(headers,candidates){
  const H=headers.map(h=>h.trim().toLowerCase());
  for(const c of candidates){ const i=H.indexOf(c.toLowerCase()); if(i>=0) return i; }
  for(const c of candidates){ const i=H.findIndex(h=>h.includes(c.toLowerCase())); if(i>=0) return i; }
  return -1;
}
function parseTime(s){
  if(!s) return null;
  s=s.trim();
  let d=new Date(s); if(!isNaN(d)) return d;
  const m=s.match(/^(\d{2})[./](\d{2})[./](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +(m[6]||0));
  return null;
}
function loadData(text){
  const rows=parseCSV(text);
  if(rows.length<2) throw new Error("CSV пустой");
  let hdrIdx=0;
  for(let i=0;i<Math.min(rows.length,10);i++){
    if(pickColumn(rows[i],CONFIG.COL_TIME_CANDIDATES)>=0 && pickColumn(rows[i],CONFIG.COL_GLU_CANDIDATES)>=0){ hdrIdx=i; break; }
  }
  const hdr=rows[hdrIdx];
  const ti=pickColumn(hdr,CONFIG.COL_TIME_CANDIDATES), gi=pickColumn(hdr,CONFIG.COL_GLU_CANDIDATES);
  if(ti<0||gi<0) throw new Error("Не нашёл колонки: "+hdr.join(" | "));
  const data=[];
  for(let i=hdrIdx+1;i<rows.length;i++){
    const r=rows[i]; const t=parseTime(r[ti]); let v=r[gi];
    if(typeof v==="string") v=v.replace(",",".").trim();
    const g=parseFloat(v);
    if(t && !isNaN(g)) data.push({t,g});
  }
  data.sort((a,b)=>a.t-b.t);
  return data;
}

// =============================================================
// Метрики
// =============================================================
function computeMetrics(data){
  if(!data.length) return null;
  const xs=data.map(d=>d.g), n=xs.length;
  const sum=xs.reduce((a,b)=>a+b,0), avg=sum/n;
  const sd=Math.sqrt(xs.reduce((a,b)=>a+(b-avg)*(b-avg),0)/n);
  const cv=(sd/avg)*100;
  // GMI(%) = 3.31 + 0.02392 * (avg_mg_dL); avg_mg_dL = avg_mmol/L * 18.018
  const avg_mgdl = avg*18.018;
  const gmi = 3.31 + 0.02392 * avg_mgdl;
  // eHbA1c (DCCT/NGSP): (avg_mg_dL + 46.7) / 28.7
  const ehba1c = (avg_mgdl + 46.7) / 28.7;

  let vlow=0,low=0,inr=0,high=0,vhigh=0;
  for(const v of xs){
    if(v<CONFIG.VLOW) vlow++;
    else if(v<CONFIG.TIR_LOW) low++;
    else if(v<=CONFIG.TIR_HIGH) inr++;
    else if(v<=CONFIG.VHIGH) high++;
    else vhigh++;
  }
  const pct=x=>100*x/n;

  // Max / Min с временем
  let mx=data[0], mn=data[0];
  for(const d of data){ if(d.g>mx.g) mx=d; if(d.g<mn.g) mn=d; }

  return {
    n, avg, sd, cv, gmi, ehba1c,
    pct_vlow:pct(vlow), pct_low:pct(low), pct_in:pct(inr), pct_high:pct(high), pct_vhigh:pct(vhigh),
    from:data[0].t, to:data[data.length-1].t,
    max:mx, min:mn
  };
}

// «Аптайм» сенсора: фактических замеров / ожидаемых за период
function computeUptime(data){
  if(data.length<2) return null;
  const span = (data[data.length-1].t - data[0].t)/60000; // мин
  const expected = span / CONFIG.EXPECTED_INTERVAL_MIN + 1;
  return Math.min(100, 100*data.length/expected);
}

function fmt(x,d=1){ return (x==null||isNaN(x))?"—":x.toFixed(d); }
function fmtTime(d){ return d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}); }
function fmtDate(d){ return d.toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"2-digit"}); }
function fmtDateTime(d){ return d.toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}); }

function rangeOf(v){
  if(v<CONFIG.VLOW) return "vlow";
  if(v<CONFIG.TIR_LOW) return "low";
  if(v<=CONFIG.TIR_HIGH) return "in";
  if(v<=CONFIG.VHIGH) return "high";
  return "vhigh";
}

// =============================================================
// HERO: текущее значение и тренд
// =============================================================
function renderHero(allData){
  const ring = document.getElementById("hero_ring");
  const valEl = document.getElementById("hero_value");
  const trendEl = document.getElementById("hero_trend");
  const timeEl = document.getElementById("hero_time");
  const deltaEl = document.getElementById("hero_delta");

  ring.classList.remove("r-vlow","r-low","r-in","r-high","r-vhigh");
  trendEl.classList.remove("up","down","steep-up","steep-down","flat");
  trendEl.textContent = "→";
  deltaEl.classList.remove("pos","neg");

  if(!allData.length){ valEl.textContent="—"; timeEl.textContent="—"; deltaEl.textContent="—"; return; }

  const last = allData[allData.length-1];
  const ageMin = (Date.now() - last.t.getTime())/60000;
  valEl.textContent = fmt(last.g,1);
  ring.classList.add("r-"+rangeOf(last.g));

  if(ageMin < CONFIG.CURRENT_FRESH_MIN){
    timeEl.textContent = "Сейчас · "+fmtTime(last.t);
  } else {
    timeEl.textContent = "Последнее: "+fmtDateTime(last.t);
  }

  // Тренд: наклон в ммоль/л за 15 минут
  const cutoff = new Date(last.t.getTime() - CONFIG.TREND_WINDOW_MIN*60000);
  const win = allData.filter(d => d.t >= cutoff);
  if(win.length >= 2){
    const slope = (last.g - win[0].g); // delta за окно
    deltaEl.textContent = (slope>=0?"+":"")+slope.toFixed(1)+" ммоль/л за "+CONFIG.TREND_WINDOW_MIN+" мин";
    if(slope > 0) deltaEl.classList.add("pos");
    else if(slope < 0) deltaEl.classList.add("neg");

    // Стрелка по mg/dL/min: <1 flat, 1-2 up, 2-3 up, >3 steep
    const slopeMgdlPerMin = (slope*18.018) / CONFIG.TREND_WINDOW_MIN;
    if(slopeMgdlPerMin >= 3)        { trendEl.textContent="↑↑"; trendEl.classList.add("steep-up"); }
    else if(slopeMgdlPerMin >=1.5)  { trendEl.textContent="↑";  trendEl.classList.add("up"); }
    else if(slopeMgdlPerMin >=0.5)  { trendEl.textContent="↗";  trendEl.classList.add("up"); }
    else if(slopeMgdlPerMin >-0.5)  { trendEl.textContent="→";  trendEl.classList.add("flat"); }
    else if(slopeMgdlPerMin >-1.5)  { trendEl.textContent="↘";  trendEl.classList.add("down"); }
    else if(slopeMgdlPerMin >-3)    { trendEl.textContent="↓";  trendEl.classList.add("down"); }
    else                            { trendEl.textContent="↓↓"; trendEl.classList.add("steep-down"); }
  } else {
    deltaEl.textContent = "—";
  }
}

// =============================================================
// Trio: max / tir / min
// =============================================================
function renderTrio(m){
  if(!m){
    ["t_max","t_max_t","t_tir","t_tir_dur","t_min","t_min_t"].forEach(id=>document.getElementById(id).textContent="—");
    return;
  }
  document.getElementById("t_max").textContent = fmt(m.max.g,1)+" ммоль/л";
  document.getElementById("t_max_t").textContent = fmtDateTime(m.max.t);
  document.getElementById("t_tir").textContent = fmt(m.pct_in,0)+"%";
  // длительность периода × pct_in = время в TIR
  const totalMin = (m.to - m.from)/60000;
  const tirMin = Math.round(totalMin * m.pct_in/100);
  const h = Math.floor(tirMin/60), mn = tirMin%60;
  document.getElementById("t_tir_dur").textContent = h+"ч "+mn+"мин";
  document.getElementById("t_min").textContent = fmt(m.min.g,1)+" ммоль/л";
  document.getElementById("t_min_t").textContent = fmtDateTime(m.min.t);
}

// =============================================================
// Метрики бар + цифры
// =============================================================
function renderMetrics(m, uptime){
  if(!m) return;
  document.getElementById("m_avg").textContent = fmt(m.avg,1);
  document.getElementById("m_gmi").textContent = fmt(m.gmi,1);
  document.getElementById("m_ehba1c").textContent = fmt(m.ehba1c,1);
  document.getElementById("m_sd").textContent  = fmt(m.sd,1);
  document.getElementById("m_cv").textContent  = fmt(m.cv,0);
  document.getElementById("m_uptime").textContent = uptime==null?"—":fmt(uptime,0);
  document.getElementById("m_n").textContent   = m.n;
  document.getElementById("m_period").textContent = fmtDate(m.from)+" — "+fmtDate(m.to);

  const set=(id,p)=>{ document.getElementById(id).style.width=p+"%"; };
  set("seg_vlow",m.pct_vlow); set("seg_low",m.pct_low); set("seg_in",m.pct_in);
  set("seg_high",m.pct_high); set("seg_vhigh",m.pct_vhigh);

  document.getElementById("p_vlow").textContent  = fmt(m.pct_vlow,1)+"%";
  document.getElementById("p_low").textContent   = fmt(m.pct_low,1)+"%";
  document.getElementById("p_in").textContent    = fmt(m.pct_in,1)+"%";
  document.getElementById("p_high").textContent  = fmt(m.pct_high,1)+"%";
  document.getElementById("p_vhigh").textContent = fmt(m.pct_vhigh,1)+"%";
}

// =============================================================
// Графики
// =============================================================
let chart=null, hourly=null, donut=null;

// Плагин: целевая зона 3.9–10 (зелёная заливка)
const targetZonePlugin = {
  id: "targetZone",
  beforeDatasetsDraw(c){
    const {ctx, chartArea, scales:{y}} = c;
    if(!chartArea || !y) return;
    const yLo = y.getPixelForValue(CONFIG.TIR_LOW);
    const yHi = y.getPixelForValue(CONFIG.TIR_HIGH);
    ctx.save();
    ctx.fillStyle = "rgba(63,185,80,0.10)";
    ctx.fillRect(chartArea.left, yHi, chartArea.right-chartArea.left, yLo-yHi);
    // линия 3.9 (нижняя, красная пунктирная)
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = "rgba(218,54,51,0.6)";
    ctx.beginPath(); ctx.moveTo(chartArea.left, yLo); ctx.lineTo(chartArea.right, yLo); ctx.stroke();
    ctx.strokeStyle = "rgba(210,153,34,0.5)";
    ctx.beginPath(); ctx.moveTo(chartArea.left, yHi); ctx.lineTo(chartArea.right, yHi); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
};

function renderChart(data){
  const ctx=document.getElementById("chart");
  const points=data.map(d=>({x:d.t, y:d.g}));
  if(chart) chart.destroy();
  chart = new Chart(ctx,{
    type:"line",
    data:{ datasets:[{
      data: points,
      borderColor:"#58a6ff",
      backgroundColor:"rgba(88,166,255,0.08)",
      fill:false, tension:0.25, pointRadius:0, borderWidth:1.6,
      segment:{
        borderColor: ctx => {
          const v = ctx.p1.parsed.y;
          if(v<CONFIG.TIR_LOW)  return "#f0883e";
          if(v>CONFIG.TIR_HIGH) return "#d29922";
          return "#3fb950";
        }
      }
    }]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{display:false}, tooltip:{
        callbacks:{ label: ctx => fmt(ctx.parsed.y,1)+" ммоль/л" }
      }},
      scales:{
        x:{ type:"time", time:{tooltipFormat:"dd.MM.yyyy HH:mm"},
            ticks:{color:"#8b949e",maxTicksLimit:8}, grid:{color:"#22272e"} },
        y:{ min:2, max:22, ticks:{color:"#8b949e",stepSize:4}, grid:{color:"#22272e"} }
      }
    },
    plugins:[targetZonePlugin]
  });
}

function renderHourly(data){
  const buckets=Array.from({length:24},()=>[]);
  for(const d of data) buckets[d.t.getHours()].push(d.g);
  const q=(arr,p)=>{ if(!arr.length) return null; const s=[...arr].sort((a,b)=>a-b);
    return s[Math.min(s.length-1, Math.floor(p*s.length))]; };
  const med = arr => {
    if(!arr.length) return null;
    const s=[...arr].sort((a,b)=>a-b); const mi=Math.floor(s.length/2);
    return s.length%2 ? s[mi] : (s[mi-1]+s[mi])/2;
  };
  const meds = buckets.map(med);
  const q10  = buckets.map(b=>q(b,0.10));
  const q25  = buckets.map(b=>q(b,0.25));
  const q75  = buckets.map(b=>q(b,0.75));
  const q90  = buckets.map(b=>q(b,0.90));
  const labels = Array.from({length:24},(_,i)=>i+":00");

  if(hourly) hourly.destroy();
  hourly = new Chart(document.getElementById("hourly"),{
    type:"line",
    data:{ labels, datasets:[
      { label:"90%", data:q90,  borderColor:"rgba(210,153,34,0.4)", backgroundColor:"rgba(210,153,34,0.10)", fill:"+1", pointRadius:0, borderWidth:1 },
      { label:"75%", data:q75,  borderColor:"rgba(210,153,34,0.7)", backgroundColor:"rgba(210,153,34,0.18)", fill:"+1", pointRadius:0, borderWidth:1 },
      { label:"Медиана", data:meds, borderColor:"#58a6ff", backgroundColor:"transparent", pointRadius:2, borderWidth:2.2 },
      { label:"25%", data:q25,  borderColor:"rgba(240,136,62,0.7)", backgroundColor:"transparent", pointRadius:0, borderWidth:1 },
      { label:"10%", data:q10,  borderColor:"rgba(240,136,62,0.4)", backgroundColor:"transparent", pointRadius:0, borderWidth:1 }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{labels:{color:"#8b949e",boxWidth:10},position:"bottom"}},
      scales:{
        x:{ ticks:{color:"#8b949e",maxTicksLimit:12}, grid:{color:"#22272e"} },
        y:{ min:2, max:18, ticks:{color:"#8b949e"}, grid:{color:"#22272e"} }
      }
    },
    plugins:[targetZonePlugin]
  });
}

function renderDonut(m){
  if(donut) donut.destroy();
  if(!m) return;
  const data = [m.pct_vhigh, m.pct_high, m.pct_in, m.pct_low, m.pct_vlow];
  donut = new Chart(document.getElementById("donut"),{
    type:"doughnut",
    data:{
      labels:["Очень высокий",">10","В норме","<3.9","Очень низкий"],
      datasets:[{
        data,
        backgroundColor:["#8957e5","#d29922","#3fb950","#f0883e","#da3633"],
        borderWidth:0,
        cutout:"68%"
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:400},
      plugins:{
        legend:{display:false},
        tooltip:{ callbacks:{ label: ctx => ctx.label+": "+fmt(ctx.parsed,1)+"%" } }
      }
    }
  });
}

// =============================================================
// Фильтр по диапазону
// =============================================================
let ALL=[];
function applyRange(rangeKey){
  const days = parseFloat(rangeKey);
  let filtered;
  if(!isNaN(days) && days>0){
    // Привязываем «окно» к последнему замеру, чтобы 3ч/6ч имели смысл
    const last = ALL.length ? ALL[ALL.length-1].t.getTime() : Date.now();
    const from = new Date(last - days*86400000);
    filtered = ALL.filter(d=>d.t>=from);
  } else {
    filtered = ALL;
  }
  const m = computeMetrics(filtered);
  const up = computeUptime(filtered);
  renderMetrics(m, up);
  renderTrio(m);
  renderChart(filtered);
  renderHourly(filtered);
  renderDonut(m);
}

// =============================================================
// Init
// =============================================================
async function init(){
  const status=document.getElementById("status");
  try{
    status.textContent="Загружаю CSV…";
    const r=await fetch(CONFIG.CSV_URL+"?t="+Date.now());
    if(!r.ok) throw new Error("HTTP "+r.status);
    const text=await r.text();
    ALL=loadData(text);
    if(!ALL.length) throw new Error("Нет валидных записей");
    status.textContent="Записей: "+ALL.length+" · обновлено "+fmtDateTime(new Date());
    renderHero(ALL);
    applyRange("1");
    document.querySelectorAll(".range button").forEach(b=>{
      b.onclick=()=>{
        document.querySelectorAll(".range button").forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        applyRange(b.dataset.range);
      };
    });
  }catch(e){
    status.textContent="Ошибка: "+e.message;
    console.error(e);
  }
}

gate();
