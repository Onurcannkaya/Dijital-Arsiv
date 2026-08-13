"use client";

import {
  Building2, CheckCircle2, Database, ListChecks, LoaderCircle, Lock, Plus, RefreshCw,
  ShieldCheck, TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Unit = { code:string; label:string; active:boolean; sortOrder:number; documentCount:number; userCount:number };
type TermUsage = { label:string; count:number };
type Term = { code:string; label:string; active:boolean; sortOrder:number; usage:TermUsage[] };
type ManagedVocabulary = { key:string; name:string; description:string; terms:Term[] };
type LockedSetting = { key:string; label:string; reason:string };
type MaintenanceProgress = { task?:string; status?:string; processed?:number; total?:number|null; done?:boolean }|null;
type Settings = {
  units:Unit[];
  vocabularies:ManagedVocabulary[];
  schema:{version:number; expected:number; ok:boolean};
  maintenance:MaintenanceProgress;
  lockedSettings:LockedSetting[];
};
type Health = {
  status?:string;
  checks?:Record<string,{ok:boolean; latencyMs?:number; version?:number}>;
};

const serviceLabels: Record<string,string> = {
  database:"Veritabanı", objectStorage:"Nesne deposu", ocr:"OCR servisi",
  contentScan:"İçerik tarama", schema:"Şema",
};

export function SettingsScreen() {
  const [settings,setSettings]=useState<Settings|null>(null);
  const [health,setHealth]=useState<Health|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busyCode,setBusyCode]=useState("");
  const [label,setLabel]=useState("");
  const [adding,setAdding]=useState(false);
  /** Her sözlüğün kendi "yeni terim" kutusu; tek alan hepsini paylaşamaz. */
  const [termDrafts,setTermDrafts]=useState<Record<string,string>>({});
  const [addingTerm,setAddingTerm]=useState("");
  const [maintenanceBusy,setMaintenanceBusy]=useState(false);

  const load=useCallback(async(signal?:AbortSignal)=>{
    try {
      const [settingsResponse,healthResponse]=await Promise.all([
        fetch("/api/settings",{signal}),
        fetch("/api/health",{signal}),
      ]);
      const payload=await settingsResponse.json() as Settings&{error?:string};
      if(!settingsResponse.ok){setError(payload.error??"Ayarlar alınamadı.");setSettings(null);return}
      setSettings(payload);
      setHealth(await healthResponse.json().catch(()=>null) as Health|null);
      setError("");
    } catch(cause) {
      if((cause as Error)?.name!=="AbortError") setError("Ayarlar alınamadı; bağlantıyı kontrol edin.");
    } finally { setLoading(false); }
  },[]);

  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{void load(controller.signal)},0);
    return()=>{clearTimeout(timer);controller.abort()};
  },[load]);

  const send=async(method:"POST"|"PATCH",body:Record<string,unknown>,message:string)=>{
    setError("");
    const response=await fetch("/api/settings",{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const payload=await response.json().catch(()=>null) as {error?:string}|null;
    if(!response.ok){setError(payload?.error??"İşlem tamamlanamadı.");return false}
    setNotice(message);
    await load();
    return true;
  };

  const addUnit=async(event:React.FormEvent)=>{
    event.preventDefault();
    setAdding(true);
    try { if(await send("POST",{label},`${label.trim()} eklendi`)) setLabel(""); }
    finally { setAdding(false); }
  };

  const toggleUnit=async(unit:Unit)=>{
    setBusyCode(unit.code);
    try {
      await send("PATCH",{code:unit.code,active:!unit.active},
        unit.active?`${unit.label} listeden kaldırıldı`:`${unit.label} yeniden açıldı`);
    } finally { setBusyCode(""); }
  };

  const addTerm=async(vocabulary:ManagedVocabulary,event:React.FormEvent)=>{
    event.preventDefault();
    const draft=(termDrafts[vocabulary.key]??"").trim();
    if(!draft) return;
    setAddingTerm(vocabulary.key);
    try {
      if(await send("POST",{vocabulary:vocabulary.key,label:draft},`${draft} eklendi`)) {
        setTermDrafts(current=>({...current,[vocabulary.key]:""}));
      }
    } finally { setAddingTerm(""); }
  };

  const toggleTerm=async(vocabulary:ManagedVocabulary,term:Term)=>{
    setBusyCode(`${vocabulary.key}:${term.code}`);
    try {
      await send("PATCH",{vocabulary:vocabulary.key,code:term.code,active:!term.active},
        term.active?`${term.label} listeden kaldırıldı`:`${term.label} yeniden açıldı`);
    } finally { setBusyCode(""); }
  };

  const runMaintenance=async()=>{
    setMaintenanceBusy(true);
    setError("");
    try {
      const response=await fetch("/api/admin/maintenance",{method:"POST"});
      const payload=await response.json().catch(()=>null) as {message?:string;error?:string}|null;
      if(!response.ok){setError(payload?.error??"Bakım işi çalıştırılamadı.");return}
      setNotice(payload?.message??"Bakım dilimi işlendi.");
      await load();
    } catch { setError("Bakım işi çalıştırılamadı."); }
    finally { setMaintenanceBusy(false); }
  };

  if(loading) return <section className="panel"><p className="table-empty"><LoaderCircle className="spin" size={16}/> Ayarlar yükleniyor…</p></section>;
  if(!settings) return <section className="panel"><p className="table-empty">{error||"Ayarlar görüntülenemiyor."}</p></section>;

  const checks=health?.checks??{};
  const maintenance=settings.maintenance;

  return <>
    <section className="heading"><div><p className="eyebrow">YÖNETİM</p><h1>Ayarlar</h1>
      <span>Sistem durumu ve kurum müdürlük listesi. Saklama, yetki matrisi ve depolama profili buradan değiştirilemez.</span></div></section>

    {error?<div className="user-alert danger" role="alert"><TriangleAlert size={17}/><span>{error}</span></div>:null}
    {notice?<div className="user-alert success" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div>:null}

    <section className="panel">
      <header><div><h2>Sistem durumu</h2><p>Servislerin anlık sağlığı ve şema sürümü</p></div>
        <button className="outline" onClick={()=>void load()}><RefreshCw size={14}/> Yenile</button></header>
      <div className="settings-status">
        {Object.entries(serviceLabels).map(([key,serviceLabel])=>{
          const check=checks[key];
          const ok=check?.ok??false;
          return <article key={key} className={`status-card ${check?(ok?"ok":"down"):"unknown"}`}>
            <span>{key==="database"?<Database size={17}/>:key==="schema"?<ShieldCheck size={17}/>:<RefreshCw size={17}/>}</span>
            <div><small>{serviceLabel}</small>
              <b>{check?(ok?"Çalışıyor":"Ulaşılamıyor"):"Bilinmiyor"}</b>
              <p>{key==="schema"
                ?`Sürüm ${settings.schema.version} / beklenen ${settings.schema.expected}`
                :check?.latencyMs!==undefined?`${check.latencyMs} ms`:"Ölçüm yok"}</p></div>
          </article>;
        })}
      </div>
      {!settings.schema.ok?<div className="user-alert danger"><TriangleAlert size={17}/>
        <span>Şema sürümü beklenenden farklı; göç uygulanmalıdır.</span></div>:null}
      <div className="settings-maintenance">
        <div><b>Arama dizini bakımı</b>
          <small>{maintenance?.status
            ? `${maintenance.status}${maintenance.processed!==undefined?` · ${maintenance.processed}${maintenance.total?`/${maintenance.total}`:""} kayıt`:""}`
            : "Bekleyen bakım işi yok"}</small></div>
        <button className="outline" onClick={()=>void runMaintenance()} disabled={maintenanceBusy}>
          {maintenanceBusy?<LoaderCircle className="spin" size={14}/>:<RefreshCw size={14}/>} Bir dilim çalıştır
        </button>
      </div>
    </section>

    <section className="panel">
      <header><div><h2>Müdürlükler</h2>
        <p>Yükleme ve yetki kapsamı bu listeden seçilir. Kaldırma kaydı silmez; geçmiş belgeler müdürlüğünde kalır.</p></div></header>
      <div className="table-wrap"><table><thead><tr>
        <th>Müdürlük</th><th>Bağlı kayıt</th><th>Durum</th><th /></tr></thead><tbody>
        {settings.units.map((unit)=><tr key={unit.code}>
          <td><div className="user-cell"><span><Building2 size={17}/></span>
            <b>{unit.label}<small className="mono">{unit.code}</small></b></div></td>
          <td><small>{unit.documentCount} belge · {unit.userCount} kullanıcı</small></td>
          <td><span className={`status ${unit.active?"success":"danger"}`}><i/>{unit.active?"Listede":"Kaldırıldı"}</span></td>
          <td><button className="outline" disabled={busyCode===unit.code} onClick={()=>void toggleUnit(unit)}
            title={unit.active&&(unit.documentCount||unit.userCount)
              ?"Bağlı kayıtlar müdürlüğünde kalır; yalnız yeni seçimlerde görünmez.":undefined}>
            {busyCode===unit.code?<LoaderCircle className="spin" size={14}/>:null}
            {unit.active?"Listeden kaldır":"Yeniden aç"}</button></td>
        </tr>)}
      </tbody></table></div>
      <form className="user-form" onSubmit={addUnit}>
        <label>Yeni müdürlük adı<input required value={label} placeholder="ör. Park ve Bahçeler Müdürlüğü"
          onChange={(event)=>setLabel(event.target.value)}/></label>
        <button className="primary" type="submit" disabled={adding||!label.trim()}>
          {adding?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>} Müdürlük ekle
        </button>
      </form>
    </section>

    {(settings.vocabularies??[]).map((vocabulary)=><section className="panel" key={vocabulary.key}>
      <header><div><h2>{vocabulary.name}</h2><p>{vocabulary.description} Kaldırma kaydı silmez; geçmiş kararlar gerekçesini korur.</p></div></header>
      <div className="table-wrap"><table><thead><tr>
        <th>Gerekçe</th><th>Kullanım</th><th>Durum</th><th /></tr></thead><tbody>
        {vocabulary.terms.map((term)=><tr key={term.code}>
          <td><div className="user-cell"><span><ListChecks size={17}/></span>
            <b>{term.label}<small className="mono">{term.code}</small></b></div></td>
          <td><small>{term.usage.map((entry)=>`${entry.count} ${entry.label}`).join(" · ")||"—"}</small></td>
          <td><span className={`status ${term.active?"success":"danger"}`}><i/>{term.active?"Listede":"Kaldırıldı"}</span></td>
          <td><button className="outline" disabled={busyCode===`${vocabulary.key}:${term.code}`}
            onClick={()=>void toggleTerm(vocabulary,term)}
            title={term.active&&term.usage.some((entry)=>entry.count>0)
              ?"Geçmiş kararlar bu gerekçeyi taşımaya devam eder; yalnız yeni retlerde görünmez.":undefined}>
            {busyCode===`${vocabulary.key}:${term.code}`?<LoaderCircle className="spin" size={14}/>:null}
            {term.active?"Listeden kaldır":"Yeniden aç"}</button></td>
        </tr>)}
      </tbody></table></div>
      <form className="user-form" onSubmit={(event)=>void addTerm(vocabulary,event)}>
        <label>Yeni gerekçe<input required value={termDrafts[vocabulary.key]??""} placeholder="ör. Mahkeme kararıyla düşürüldü"
          onChange={(event)=>setTermDrafts(current=>({...current,[vocabulary.key]:event.target.value}))}/></label>
        <button className="primary" type="submit" disabled={addingTerm===vocabulary.key||!(termDrafts[vocabulary.key]??"").trim()}>
          {addingTerm===vocabulary.key?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>} Gerekçe ekle
        </button>
      </form>
    </section>)}

    <section className="panel">
      <header><div><h2>Arayüzden değiştirilemeyenler</h2>
        <p>Bu ayarlar kurumsal karar ya da dağıtım yapılandırmasıyla belirlenir</p></div></header>
      <ul className="settings-locked">{settings.lockedSettings.map((locked)=>
        <li key={locked.key}><Lock size={15}/><div><b>{locked.label}</b><small>{locked.reason}</small></div></li>)}
      </ul>
    </section>
  </>;
}
