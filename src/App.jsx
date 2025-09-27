import React, { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";
import { createClient } from "@supabase/supabase-js";

/**
 * PPG Viewer – RTL + Supabase (recordings table)
 * يقرأ البيانات من جدول recordings بالحقول:
 * id (pk), blood_type text, age int, gender text, signal jsonb
 * signal قد تكون مصفوفة أرقام مثل [0.12,0.34,0.56]
 */

// (اختياري) API خارجي إن رغبت
const API = import.meta.env?.VITE_API_URL || "";

// Supabase
const SUPABASE_URL  = import.meta.env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON = import.meta.env?.VITE_SUPABASE_ANON || "";
const supabase = (SUPABASE_URL && SUPABASE_ANON) ? createClient(SUPABASE_URL, SUPABASE_ANON) : null;

export default function PpgWeb() {
  const [useMock, setUseMock] = useState(true);
  const [useSupabase, setUseSupabase] = useState(false);
  const [userId, setUserId] = useState(1);
  const [user, setUser] = useState(null);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(() => (localStorage.getItem("ppg-theme") || "dark"));

  // —— Theme ——
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ppg-theme", theme);
  }, [theme]);

  // —— Mock helpers ——
  const mockRef = useRef({ i: 0, user: mockUser() });
  function mockUser() {
    const blood = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
    return { id: userId, full_name: "Test User", age: 29, sex: "female", blood_type: blood[Math.floor(Math.random()*blood.length)] };
  }
  function mockNextSamples(n = 25, freqHz = 50) {
    const arr = []; const st = mockRef.current;
    for (let k = 0; k < n; k++) {
      const idx = st.i++;
      const t = new Date();
      const v = 0.6 + 0.35 * Math.sin((idx / freqHz) * 2 * Math.PI * 1.3) + (Math.random() - 0.5) * 0.05;
      arr.push({ ts: t, value: +v.toFixed(4) });
    }
    return arr;
  }

  // =========================
  //  Supabase (recordings)
  // =========================
  async function fetchUser(id) {
    if (useSupabase && supabase) {
      const { data, error } = await supabase
        .from("recordings")
        .select("id, age, gender, blood_type")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;

      return {
        id: data.id,
        full_name: `Recording ${data.id}`,
        age: data.age,
        sex: data.gender,        // gender -> sex لعرضها فقط
        blood_type: data.blood_type,
      };
    }
    // API تقليدي (اختياري)
    const r = await fetch(`${API}/api/users/${id}`);
    if (!r.ok) throw new Error(`User ${id} not found`);
    return r.json();
  }

  async function fetchPpg(id, limit = 1000) {
    if (useSupabase && supabase) {
      const { data, error } = await supabase
        .from("recordings")
        .select("signal")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);

      const raw = data?.signal || [];

      // شكل: [{ts, value}, ...]
      if (Array.isArray(raw) && raw.length && typeof raw[0] === "object" && "value" in raw[0]) {
        return raw
          .slice(-limit)
          .map(d => ({ ts: new Date(d.ts), value: Number(d.value) }))
          .filter(d => !isNaN(d.value) && d.ts.toString() !== "Invalid Date");
      }

      // شكل: [0.61, 0.63, ...] ← نولّد طوابع زمنية 50Hz
      if (Array.isArray(raw)) {
        const freqHz = 50;
        const slice = raw.slice(-limit);
        const now = Date.now();
        const start = now - (slice.length / freqHz) * 1000;
        return slice.map((v, i) => ({
          ts: new Date(start + (i * 1000) / freqHz),
          value: Number(v)
        })).filter(d => !isNaN(d.value));
      }

      throw new Error("signal (jsonb) ليس بالصيغة المتوقعة");
    }

    // API تقليدي
    const params = new URLSearchParams({ userId: String(id), limit: String(limit) });
    const r = await fetch(`${API}/api/ppg?${params}`);
    if (!r.ok) throw new Error(`PPG fetch failed`);
    const json = await r.json();
    return json.map(d => ({ ts: new Date(d.ts), value: Number(d.value) }));
  }

  // —— Effects ——
  useEffect(() => {
    let timer;
    if (useMock) {
      setUser(mockRef.current.user);
      setData(d => [...d, ...mockNextSamples(200)]);
      timer = setInterval(() => setData(d => {
        const next = [...d, ...mockNextSamples(12)];
        return next.slice(Math.max(0, next.length - 1500));
      }), 180);
    } else {
      (async () => {
        try {
          setError("");
          setLoading(true);
          const u = await fetchUser(userId);
          setUser(u);
          const initial = await fetchPpg(userId, 1000);
          setData(initial);
        } catch (e) {
          setError(String(e.message || e));
        } finally { setLoading(false); }
      })();
      timer = setInterval(async () => {
        try {
          const latest = await fetchPpg(userId, 1000);
          setData(latest);
        } catch (e) {
          setError(String(e.message || e));
        }
      }, 2000);
    }
    return () => clearInterval(timer);
  }, [useMock, useSupabase, userId]);

  // —— Derived metrics ——
  const chartData = useMemo(() => data.map(d => ({ time: d.ts.toLocaleTimeString(), value: d.value })), [data]);
  const metrics = useMemo(() => {
    if (!data.length) return { last: "-", min: "-", max: "-", avg: "-", count: 0 };
    const vals = data.map(d => d.value);
    const sum = vals.reduce((a,b) => a+b, 0);
    const avg = sum / vals.length;
    return {
      last: data[data.length-1].value.toFixed(3),
      min: Math.min(...vals).toFixed(3),
      max: Math.max(...vals).toFixed(3),
      avg: avg.toFixed(3),
      count: vals.length
    };
  }, [data]);

  return (
    <div style={styles.page} dir="rtl">
      <style>{css}</style>

      {/* Topbar */}
      <header style={styles.topbar}>
        <div style={styles.topbarInner}>
          <div style={styles.brand}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M3 12c3.5-6 7.5-6 11 0 3.5 6 7.5 6 11 0" stroke="var(--primary)" strokeWidth="2" fill="none"/>
            </svg>
            <span>لوحة مراقبة PPG</span>
          </div>
          <div style={{display:'flex',gap:12,alignItems:'center'}}>
            <button style={styles.ghostBtn} onClick={() => setTheme(t=> t==='dark'?'light':'dark')}>
              {theme==='dark' ? '🌙 داكن' : '☀️ فاتح'}
            </button>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {/* الإعدادات */}
        <section style={styles.card}>
          <div style={styles.cardHead}><h2 style={styles.cardTitle}>الإعدادات</h2></div>
          <div style={styles.formRow}>
            <label style={styles.switchLabel}>
              <input type="checkbox" checked={useMock} onChange={e => setUseMock(e.target.checked)} />
              <span className="switch" aria-hidden />
              <span>وضع البيانات الوهمية</span>
            </label>

            <label style={styles.switchLabel}>
              <input
                type="checkbox"
                checked={useSupabase}
                onChange={(e) => setUseSupabase(e.target.checked)}
                disabled={!supabase}
              />
              <span className="switch" aria-hidden />
              <span>Supabase</span>
            </label>

            <label style={styles.inputLabel}>
              <span>معرّف السجل</span>
              <input style={styles.input} type="number" min={1} value={userId} onChange={e => setUserId(Number(e.target.value))} />
            </label>

            {!useMock && !useSupabase && <span style={styles.hint}>API: {API || "(غير مضبوط)"}</span>}
            {!useMock && useSupabase && (
              <span style={styles.hint}>
                Supabase: {SUPABASE_URL ? new URL(SUPABASE_URL).host : "(غير مضبوط)"}
              </span>
            )}
          </div>
          {error && <div style={styles.error}>⚠ {error}</div>}
        </section>

        {/* بيانات السجل */}
        <section style={styles.card}>
          <div style={styles.cardHead}><h2 style={styles.cardTitle}>بيانات السجل</h2></div>
          {user ? (
            <ul style={styles.userList}>
              <li><b>🔖 المعرف:</b> {user.id}</li>
              <li><b>🎂 العمر:</b> {user.age ?? "-"}</li>
              <li><b>⚥ الجنس:</b> {user.sex ?? "-"}</li>
              <li><b>🩸 زمرة الدم:</b> {user.blood_type ?? "-"}</li>
            </ul>
          ) : (
            <div style={styles.muted}>لا توجد بيانات للسجل (تحقق من وجود صف بـ id = {userId} داخل public.recordings).</div>
          )}
          {loading && <div style={styles.muted}>⏳ جاري التحميل…</div>}
        </section>

        {/* مؤشرات سريعة */}
        <section style={{...styles.card, paddingTop:10, paddingBottom:10}}>
          <div style={styles.kpiGrid}>
            <Kpi label="القيمة الأخيرة" value={metrics.last} />
            <Kpi label="المتوسط" value={metrics.avg} />
            <Kpi label="أدنى" value={metrics.min} />
            <Kpi label="أعلى" value={metrics.max} />
            <Kpi label="العينات" value={metrics.count} />
          </div>
        </section>

        {/* المخطط */}
        <section style={{ ...styles.card, gridColumn: '1 / -1' }}>
          <div style={styles.cardHead}><h2 style={styles.cardTitle}>إشارة PPG</h2></div>
          <div style={{ height: 440 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity="1" />
                    <stop offset="100%" stopColor="var(--primary-2)" stopOpacity="1" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
                <XAxis dataKey="time" minTickGap={40} stroke="var(--muted)" tickMargin={8} />
                <YAxis stroke="var(--muted)" tickMargin={8} domain={[0, 1.2]} />
                <Tooltip contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--ring)', borderRadius: 12, color:'var(--text)' }} />
                <Line type="monotone" dataKey="value" dot={false} stroke="url(#g1)" strokeWidth={2.8} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      </main>

      <footer style={styles.footer}>
        💡 أثناء التطوير يمكنك إبقاء الوضع الوهمي مفعّل. عند توفر البيانات فعّل Supabase من الإعدادات.
      </footer>
    </div>
  );
}

