"use client";

import {
  Archive, Bell, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  FileCheck2, FileSearch, Files, Filter, FolderArchive, Gauge, History,
  LayoutDashboard, Menu, Moon, ScanLine, Search, Settings, ShieldCheck,
  Sparkles, Sun, Upload, UserRound, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DocumentReview } from "./document-review";
import { StoredDocument, UploadDialog } from "./upload-dialog";

type View = "dashboard" | "inbox" | "review" | "archive";
type DocumentRow = { id:string; referenceNo?:string; title:string; unit:string; place:string; parcel:string; status:string; confidence:number; contentMatch?:boolean; pending?:number; relations?:number };
type CurrentUser = { email:string; displayName:string; role:string; roleLabel:string; unit:string; permissions:string[] };
const seedDocs: DocumentRow[] = [
  { id:"2026-004281", title:"Yapı kullanma izin belgesi", unit:"İmar ve Şehircilik Müdürlüğü", place:"Kardeşler Mh.", parcel:"1847 / 12-A", status:"Doğrulama", confidence:78 },
  { id:"2026-004280", title:"İşyeri açma ruhsatı", unit:"Ruhsat ve Denetim Müdürlüğü", place:"Yenişehir Mh.", parcel:"963 / 7", status:"İşleniyor", confidence:91 },
  { id:"2026-004279", title:"Encümen karar sureti", unit:"Yazı İşleri Müdürlüğü", place:"Merkez", parcel:"—", status:"Arşivlendi", confidence:96 },
  { id:"2026-004278", title:"Numarataj tespit tutanağı", unit:"İmar ve Şehircilik Müdürlüğü", place:"Kılavuz Mh.", parcel:"214 / 3-B", status:"Doğrulama", confidence:69 },
  { id:"2026-004277", title:"Yangın güvenlik raporu", unit:"İtfaiye Müdürlüğü", place:"Gültepe Mh.", parcel:"87 / 21", status:"Arşivlendi", confidence:98 },
];
const nav = [
  ["dashboard","Genel Bakış",LayoutDashboard], ["inbox","Gelen Evrak",Files],
  ["review","Doğrulama",FileCheck2], ["archive","Dijital Arşiv",FolderArchive],
] as const;

function Badge({status}:{status:string}) {
  const tone=status==="Arşivlendi"?"success":status==="İşleniyor"?"info":"warning";
  return <span className={`status ${tone}`}><i />{status}</span>;
}
function Table({rows,onOpen}:{rows:DocumentRow[],onOpen:(id:string)=>void}) {
  return <div className="table-wrap"><table><thead><tr><th>Belge</th><th>İlgili birim</th><th>Ada / parsel</th><th>Durum</th><th>Güven</th><th /></tr></thead><tbody>
    {rows.map(d=><tr key={d.id}><td><button className="doc-cell" onClick={()=>onOpen(d.id)}><span><FileSearch size={18}/></span><b>{d.title}<small>{d.referenceNo??d.id} · {d.place}{d.relations?` · ${d.relations} doğrulanmış ilişki`:""}</small></b></button></td><td>{d.unit}</td><td className="mono">{d.parcel}</td><td><Badge status={d.status}/>{d.pending?<small className="pending-count">{d.pending} kayıt bekliyor</small>:null}</td><td>{d.confidence>0?<b className={d.confidence<80?"low-confidence":"confidence"}>%{d.confidence}</b>:<span className="pending-confidence">Bekliyor</span>}</td><td><button className="icon-btn" aria-label={`${d.id} belgesini aç`} onClick={()=>onOpen(d.id)}><ChevronRight size={17}/></button></td></tr>)}
  </tbody></table></div>;
}
function Metric({icon:Icon,label,value,note,tone}:{icon:typeof Files,label:string,value:string,note:string,tone:string}) {
  return <article className="metric"><span className={`metric-icon ${tone}`}><Icon size={19}/></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}
