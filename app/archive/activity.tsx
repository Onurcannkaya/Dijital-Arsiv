"use client";

import {
  ChevronDown, ChevronRight, FileSearch, History, LoaderCircle, ShieldCheck, UserRound,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { auditLabels, auditReasonLabels } from "./audit-labels";

type ActivityKind = "document" | "user";
type ActivityEntry = {
  id:string; kind:ActivityKind; action:string; actor:string; createdAt:string;
  documentId:string|null; referenceNo:string|null; unit:string|null;
  targetEmail:string|null;
  roleChange:{from:string|null;to:string}|null;
  accessChange:{from:boolean|null;to:boolean}|null;
  details:Record<string,string>;
};
type ActivityPage = {
  entries:ActivityEntry[]; nextCursor:string|null;
  scope:{unit:string; includesUserEvents:boolean};
};

const filters = [["all","Tümü"],["document","Belge işlemleri"],["user","Yetki değişiklikleri"]] as const;
const roleLabels: Record<string,string> = {
  admin:"Sistem Yöneticisi", archive_manager:"Arşiv Yöneticisi",
  reviewer:"Belge Doğrulayıcı", viewer:"Arşiv Görüntüleyici",
};

function formatMoment(value:string) {
  const parsed=new Date(value.includes("T")?value:`${value.replace(" ","T")}Z`);
  return Number.isNaN(parsed.getTime())?value
    :parsed.toLocaleString("tr-TR",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
}

/** Olayı tek cümlelik, okunur bir açıklamaya çevirir. */
function describe(entry:ActivityEntry) {
  if(entry.kind==="user") {
    if(entry.accessChange) return entry.accessChange.to?"erişimi açıldı":"erişimi kapatıldı";
    if(entry.roleChange) {
      const to=roleLabels[entry.roleChange.to]??entry.roleChange.to;
      if(!entry.roleChange.from) return `${to} olarak eklendi`;
      const from=roleLabels[entry.roleChange.from]??entry.roleChange.from;
      return from===to?"kaydı güncellendi":`rolü ${from} → ${to} olarak değiştirildi`;
    }
    return "kaydı güncellendi";
  }
  const reason=entry.details.reason?auditReasonLabels[entry.details.reason]??entry.details.reason:null;
  return reason?`${auditLabels[entry.action]??entry.action} (${reason})`:auditLabels[entry.action]??entry.action;
}

export function ActivityScreen({onOpenDocument}:{onOpenDocument:(id:string)=>void}) {
  const [kind,setKind]=useState<"all"|ActivityKind>("all");
  const [page,setPage]=useState<ActivityPage|null>(null);
  const [entries,setEntries]=useState<ActivityEntry[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState("");

  const load=useCallback(async(signal?:AbortSignal)=>{
    try {
      const response=await fetch(`/api/activity?kind=${kind}`,{signal});
      const payload=await response.json() as ActivityPage&{error?:string};
      if(!response.ok){setError(payload.error??"İşlem geçmişi alınamadı.");setPage(null);setEntries([]);return}
      setPage(payload);setEntries(payload.entries);setError("");
    } catch(cause) {
      if((cause as Error)?.name!=="AbortError") setError("İşlem geçmişi alınamadı; bağlantıyı kontrol edin.");
    } finally { setLoading(false); }
  },[kind]);

  // Süzgeç değiştiğinde liste yeniden alınır; yükleniyor durumu eşzamanlı
  // setState zincirine girmemek için istekle birlikte başlatılır.
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{void load(controller.signal)},0);
    return()=>{clearTimeout(timer);controller.abort()};
  },[load]);

  const loadMore=async()=>{
    if(!page?.nextCursor||loadingMore) return;
    setLoadingMore(true);
    try {
      const response=await fetch(`/api/activity?kind=${kind}&cursor=${encodeURIComponent(page.nextCursor)}`);
      const payload=await response.json() as ActivityPage&{error?:string};
      if(response.ok){setEntries((current)=>[...current,...payload.entries]);setPage(payload)}
    } catch { /* Sonraki sayfa alınamazsa mevcut liste korunur. */ }
    finally { setLoadingMore(false); }
  };

  const scopeNote=page?.scope.unit==="*"
    ?"Bütün müdürlüklerin kayıtları"
    :`Yalnız ${page?.scope.unit} kapsamındaki kayıtlar`;

  return <>
    <section className="heading"><div><p className="eyebrow">YÖNETİM</p><h1>İşlem Geçmişi</h1>
      <span>Belge hareketleri ve yetki değişiklikleri; değiştirilemez denetim kaydından okunur.</span></div></section>

    <section className="panel">
      <header><div><h2>Denetim akışı</h2><p>{page?`${scopeNote}${page.scope.includesUserEvents?" · yetki değişiklikleri dahil":""}`:"Yükleniyor"}</p></div>
        <div className="activity-filters">{filters.map(([value,label])=>
          <button key={value} className={kind===value?"active":""} onClick={()=>setKind(value)}>{label}</button>)}</div>
      </header>

      {loading?<p className="table-empty"><LoaderCircle className="spin" size={16}/> Kayıtlar yükleniyor…</p>
        :error?<p className="table-empty">{error}</p>
        :!entries.length?<p className="table-empty">Bu süzgeçle kayıt bulunamadı.</p>
        :<ul className="activity-list">{entries.map((entry)=>
          <li key={`${entry.kind}-${entry.id}`}>
            <span className={`activity-icon ${entry.kind}`}>{entry.kind==="user"?<UserRound size={16}/>:<History size={16}/>}</span>
            <div className="activity-body">
              <b>{entry.kind==="user"
                ?<>{entry.targetEmail} <em>{describe(entry)}</em></>
                :<>{describe(entry)}</>}</b>
              <small>{entry.actor} · {formatMoment(entry.createdAt)}{entry.unit?` · ${entry.unit}`:""}</small>
            </div>
            {entry.kind==="document"&&entry.documentId
              ?<button className="activity-open" onClick={()=>onOpenDocument(entry.documentId as string)}>
                <FileSearch size={15}/>{entry.referenceNo??"Belgeyi aç"}<ChevronRight size={14}/></button>
              :<span className="activity-tag"><ShieldCheck size={13}/>Yetki</span>}
          </li>)}
        </ul>}

      {page?.nextCursor&&!loading?<div className="list-more">
        <button className="outline" onClick={loadMore} disabled={loadingMore}>
          {loadingMore?<LoaderCircle className="spin" size={15}/>:<ChevronDown size={15}/>} Daha fazla göster
        </button></div>:null}
    </section>
  </>;
}
