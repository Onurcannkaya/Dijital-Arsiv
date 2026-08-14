"use client";

import {
  Archive, Bell, Camera, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  FileCheck2, FileSearch, Files, FolderArchive, Gauge, History,
  LayoutDashboard, LoaderCircle, Menu, Moon, ScanLine, Search, Settings, ShieldCheck,
  Sun, TriangleAlert, Upload, UserRound, X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentReview } from "./document-review";
import { StoredDocument, UploadDialog } from "./upload-dialog";
import { MobileScan } from "./mobile-scan";
import { UsersScreen } from "./users";
import { ActivityScreen } from "./activity";
import { SettingsScreen } from "./settings";
import { confidenceBadge } from "../../lib/confidence-language";

type View = "dashboard" | "inbox" | "review" | "archive" | "users" | "activity" | "settings";
type DocumentRow = { id:string; referenceNo?:string; title:string; unit:string; place:string; parcel:string; status:string; rawStatus:string; confidence:number; contentMatch?:boolean; pending?:number; relations?:number };
type CurrentUser = { email:string; displayName:string; role:string; roleLabel:string; unit:string; permissions:string[] };
type HealthChecks = Record<string,{ok:boolean}>;
type Overview = {
  scope:string;
  documents:{ total:number; today:number; queued:number; processing:number; review:number; ready:number; archived:number; archivedToday:number; failed:number };
  jobs:{ queued:number; processing:number; failed:number; retryWait:number; deadLetter:number; completed24h:number; failed24h:number; errorRate24h:number };
  pending:{ fieldValues:number; relations:number; textPages:number };
  storage:{ objects:number; bytes:number; legacyKeys:number; withoutAccessDerivative:number };
  integrity:{ status:string; processed:number; total:number|null; lastError:string|null; updatedAt:string }|null;
};

const nav = [
  ["dashboard","Genel Bakış",LayoutDashboard], ["inbox","Gelen Evrak",Files],
  ["review","Doğrulama",FileCheck2], ["archive","Dijital Arşiv",FolderArchive],
] as const;



const statusLabels: Record<string,string> = { queued:"OCR kuyruğunda", processing:"İşleniyor", review:"Doğrulama", ready:"Doğrulamaya hazır", archived:"Arşivlendi", ocr_failed:"OCR hatası" };

function formatBytes(bytes:number) {
  if(bytes<=0) return "0 KB";
  if(bytes<1024*1024) return `${Math.max(1,Math.round(bytes/1024))} KB`;
  if(bytes<1024*1024*1024) return `${(bytes/1024/1024).toFixed(1)} MB`;
  return `${(bytes/1024/1024/1024).toFixed(2)} GB`;
}
function formatToday() {
  return new Date().toLocaleDateString("tr-TR",{day:"numeric",month:"long",year:"numeric",weekday:"long"});
}

function Badge({status}:{status:string}) {
  const tone=status==="Arşivlendi"?"success":status==="İşleniyor"?"info":status==="OCR hatası"?"danger":"warning";
  return <span className={`status ${tone}`}><i />{status}</span>;
}
function Table({rows,onOpen,empty}:{rows:DocumentRow[],onOpen:(id:string)=>void,empty:string}) {
  if(!rows.length) return <p className="table-empty">{empty}</p>;
  return <div className="table-wrap"><table><thead><tr><th>Belge</th><th>İlgili birim</th><th>Ada / parsel</th><th>Durum</th><th>OCR okuması</th><th /></tr></thead><tbody>
    {rows.map(d=><tr key={d.id}><td><button className="doc-cell" onClick={()=>onOpen(d.id)}><span><FileSearch size={18}/></span><b>{d.title}<small>{d.referenceNo??d.id} · {d.place}{d.relations?` · ${d.relations} doğrulanmış ilişki`:""}</small></b></button></td><td>{d.unit}</td><td className="mono">{d.parcel}</td><td><Badge status={d.status}/>{d.pending?<small className="pending-count">{d.pending} kayıt bekliyor</small>:null}</td><td>{d.confidence>0?(()=>{const okuma=confidenceBadge(d.confidence/100);
      return <b className={okuma.needsReview?"low-confidence":"confidence"}>{okuma.label}</b>;})()
      :<span className="pending-confidence">Bekliyor</span>}</td><td><button className="icon-btn" aria-label={`${d.referenceNo??d.title} belgesini aç`} onClick={()=>onOpen(d.id)}><ChevronRight size={17}/></button></td></tr>)}
  </tbody></table></div>;
}
function Metric({icon:Icon,label,value,note,tone}:{icon:typeof Files,label:string,value:string,note:string,tone:string}) {
  return <article className="metric"><span className={`metric-icon ${tone}`}><Icon size={19}/></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}