function Dashboard({rows,open,onUpload,userName,canUpload}:{rows:DocumentRow[],open:(id:string)=>void,onUpload:()=>void,userName:string,canUpload:boolean}) {
  return <>
    <section className="heading"><div><p className="eyebrow">16 Temmuz 2026 · Perşembe</p><h1>Günaydın, {userName}</h1><span>Arşiv akışında bugün <b>7 belge</b> doğrulamanızı bekliyor.</span></div>{canUpload?<button className="primary" onClick={onUpload}><Upload size={17}/> Yeni belge yükle</button>:null}</section>
    <section className="metrics"><Metric icon={Files} label="Bugün alınan" value="38" note="Düne göre +%12" tone="blue"/><Metric icon={ScanLine} label="OCR kuyruğu" value="11" note="Tahmini 4 dakika" tone="violet"/><Metric icon={FileCheck2} label="Doğrulama bekleyen" value="7" note="2 yüksek öncelikli" tone="amber"/><Metric icon={Archive} label="Toplam arşiv" value="128.430" note="2,8 TB güvenli saklama" tone="green"/></section>
    <section className="top-grid"><article className="panel flow"><header><div><h2>İşlem akışı</h2><p>Belge işleme hattının anlık durumu</p></div><button>Kuyruğu aç <ChevronRight size={15}/></button></header><div className="steps"><div><b>24</b><span>Alındı<small>Bütünlük kontrolü</small></span></div><ChevronRight/><div><b className="purple">11</b><span>OCR<small>Alanlar çıkarılıyor</small></span></div><ChevronRight/><div><b className="orange">7</b><span>Doğrulama<small>Personel bekliyor</small></span></div><ChevronRight/><div><b className="green">31</b><span>Arşiv<small>Bugün tamamlandı</small></span></div></div><div className="processor"><ScanLine size={19}/><span><b>OCR işlemcisi çalışıyor</b><small>BELEDIYE_1998_0241.pdf · 16 / 23 sayfa</small></span><i><em/></i><strong>%70</strong></div></article>
    <article className="panel health"><header><div><h2>Sistem sağlığı</h2><p>Yerel servisler</p></div><span className="healthy">Tümü çalışıyor</span></header>{([{icon:Gauge,label:"OCR işleyici"},{icon:ShieldCheck,label:"Dosya kasası"},{icon:Search,label:"Arama dizini"}] as const).map(({icon:Icon,label})=><div className="health-row" key={label}><span><Icon size={17}/>{label}</span><b><i/>Çevrimiçi</b></div>)}<div className="backup"><Clock3 size={17}/><span>Son yedekleme<b>Bugün 03:15</b></span><ChevronRight size={16}/></div></article></section>
    <section className="panel recent"><header><div><h2>Son belgeler</h2><p>Bugün işlenen ve inceleme bekleyen kayıtlar</p></div><button className="outline"><Filter size={15}/> Filtrele</button></header><Table rows={rows} onOpen={open}/></section>
  </>;
}
function List({rows,archive,open,onUpload,canUpload,query,onQuery}:{rows:DocumentRow[],archive:boolean,open:(id:string)=>void,onUpload:()=>void,canUpload:boolean,query:string,onQuery:(value:string)=>void}) {
  return <><section className="heading"><div><p className="eyebrow">BELGE YÖNETİMİ</p><h1>{archive?"Dijital Arşiv":"Gelen Evrak"}</h1><span>{archive?"Arşiv kayıtlarını belge içeriği ve üst verileriyle bulun.":"Yeni belgeleri, OCR durumunu ve hataları yönetin."}</span></div>{canUpload?<button className="primary" onClick={onUpload}><Upload size={17}/> Belge ekle</button>:null}</section><section className="panel list"><div className="list-tools"><label><Search size={17}/><input value={query} onChange={event=>onQuery(event.target.value)} placeholder="Belge no, üst veri veya metin içinde ara..."/></label><button className="outline"><Filter size={15}/> Gelişmiş filtre</button></div>{query.length>=2?<p className="search-summary">Temiz OCR metni ve tüm belge alanlarında {rows.length} sonuç bulundu.</p>:null}<Table rows={rows} onOpen={open}/></section></>;
}
function Review({back}:{back:()=>void}) {
  return <div className="review"><div className="review-head"><button onClick={back}>‹ Belge listesi</button><span><Badge status="Doğrulama"/><b>2026-004281</b></span><div><button className="outline">Taslak kaydet</button><button className="approve"><CheckCircle2 size={17}/> Doğrula ve arşivle</button></div></div><div className="review-grid"><aside className="thumbs">{[1,2,3].map(n=><button className={n===1?"active":""} key={n}><span>{n}</span><i/></button>)}</aside><section className="document"><div className="document-tools"><span>Sayfa 1 / 3</span><div><button aria-label="Uzaklaştır"><ZoomOut size={17}/></button><b>%92</b><button aria-label="Yakınlaştır"><ZoomIn size={17}/></button></div></div><article className="paper"><div className="seal">SİVAS<br/>BELEDİYESİ</div><p className="paper-title">T.C.<br/><b>SİVAS BELEDİYE BAŞKANLIĞI</b><br/>İmar ve Şehircilik Müdürlüğü</p><div className="paper-meta"><span>Sayı: E-78452136-115.02-<mark>4281</mark></span><span>16.07.2026</span></div><h3>YAPI KULLANMA İZİN BELGESİ</h3><p>İlimiz Merkez ilçesi, <mark>Kardeşler Mahallesi</mark> sınırları içerisinde bulunan <mark>1847 ada, 12/A parsel</mark> üzerindeki yapıya ilişkin yapılan inceleme sonucunda...</p><p>İlgilisi: <mark>Ahmet YILMAZ</mark><br/>Başvuru birimi: <mark>İmar ve Şehircilik Müdürlüğü</mark></p><div className="signature">Elektronik imzalıdır<br/><b>Mehmet KAYA</b><br/>Şube Müdürü</div></article></section><aside className="fields"><header><Sparkles size={18}/><span><b>Yapay zekâ çıkarımı</b><small>Alanları belge ile karşılaştırın</small></span><em>Yerel OCR</em></header><div className="quality"><Gauge size={17}/><span><b>Belge güveni %78</b><small>Düşük güvenli 2 alan kontrol gerektiriyor.</small></span></div><label>Belge türü <b>%96</b><input defaultValue="Yapı kullanma izin belgesi"/></label><label>İlgili müdürlük <b>%94</b><input defaultValue="İmar ve Şehircilik Müdürlüğü"/></label><label>Mahalle <b>%91</b><input defaultValue="Kardeşler"/></label><div className="field-pair"><label>Ada <b className="warn">%76</b><input defaultValue="1847"/></label><label>Parsel <b className="warn">%64</b><input className="attention" defaultValue="12/A"/></label></div><label>Muhatap <b>%88</b><input defaultValue="Ahmet YILMAZ"/></label><label>Belge tarihi <b>%99</b><input defaultValue="16.07.2026"/></label></aside></div></div>;
}
function toDocumentRow(document: StoredDocument): DocumentRow {
  const statuses: Record<string,string> = { queued:"OCR kuyruğunda", processing:"İşleniyor", review:"Doğrulama", ready:"Doğrulamaya hazır", archived:"Arşivlendi", ocr_failed:"OCR hatası" };
  // Ada ve parsel çok değerli alanlardır; sunucu değerleri ` / ` ile birleştirir.
  const parcel=[document.ada,document.parcel].filter(Boolean).join(" · ")||"—";
  return {
    id:document.id, referenceNo:document.referenceNo, title:document.documentType, unit:document.unit,
    place:document.neighborhood?`${document.neighborhood} Mh.`:"Yeni yükleme", parcel,
    status:statuses[document.status]??document.status, confidence:Math.round((document.confidence??0)*100),
    contentMatch:document.contentMatch,
    pending:(document.pendingValues??0)+(document.suggestedRelations??0),
    relations:document.verifiedRelations??0,
  };
}
export function ArchiveWorkspace(){
  const [view,setView]=useState<View>("dashboard"); const [dark,setDark]=useState(false); const [mobile,setMobile]=useState(false); const [query,setQuery]=useState(""); const [selectedId,setSelectedId]=useState<string|null>(null);
  const [uploadOpen,setUploadOpen]=useState(false); const [stored,setStored]=useState<DocumentRow[]>([]); const [searchRows,setSearchRows]=useState<DocumentRow[]>([]); const [toast,setToast]=useState(""); const [user,setUser]=useState<CurrentUser|null>(null);
  useEffect(()=>{let active=true;Promise.all([fetch("/api/me"),fetch("/api/documents")]).then(async([meResponse,documentsResponse])=>{const me=await meResponse.json() as {user?:CurrentUser};const payload=await documentsResponse.json() as {documents?:StoredDocument[]};if(active){setUser(me.user??null);setStored((payload.documents??[]).map(toDocumentRow))}}).catch(()=>undefined);return()=>{active=false}},[]);
  useEffect(()=>{if(query.trim().length<2)return;const controller=new AbortController();const timer=setTimeout(()=>{fetch(`/api/documents?q=${encodeURIComponent(query)}`,{signal:controller.signal}).then(async response=>{const payload=await response.json() as {documents?:StoredDocument[]};if(response.ok)setSearchRows((payload.documents??[]).map(toDocumentRow))}).catch(()=>undefined)},250);return()=>{clearTimeout(timer);controller.abort()}},[query]);
  const allDocs=useMemo(()=>stored.length?stored:(user?.role==="admin"?seedDocs:[]),[stored,user]);
  const results=query.trim().length<2?[]:searchRows;
  const visibleDocs=query.trim().length>=2?searchRows:allDocs;
  const canUpload=user?.permissions.includes("document.upload")??false;
  const initials=(user?.displayName??"?").split(/\s+/).map(part=>part[0]).join("").slice(0,2).toLocaleUpperCase("tr");
  const created=(document:StoredDocument)=>{setStored(current=>[toDocumentRow(document),...current.filter(item=>item.id!==document.id)]);setToast(`${document.referenceNo} OCR kuyruğuna alındı`);setView("inbox")};
  const go=(v:View)=>{setView(v);setMobile(false)};
  const openDocument=(id:string)=>{setSelectedId(id);go("review")};
  return <div className={`archive-app ${dark?"dark":""}`}><aside className={`sidebar ${mobile?"open":""}`}><div className="brand"><b>SB</b><span><strong>SİVAS</strong><small>Dijital Arşiv</small></span><button onClick={()=>setMobile(false)}><X size={19}/></button></div><nav><p>ÇALIŞMA ALANI</p>{nav.map(([id,label,Icon])=><button className={view===id?"active":""} onClick={()=>go(id)} key={id}><Icon size={18}/><span>{label}</span>{id==="inbox"&&<b>24</b>}{id==="review"&&<b>7</b>}</button>)}<p>YÖNETİM</p><button><History size={18}/><span>İşlem Geçmişi</span></button><button><UserRound size={18}/><span>Kullanıcılar</span></button><button><Settings size={18}/><span>Ayarlar</span></button></nav><footer><span>Depolama <b>%68</b></span><i><em/></i><small>2,8 TB / 4 TB kullanılıyor</small><button><CircleHelp size={18}/>Yardım ve destek</button></footer></aside>{mobile&&<button className="backdrop" onClick={()=>setMobile(false)}/>}<section className="workspace"><header className="appbar"><button className="menu" onClick={()=>setMobile(true)}><Menu size={20}/></button><label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Belge, muhatap, ada / parsel ara..."/><kbd>Ctrl K</kbd>{results.length>0&&<div className="results">{results.slice(0,4).map(d=><button key={d.id} onClick={()=>openDocument(d.id)}><FileSearch size={17}/><span><b>{d.title}</b><small>{d.referenceNo??d.id} · {d.parcel}{d.contentMatch?" · Tam metin eşleşmesi":""}</small></span><ChevronRight size={15}/></button>)}</div>}</label><div className="actions"><button onClick={()=>setDark(!dark)}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button><button className="bell"><Bell size={18}/><i/></button><span className="avatar">{initials}</span><div><b>{user?.displayName??"Oturum bekleniyor"}</b><small>{user?.roleLabel??"Yetki doğrulanıyor"}{user&&user.unit!=="*"?` · ${user.unit}`:""}</small></div><ChevronDown size={15}/></div></header><main id="main-content" className={view==="review"?"review-main":"main"}>{view==="dashboard"&&<Dashboard rows={allDocs.slice(0,4)} open={openDocument} onUpload={()=>setUploadOpen(true)} userName={user?.displayName??""} canUpload={canUpload}/>} {view==="inbox"&&<List rows={visibleDocs} archive={false} open={openDocument} onUpload={()=>setUploadOpen(true)} canUpload={canUpload} query={query} onQuery={setQuery}/>} {view==="archive"&&<List rows={visibleDocs} archive open={openDocument} onUpload={()=>setUploadOpen(true)} canUpload={canUpload} query={query} onQuery={setQuery}/>} {view==="review"&&(selectedId?<DocumentReview documentId={selectedId} onBack={()=>go("inbox")} permissions={user?.permissions??[]}/>:<Review back={()=>go("dashboard")}/>)}</main></section><UploadDialog open={uploadOpen} onClose={()=>setUploadOpen(false)} onCreated={created}/>{toast&&<div className="toast" role="status"><CheckCircle2 size={17}/><span>{toast}</span><button onClick={()=>setToast("")} aria-label="Bildirimi kapat"><X size={15}/></button></div>}</div>;
}