function Kpi({ label, value }){
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={styles.kpiValue}>{value}</div>
    </div>
  );
}

// —— CSS (inline) ——
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap');
  :root{
    --bg:#0b0e14; --panel:#151a2b; --panel-2:#101626; --grid:#2e3343; --muted:#9aa3b2; --text:#e6e9ef; --primary:#7c93ff; --primary-2:#5b6ee6; --ring:#2a3042;
  }
  [data-theme="light"]{
    --bg:#f3f6fb; --panel:#ffffff; --panel-2:#f4f7ff; --grid:#e7ebf3; --muted:#697386; --text:#0f172a; --primary:#4f46e5; --primary-2:#6366f1; --ring:#e2e8f0;
  }
  body{ background: var(--bg); margin:0; }
  .switch{ width:44px; height:24px; background:var(--ring); border-radius:999px; margin-inline-start:8px; position:relative; display:inline-block; vertical-align:middle; transition:.2s }
  input[type="checkbox"]{ appearance:none; width:0; height:0; position:absolute; opacity:0; }
  input[type="checkbox"]:checked + .switch{ background: var(--primary); }
  .switch::after{ content:""; position:absolute; top:3px; inset-inline-start:3px; width:18px; height:18px; background:white; border-radius:50%; transition:.2s; }
  input[type="checkbox"]:checked + .switch::after{ inset-inline-start:23px; }