function Dashboard({rows,overview,health,open,onUpload,userName,canUpload}:{rows:DocumentRow[],overview:Overview|null,health:HealthChecks|null,open:(id:string)=>void,onUpload:()=>void,userName:string,canUpload:boolean}) {
  const documents=overview?.documents;
  const healthEntries=Object.values(health??{});
  const healthyCount=healthEntries.filter((check)=>check.ok).length;
  const healthTotal=healthEntries.length;
  const pending=overview?.pending;
  const waiting=(pending?.fieldValues??0)+(pending?.relations??0)+(pending?.textPages??0);
  // Doğrulama kuyruğu `review` ve `ready` içerir; gösterge de ikisini sayar,
  // yoksa listede görünen belge sayaçta görünmez.
  const reviewPending=documents?documents.review+documents.ready:null;
  return <>
    <section className="heading"><div><p className="eyebrow">{formatToday()}</p><h1>{userName?`Günaydın, ${userName}`:"Arşiv çalışma alanı"}</h1><span>{reviewPending!==null?(reviewPending?<>Arşiv akışında <b>{reviewPending} belge</b> doğrulamanızı bekliyor.</>:<>Doğrulama bekleyen belge yok.</>):"Sayımlar yükleniyor…"}</span></div>{canUpload?<button className="primary" onClick={onUpload}><Upload size={17}/> Yeni belge yükle</button>:null}</section>
    <section className="metrics">
      <Metric icon={Files} label="Bugün alınan" value={documents?String(documents.today):"—"} note={documents?`Toplam ${documents.total} belge`:"Yükleniyor"} tone="blue"/>
      <Metric icon={ScanLine} label="OCR kuyruğu" value={overview?String(overview.jobs.queued):"—"} note={overview?(overview.jobs.deadLetter?`${overview.jobs.deadLetter} iş dead-letter kuyruğunda`:overview.jobs.retryWait?`${overview.jobs.retryWait} iş tekrar denemeyi bekliyor`:"Hata karantinası boş"):"Yükleniyor"} tone="violet"/>
      <Metric icon={FileCheck2} label="Doğrulama bekleyen" value={reviewPending!==null?String(reviewPending):"—"} note={pending?`${waiting} kayıt kararınızı bekliyor`:"Yükleniyor"} tone="amber"/>
      <Metric icon={Archive} label="Arşivlenen" value={documents?String(documents.archived):"—"} note={overview?`${formatBytes(overview.storage.bytes)} · ${overview.storage.objects} nesne`:"Yükleniyor"} tone="green"/>
    </section>
    <section className="top-grid">
      <article className="panel flow"><header><div><h2>İşlem akışı</h2><p>Belge işleme hattının anlık durumu</p></div></header>
        <div className="steps">
          <div><b>{documents?.queued??0}</b><span>Alındı<small>OCR bekliyor</small></span></div><ChevronRight/>
          <div><b className="purple">{documents?.processing??0}</b><span>OCR<small>İşleniyor</small></span></div><ChevronRight/>
          <div><b className="orange">{reviewPending??0}</b><span>Doğrulama<small>Personel bekliyor</small></span></div><ChevronRight/>
          <div><b className="green">{documents?.archived??0}</b><span>Arşiv<small>Bugün {documents?.archivedToday??0}</small></span></div>
        </div>
        {documents?.failed?<div className="processor failed"><TriangleAlert size={19}/><span><b>{documents.failed} belge OCR hatasında</b><small>Kontrollü tekrar deneme gerekiyor</small></span></div>:null}
        {overview?.jobs.deadLetter?<div className="processor failed"><TriangleAlert size={19}/><span><b>{overview.jobs.deadLetter} OCR işi dead-letter kuyruğunda</b><small>Azami deneme sayısı aşıldı; işletim incelemesi gerekiyor</small></span></div>:null}
        {overview?.integrity?.lastError?<div className="processor failed"><TriangleAlert size={19}/><span><b>Nesne bütünlük taraması uyarı verdi</b><small>{overview.integrity.lastError}</small></span></div>:null}
        {overview?.storage.legacyKeys?<div className="processor failed"><TriangleAlert size={19}/><span><b>{overview.storage.legacyKeys} nesne anahtarı dosya adı içeriyor</b><small>Politika öncesi kayıtlar; yetkili yeniden kabulle taşınmalı</small></span></div>:null}
      </article>
      <article className="panel health"><header><div><h2>Kayıt durumu</h2><p>Ölçülen değerler</p></div></header>
        {([["Bekleyen alan değeri",pending?.fieldValues,Gauge],["Bekleyen varlık ilişkisi",pending?.relations,ShieldCheck],["Onaysız metin sayfası",pending?.textPages,Search]] as const).map(([label,value,Icon])=>
          <div className="health-row" key={label}><span><Icon size={17}/>{label}</span><b className={value?"pending":""}>{value??"—"}</b></div>)}
{/* Servis sağlığı ölçülür (Ayarlar ekranıyla aynı kaynak); yedekleme ve
            kapasite kotası hâlâ ölçülmüyor ve öyle olduğu açıkça bildirilir. */}
        <div className="health-row"><span><ShieldCheck size={17}/>Servis sağlığı</span>
          <b className={health&&healthyCount<healthTotal?"pending":""}>
            {health?`${healthyCount}/${healthTotal} çalışıyor`:"—"}</b></div>
        <div className="backup"><Clock3 size={17}/><span>Yedekleme ve kapasite kotası<b>Henüz ölçülmüyor</b></span></div>
      </article>
    </section>
    <section className="panel recent"><header><div><h2>Son belgeler</h2><p>Kapsamınızdaki en yeni kayıtlar</p></div></header><Table rows={rows} onOpen={open} empty="Henüz belge yüklenmedi."/></section>
  </>;
}

function List({rows,title,subtitle,open,onUpload,canUpload,onScan,query,onQuery,empty,hasMore,loadingMore,onLoadMore,unsearchable}:{rows:DocumentRow[],title:string,subtitle:string,open:(id:string)=>void,onUpload:()=>void,canUpload:boolean,onScan:()=>void,query:string,onQuery:(value:string)=>void,empty:string,hasMore:boolean,loadingMore:boolean,onLoadMore:()=>void,unsearchable:boolean}) {
  return <><section className="heading"><div><p className="eyebrow">BELGE YÖNETİMİ</p><h1>{title}</h1><span>{subtitle}</span></div>{canUpload?<div className="heading-actions">
    {/* §4.4: dar ekranda birincil giriş kameradır; geniş ekranda gizlenir. */}
    <button className="primary scan-entry" onClick={onScan}><Camera size={17}/> Belge tara</button>
    <button className="primary" onClick={onUpload}><Upload size={17}/> Belge ekle</button>
  </div>:null}</section><section className="panel list"><div className="list-tools"><label><Search size={17}/><input value={query} onChange={event=>onQuery(event.target.value)} placeholder="Belge no, üst veri veya metin içinde ara..."/></label></div>{query.length>=2?<p className="search-summary">{unsearchable
      ?"Arama teriminde aranabilir karakter yok; en az bir harf ya da rakam girin."
      :`Onaylı OCR metni, alan değerleri ve doğrulanmış varlık ilişkilerinde ${rows.length} sonuç gösteriliyor${hasMore?" (daha fazlası var)":""}.`}</p>:null}<Table rows={rows} onOpen={open} empty={empty}/>
    {/* Sonuç kümesi sunucuda sayfalanır; liste sessizce kesilmez. */}
    {hasMore?<div className="list-more"><button className="outline" onClick={onLoadMore} disabled={loadingMore}>{loadingMore?<LoaderCircle className="spin" size={15}/>:<ChevronDown size={15}/>} Daha fazla göster</button></div>:null}
  </section></>;
}