`;

// —— Inline style objects ——
const styles = {
  page:{ fontFamily:"Cairo, system-ui, sans-serif", color:"var(--text)" },
  topbar:{ position:'sticky', top:0, zIndex:10, background:"linear-gradient(135deg, var(--panel), var(--panel-2))", borderBottom:"1px solid var(--ring)", boxShadow:"0 4px 12px rgba(0,0,0,.15)" },
  topbarInner:{ maxWidth:1200, margin:"0 auto", padding:"12px 16px", display:'flex', alignItems:'center', justifyContent:'space-between' },
  brand:{ display:'flex', alignItems:'center', gap:10, fontWeight:700 },
  ghostBtn:{ background:"transparent", color:"var(--text)", border:"1px solid var(--ring)", borderRadius:12, padding:"8px 12px", cursor:'pointer' },
  main:{ maxWidth:1200, margin:"24px auto", padding:"0 16px", display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:20 },
  card:{ background:"linear-gradient(180deg, var(--panel), var(--panel-2))", border:"1px solid var(--ring)", borderRadius:20, padding:20, boxShadow:"0 6px 18px rgba(0,0,0,.08)" },
  cardHead:{ marginBottom:10 },
  cardTitle:{ margin:0, fontSize:19, fontWeight:700, color:"var(--primary)" },
  formRow:{ display:"flex", flexWrap:"wrap", gap:16, alignItems:"center" },
  switchLabel:{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" },
  inputLabel:{ display:"flex", alignItems:"center", gap:8 },
  input:{ background:"transparent", color:"var(--text)", border:"1px solid var(--ring)", borderRadius:10, padding:"8px 10px", width:110 },
  hint:{ color:"var(--muted)", fontSize:13 },
  error:{ color:"#ff5a7a", marginTop:12 },
  userList:{ margin:0, paddingInlineStart:20, lineHeight:2 },
  muted:{ color:"var(--muted)", fontSize:14 },
  kpiGrid:{ display:'grid', gridTemplateColumns:'repeat(5, minmax(0,1fr))', gap:12 },
  kpi:{ background:'var(--panel-2)', border:'1px solid var(--ring)', borderRadius:16, padding:'12px 14px', textAlign:'center' },
  kpiLabel:{ fontSize:12, color:'var(--muted)' },
  kpiValue:{ fontSize:20, fontWeight:700 },
  footer:{ maxWidth:1200, margin:"12px auto 32px", padding:"0 16px", color:"var(--muted)", textAlign:"center", fontSize:13 }
};