function toDocumentRow(document: StoredDocument): DocumentRow {
  // Ada ve parsel çok değerli alanlardır; sunucu değerleri ` / ` ile birleştirir.
  const parcel=[document.ada,document.parcel].filter(Boolean).join(" · ")||"—";
  return {
    id:document.id, referenceNo:document.referenceNo, title:document.documentType, unit:document.unit,
    place:document.neighborhood?`${document.neighborhood} Mh.`:"Mahalle girilmedi", parcel,
    status:statusLabels[document.status]??document.status, rawStatus:document.status,
    confidence:Math.round((document.confidence??0)*100),
    contentMatch:document.contentMatch,
    pending:(document.pendingValues??0)+(document.suggestedRelations??0),
    relations:document.verifiedRelations??0,
  };
}

/** Her görünümün sunucuya gönderdiği durum süzgeci. */
const viewStatuses: Record<View, string[]> = {
  dashboard: [],
  inbox: [],
  // Doğrulama kuyruğu `review` ve `ready` içerir; gösterge de aynı ikisini sayar.
  review: ["review", "ready"],
  archive: ["archived"],
  // Kullanıcı yönetimi ve işlem geçmişi belge listesi kullanmaz.
  users: [],
  activity: [],
  settings: [],
};

export function ArchiveWorkspace(){
  const [view,setView]=useState<View>("dashboard"); const [dark,setDark]=useState(false); const [mobile,setMobile]=useState(false); const [query,setQuery]=useState(""); const [selectedId,setSelectedId]=useState<string|null>(null);
  const [uploadOpen,setUploadOpen]=useState(false); const [rows,setRows]=useState<DocumentRow[]>([]); const [toast,setToast]=useState(""); const [user,setUser]=useState<CurrentUser|null>(null);
  /** §4.4 mobil tarama: tek görevlik yakalama akışı; dar ekranda görünür. */
  const [scanOpen,setScanOpen]=useState(false);
  const [overview,setOverview]=useState<Overview|null>(null);
  const [health,setHealth]=useState<HealthChecks|null>(null);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [unsearchable,setUnsearchable]=useState(false);
  const [loadingMore,setLoadingMore]=useState(false);
  const searchRef=useRef<HTMLInputElement|null>(null);

  // Arama kutusunda gösterilen `Ctrl K` rozeti gerçekten çalışır: kısayol
  // odağı aramaya taşır, Esc sorguyu temizleyip odağı bırakır.
  useEffect(()=>{
    const onKeyDown=(event:KeyboardEvent)=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if(event.key==="Escape"&&document.activeElement===searchRef.current){
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown",onKeyDown);
    return()=>window.removeEventListener("keydown",onKeyDown);
  },[]);

  const searching=query.trim().length>=2;
  const statuses=viewStatuses[view];

  /** Liste sorgusu: durum süzmesi ve sayfalama sunucuda yapılır. */
  const buildQuery=useCallback((cursor?:string|null)=>{
    const parameters=new URLSearchParams();
    if(searching) parameters.set("q",query.trim());
    if(statuses.length) parameters.set("status",statuses.join(","));
    if(cursor) parameters.set("cursor",cursor);
    return `/api/documents?${parameters.toString()}`;
  },[query,searching,statuses]);

  const loadList=useCallback(async(signal?:AbortSignal)=>{
    const response=await fetch(buildQuery(),{signal});
    const payload=await response.json() as {documents?:StoredDocument[];unsearchableQuery?:boolean;page?:{nextCursor:string|null}};
    if(!response.ok) return;
    setRows((payload.documents??[]).map(toDocumentRow));
    setNextCursor(payload.page?.nextCursor??null);
    setUnsearchable(Boolean(payload.unsearchableQuery));
  },[buildQuery]);

  const loadContext=useCallback(async()=>{
    try {
      const [meResponse,overviewResponse,healthResponse]=await Promise.all([
        fetch("/api/me"),fetch("/api/overview"),fetch("/api/health"),
      ]);
      const me=await meResponse.json() as {user?:CurrentUser};
      const counts=await overviewResponse.json() as Overview&{error?:string};
      const status=await healthResponse.json().catch(()=>null) as {checks?:HealthChecks}|null;
      setUser(me.user??null);
      setOverview(counts.error?null:counts);
      setHealth(status?.checks??null);
    } catch { /* Ağ hatasında mevcut görünüm korunur. */ }
  },[]);
  const refresh=useCallback(async()=>{await Promise.all([loadContext(),loadList()])},[loadContext,loadList]);
  // Oturum ve operasyon özeti liste sorgusundan bağımsızdır; arama yazılırken
  // tekrar yüklenmez ve eski liste yanıtı yeni sonucu ezemez.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{void loadContext()},[loadContext]);

  // Görünüm veya arama değiştiğinde liste sunucudan yeniden alınır.
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{void loadList(controller.signal).catch(()=>undefined)},searching?250:0);
    return()=>{clearTimeout(timer);controller.abort()};
  },[loadList,searching]);

  const loadMore=async()=>{
    if(!nextCursor||loadingMore) return;
    setLoadingMore(true);
    try {
      const response=await fetch(buildQuery(nextCursor));
      const payload=await response.json() as {documents?:StoredDocument[];page?:{nextCursor:string|null}};
      if(response.ok){
        setRows(current=>[...current,...(payload.documents??[]).map(toDocumentRow)]);
        setNextCursor(payload.page?.nextCursor??null);
      }
    } catch { /* Sonraki sayfa alınamazsa mevcut liste korunur. */ }
    finally { setLoadingMore(false); }
  };

  const results=searching?rows:[];
  const canUpload=user?.permissions.includes("document.upload")??false;
  const canManageUsers=user?.permissions.includes("users.manage")??false;
  // Kuyruk `review` + `ready` içerir; kenar çubuğu ve bildirim de aynı sayıyı kullanır.
  const reviewPending=overview?overview.documents.review+overview.documents.ready:0;
  const initials=(user?.displayName??"?").split(/\s+/).map(part=>part[0]).join("").slice(0,2).toLocaleUpperCase("tr");
  const created=(document:StoredDocument)=>{setToast(`${document.referenceNo} OCR kuyruğuna alındı`);setView("inbox");void refresh()};
  const go=(v:View)=>{setView(v);setMobile(false);setSelectedId(null);setNextCursor(null)};
  const openDocument=(id:string)=>{setSelectedId(id);setView("review");setMobile(false)};
  const backToList=()=>{setSelectedId(null);setView("inbox");void refresh()};

  return <div className={`archive-app ${dark?"dark":""}`}><aside className={`sidebar ${mobile?"open":""}`}><div className="brand"><b>SB</b><span><strong>SİVAS</strong><small>Dijital Arşiv</small></span><button onClick={()=>setMobile(false)}><X size={19}/></button></div><nav><p>ÇALIŞMA ALANI</p>{nav.map(([id,label,Icon])=><button className={view===id?"active":""} onClick={()=>go(id)} key={id}><Icon size={18}/><span>{label}</span>{id==="inbox"&&overview?.documents.total?<b>{overview.documents.total}</b>:null}{id==="review"&&reviewPending?<b>{reviewPending}</b>:null}</button>)}<p>YÖNETİM</p><button className={view==="activity"?"active":""} onClick={()=>go("activity")}><History size={18}/><span>İşlem Geçmişi</span></button>{canManageUsers?<><button className={view==="users"?"active":""} onClick={()=>go("users")}><UserRound size={18}/><span>Kullanıcılar</span></button><button className={view==="settings"?"active":""} onClick={()=>go("settings")}><Settings size={18}/><span>Ayarlar</span></button></>:null}</nav><footer><span>Depolanan <b>{overview?formatBytes(overview.storage.bytes):"—"}</b></span><small>{overview?`${overview.storage.objects} nesne kaydı · kapasite kotası tanımlı değil`:"Ölçülüyor"}</small><button className="upcoming" disabled title="Yardım ve destek içeriği henüz hazırlanmadı."><CircleHelp size={18}/>Yardım ve destek<em>Yakında</em></button></footer></aside>{mobile&&<button className="backdrop" onClick={()=>setMobile(false)}/>}<section className="workspace"><header className="appbar"><button className="menu" onClick={()=>setMobile(true)}><Menu size={20}/></button><label className="search"><Search size={18}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Belge, muhatap, ada / parsel ara..."/><kbd>Ctrl K</kbd>{results.length>0&&<div className="results">{results.slice(0,4).map(d=><button key={d.id} onClick={()=>openDocument(d.id)}><FileSearch size={17}/><span><b>{d.title}</b><small>{d.referenceNo??d.id} · {d.parcel}{d.contentMatch?" · Tam metin eşleşmesi":""}</small></span><ChevronRight size={15}/></button>)}</div>}</label><div className="actions"><button onClick={()=>setDark(!dark)} aria-label={dark?"Aydınlık temaya geç":"Karanlık temaya geç"}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button>
    {/* Zil, bekleyen doğrulama kuyruğuna götürür; kuyruk boşken tıklanamaz. */}
    <button className="bell" onClick={()=>go("review")} disabled={!reviewPending} title={reviewPending?`${reviewPending} belge doğrulama bekliyor`:"Doğrulama bekleyen belge yok"} aria-label={reviewPending?`${reviewPending} belge doğrulama bekliyor; kuyruğu aç`:"Doğrulama bekleyen belge yok"}><Bell size={18}/>{reviewPending?<i/>:null}</button>
    <span className="avatar">{initials}</span><div><b>{user?.displayName??"Oturum bekleniyor"}</b><small>{user?.roleLabel??"Yetki doğrulanıyor"}{user&&user.unit!=="*"?` · ${user.unit}`:""}</small></div></div></header><main id="main-content" className={selectedId?"review-main":"main"}>
    {selectedId
      ?<DocumentReview documentId={selectedId} onBack={backToList} permissions={user?.permissions??[]}/>
      :view==="users"?<UsersScreen/>
      :view==="activity"?<ActivityScreen onOpenDocument={openDocument}/>
      :view==="settings"?<SettingsScreen/>
      :view==="dashboard"?<Dashboard rows={rows.slice(0,5)} overview={overview} health={health} open={openDocument} onUpload={()=>setUploadOpen(true)} userName={user?.displayName??""} canUpload={canUpload}/>
      :<List
        rows={rows}
        title={view==="inbox"?"Gelen Evrak":view==="review"?"Doğrulama":"Dijital Arşiv"}
        subtitle={view==="inbox"?"Yeni belgeleri, OCR durumunu ve hataları yönetin."
          :view==="review"?"Alan değerleri, tam metin ve varlık ilişkileri personel kararı bekleyen belgeler."
          :"Arşiv kayıtlarını belge içeriği, üst verileri ve varlık ilişkileriyle bulun."}
        empty={view==="inbox"?"Kapsamınızda belge bulunmuyor."
          :view==="review"?"Doğrulama bekleyen belge yok."
          :"Henüz arşivlenmiş belge yok."}
        open={openDocument} onUpload={()=>setUploadOpen(true)} canUpload={canUpload}
        onScan={()=>setScanOpen(true)}
        query={query} onQuery={setQuery} unsearchable={unsearchable}
        hasMore={Boolean(nextCursor)} loadingMore={loadingMore} onLoadMore={loadMore}
      />}
  </main></section><UploadDialog open={uploadOpen} onClose={()=>setUploadOpen(false)} onCreated={created}/><MobileScan open={scanOpen} onClose={()=>setScanOpen(false)}/>{toast&&<div className="toast" role="status"><CheckCircle2 size={17}/><span>{toast}</span><button onClick={()=>setToast("")} aria-label="Bildirimi kapat"><X size={15}/></button></div>}</div>;
}
