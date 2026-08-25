"use client";

/* eslint-disable @next/next/no-img-element -- Özel R2 dosya rotası Next Image iyileştirmesine uygun değildir. */

import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileClock, FileCog, FileText, Gauge, History, Image as ImageIcon, LoaderCircle, LockKeyhole, Play, Plus, RotateCcw, Save, ScanLine, ShieldCheck, Sparkles, ThumbsDown, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { EntityRelation, EntityRelations } from "./entity-relations";
import { auditLabels } from "./audit-labels";
import {
  FIELD_REJECTION_VOCABULARY_CODE, OTHER_REASON_CODE,
  RELATION_REJECTION_VOCABULARY_CODE, type RejectionReason,
} from "../../lib/rejection-reasons";
import { FILE_PLAN_VOCABULARY_CODE, RETENTION_RULE_VOCABULARY_CODE } from "../../lib/file-plan";
import { confidencePhrase } from "../../lib/confidence-language";
import { evidenceCropStyle, hasEvidenceBox } from "../../lib/evidence-crop";
import { parseQuickQuery } from "../../lib/quick-query";
import {
  findHighlightRanges, matchesAnyToken, matchSnippets, searchTokens, type HighlightRange,
} from "../../lib/search-highlight";
import { RelationBulkPanel } from "./relation-bulk-panel";

const MISSING_VALUE = "Belirlenmedi";

/** Vurgu aralıklarını <mark> düğümlerine çevirir; aralık yoksa metin olduğu gibi döner. */
function renderMarks(text:string,ranges:HighlightRange[]){
  if(!ranges.length) return text;
  const nodes:Array<string|ReactElement>=[];
  let cursor=0;
  ranges.forEach(([start,end],index)=>{
    if(start>cursor) nodes.push(text.slice(cursor,start));
    nodes.push(<mark key={index}>{text.slice(start,end)}</mark>);
    cursor=end;
  });
  if(cursor<text.length) nodes.push(text.slice(cursor));
  return nodes;
}

type VerificationStatus = "SUGGESTED" | "CONFIRMED" | "CORRECTED" | "REJECTED";

type DetailValue = {
  id:string; name:string; label:string; valueIndex:number; value:string; originalValue:string;
  normalizedValue:string|null; confidence:number; riskLevel:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL";
  verificationStatus:VerificationStatus; origin:"OCR"|"HUMAN"; pageNumber:number;
  box:[number,number,number,number]; evidenceText:string; model:string;
  verifiedBy:string|null; verifiedAt:string|null; corrected:boolean; correctedBy:string|null; correctedAt:string|null;
  /** Biçim kuralı ihlali varsa gerekçe; kural sunucudadır, istemci hesaplayamaz. */
  formatViolation:string|null;
  /** Reddedilmişse gerekçesi; karar sebebiyle birlikte okunmalıdır. */
  rejection:{code:string;label:string;note:string|null}|null;
};
type FieldGroup = {
  name:string; label:string; multiValue:boolean; critical:boolean; required:boolean;
  requirement:"OPTIONAL"|"REQUIRED"|"REQUIRED_FOR_ARCHIVE";
  extractionPolicy:"NONE"|"SUGGEST"|"VERIFY_REQUIRED";
  dataType:string; formatHint:string|null; vocabularyCode:string|null; enforceVocabulary:boolean;
  valueIds:string[];
};
type ProfileInfo = { code:string; name:string; version:string; status:string; ownerDepartment:string; recordedVersion:string|null };
type VocabularyMap = Record<string, Array<{ code:string; label:string }> | null>;
type DetailPage = { pageNumber:number; width:number; height:number; rawText:string; fullText:string; searchText:string; confirmedText:string|null; confirmedBy:string|null; confirmedAt:string|null; words:Array<{text:string;confidence:number;box:[number,number,number,number]}>; averageConfidence:number; model:string };
type Classification = { code:string; label:string } | null;
type DetailDocument = { id:string; referenceNo:string; originalName:string; mediaType:string; byteSize:number; sha256:string; documentType:string; unit:string; status:string; uploadedBy:string; createdAt:string; updatedAt:string; fileUrl:string; filePlan:Classification; retentionRule:Classification };
type BinaryObject = { id:string; objectClass:string; mediaType:string; byteSize:number; sha256:string; retentionStatus:string; legalHoldStatus:string; generator:string|null; createdAt:string };
type AuditEvent = { eventNumber:number; actor:string; action:string; details:unknown; previousHash:string|null; eventHash:string; createdAt:string };
type OcrJobState = { status:string; attempt:number; maxAttempts:number; deadLettered:boolean;
  nextAttemptAt:string|null; lastAttemptAt:string|null; errorMessage:string|null };
type DetailPayload = { document:DetailDocument; ocrJob?:OcrJobState|null; profile:ProfileInfo; vocabularies:VocabularyMap; pages:DetailPage[]; fields:DetailValue[]; fieldGroups:FieldGroup[]; relations:EntityRelation[]; objects:BinaryObject[]; audit:AuditEvent[] };

type Addition = { key:string; fieldName:string; value:string };
type ValueOperation = { id:string; action:"confirm"|"correct"|"reject"; value?:string;
  reasonCode?:string; reasonNote?:string };
type RejectionDraft = { code:string; note:string };

/*
 * design.md §6: memur dili. "OCR", "kuyruk", "işleme" makine terimleridir;
 * memurun gördüğü durum, belgenin OKUNMA hâlidir.
 */
const statusLabels: Record<string,string> = { queued:"Okunmayı bekliyor", processing:"Belge okunuyor", review:"Doğrulama bekliyor", ready:"Doğrulamaya hazır", archived:"Arşivlendi", ocr_failed:"Okuma başarısız" };
/* Karar durumu memurun kendi eylemiyle anlatılır: "Öneri" makinenin
 * bakışıdır, "Kontrol edilmedi" memurun yapılacak işidir. */
const valueStatusLabels: Record<VerificationStatus,string> = { SUGGESTED:"Kontrol edilmedi", CONFIRMED:"Kontrol edildi", CORRECTED:"Düzeltildi", REJECTED:"Reddedildi" };

export function DocumentReview({ documentId, onBack, permissions, searchTerm }: { documentId:string; onBack:()=>void; permissions:string[]; searchTerm?:string }) {
  const [detail,setDetail]=useState<DetailPayload|null>(null);
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [rejections,setRejections]=useState<Record<string,boolean>>({});
  /** Ret gerekçesi kontrollü koddur; kayda geçmeden önce burada toplanır. */
  const [rejectionDrafts,setRejectionDrafts]=useState<Record<string,RejectionDraft>>({});
  // Gerekçe listeleri kurumun düzenlediği sözlüklerdir; kod içinde sabit değil.
  const fieldRejectionReasons:RejectionReason[]=detail?.vocabularies[FIELD_REJECTION_VOCABULARY_CODE]??[];
  const relationRejectionReasons:RejectionReason[]=detail?.vocabularies[RELATION_REJECTION_VOCABULARY_CODE]??[];
  // §9.5: arşivleme tasnifi bu iki kontrollü listeden yapılır.
  const filePlanTerms:RejectionReason[]=detail?.vocabularies[FILE_PLAN_VOCABULARY_CODE]??[];
  const retentionRuleTerms:RejectionReason[]=detail?.vocabularies[RETENTION_RULE_VOCABULARY_CODE]??[];
  const [additions,setAdditions]=useState<Addition[]>([]);
  const [textDrafts,setTextDrafts]=useState<Record<number,string>>({});
  const [loading,setLoading]=useState(true);
  const [processing,setProcessing]=useState(false);
  const [saving,setSaving]=useState(false);
  const [savingText,setSavingText]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [activeValueId,setActiveValueId]=useState<string|null>(null);
  const [previewMode,setPreviewMode]=useState<"image"|"text">("image");
  /*
   * design.md §4.1 (2a): ekran tek bir soru sorar. İlişkiler, nesne kayıtları
   * ve denetim izi ayrı sekmelere alınır ki doğrulama kolonunda yalnız
   * "şimdi ne yapmam gerekiyor" kalsın.
   */
  const [activeTab,setActiveTab]=useState<"fields"|"relations"|"audit">("fields");
  /** §9.2: çok önerili belgede toplu karar paneli belge alanının üzerine kayar. */
  const [bulkOpen,setBulkOpen]=useState(false);
  /*
   * Kullanıcı kararı (2026-08-20): "Teknik görünüm" ve "Yoğun düzen" kipleri
   * kaldırıldı — ekran, teknoloji bilgisi olmayan memurun da anlayacağı TEK
   * sade düzende çalışır. design.md §9.3/§4.3'ün öngördüğü teknik gösterimler
   * (ham yüzde, kanıt koordinatı, SHA, profil sürümü) arayüzden çıkarıldı;
   * bu ölçüler denetim/işletim tarafında (API, log, denetim zinciri) durmaya
   * devam eder. `technical.view` yetkisi ileri bir API kapısı için duruyor.
   */
  const [fileSrc,setFileSrc]=useState("");
  /*
   * Önizleme hatası kendi durumunda tutulur. Ortak `error` kullanıldığında,
   * belge yeniden yüklendikçe arka planda çalışan önizleme isteği personelin
   * az önce yaptığı işlemin sonucunu eziyordu: OCR'ı yeniden başlatan memur,
   * "görüntüleme kopyası hazırlanıyor" mesajını okuyordu. Üstelik bu tam da
   * OCR bekleyen belgelerde çakışır, çünkü onların türevi henüz yoktur.
   */
  const [previewError,setPreviewError]=useState("");
  /**
   * Görüntüleme kopyası arka planda üretilir; "hazırlanıyor" yanıtı bir hata
   * değil bir SÜREÇTİR. Memurdan "daha sonra yeniden deneyin" istemek yerine
   * ekran kendisi 20 saniyede bir yeniden dener ve kopya hazır olunca
   * kendiliğinden açar. Tavan (20 deneme ≈ 7 dk) sonsuz döngüyü keser;
   * gerçek hatalar (yetki, kayıp nesne) yeniden denenmez, açıkça gösterilir.
   */
  const [previewRetry,setPreviewRetry]=useState(0);
  /**
   * Görüntüleme kopyası HAZIRLANIRKEN indirme yetkisi olan kullanıcıya
   * belgenin aslı gösterilir. Bu bir politika değişikliği değildir: aynı
   * kullanıcı aynı belgeyi "Aslını indir" ile zaten alabiliyor; burada da
   * aynı DOWNLOAD bileti kullanılır ve aynı şekilde denetlenir
   * (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5'in izin verdiği tek asıl
   * erişim yolu). Değişen yalnız sunumdur — memur dosyayı indirip ayrı
   * programda açmak yerine aynı çerçevede görür. Yerelde render servisi hiç
   * koşmadığı için bu tek gerçek önizlemedir; üretimde de kopya üretilene
   * kadarki boşluğu doldurur.
   */
  const [showingOriginal,setShowingOriginal]=useState(false);
  useEffect(()=>{
    if(!previewError||fileSrc) return;
    if(!previewError.includes("hazırlanıyor")) return;
    if(previewRetry>=20) return;
    const timer=setTimeout(()=>setPreviewRetry(current=>current+1),20_000);
    return()=>clearTimeout(timer);
  },[previewError,fileSrc,previewRetry]);

  /**
   * Dosya isteği başarısızsa sunucunun verdiği sebebi okur.
   *
   * Yetki reddi, kasada bulunamayan nesne ve geçici depolama arızası
   * kullanıcı için farklı eylemler gerektirir ("yöneticinize başvurun",
   * "işletime bildirin", "tekrar deneyin"); hepsini tek genel cümleye
   * indirmek bu ayrımı yok eder.
   */
  const fileErrorMessage=async(response:Response,fallback:string)=>{
    const payload=await response.json().catch(()=>null) as {error?:string}|null;
    return payload?.error??fallback;
  };

  /** Açık bilet URL'ye yazılmaz; Authorization başlığı log/geçmiş sızıntısını önler. */
  const requestTicket=useCallback(async(scope:"VIEW"|"DOWNLOAD")=>{
    const purpose=scope==="VIEW"?"DOCUMENT_REVIEW":"ORIGINAL_DOWNLOAD";
    const response=await fetch(`/api/documents/${documentId}/access-ticket`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({scope,purpose}),
    });
    const payload=await response.json() as {ticket?:string;error?:string};
    if(!response.ok||!payload.ticket) throw new Error(payload.error||"Erişim bileti alınamadı.");
    return payload.ticket;
  },[documentId]);

  useEffect(()=>{
    if(!detail) return;
    let cancelled=false;
    let objectUrl="";
    (async()=>{
      // Temizlik efekt gövdesinde değil burada: eşzamanlı setState basamaklı
      // yeniden çizime yol açar.
      setPreviewError("");
      setShowingOriginal(false);
      try {
        const ticket=await requestTicket("VIEW");
        const response=await fetch(detail.document.fileUrl,{
          headers:{authorization:`ArchiveTicket ${ticket}`,"x-archive-access-scope":"VIEW"},
        });
        if(!response.ok) throw new Error(await fileErrorMessage(response,"Belge görüntüsü alınamadı."));
        const blob=await response.blob();
        if(cancelled) return;
        objectUrl=URL.createObjectURL(blob);
        setFileSrc(objectUrl);
      } catch(reason) {
        const message=reason instanceof Error?reason.message:"Belge görüntüsü alınamadı.";
        // Kopya hazırlanırken çıkmaz sokak yok: indirme yetkisi olan memura
        // belgenin aslı aynı çerçevede gösterilir (yetki notu showingOriginal
        // üstünde). Asıl da alınamazsa süreç kartına düşülür; asıl gösterimi
        // bir kolaylıktır, kendi hatasını memura ayrıca taşımaz.
        if(message.includes("hazırlanıyor")&&permissions.includes("document.download")){
          try {
            const downloadTicket=await requestTicket("DOWNLOAD");
            const original=await fetch(detail.document.fileUrl,{
              headers:{authorization:`ArchiveTicket ${downloadTicket}`,"x-archive-access-scope":"DOWNLOAD"},
            });
            if(original.ok){
              const blob=await original.blob();
              if(cancelled) return;
              objectUrl=URL.createObjectURL(blob);
              setFileSrc(objectUrl);
              setShowingOriginal(true);
              return;
            }
          } catch { /* süreç kartı zaten doğru durumu anlatıyor */ }
        }
        if(!cancelled) setPreviewError(message);
      }
    })();
    return()=>{cancelled=true;if(objectUrl) URL.revokeObjectURL(objectUrl);};
  },[detail,requestTicket,previewRetry,permissions]);

  const downloadOriginal=async()=>{
    if(!detail) return;
    try {
      const ticket=await requestTicket("DOWNLOAD");
      const response=await fetch(detail.document.fileUrl,{
        headers:{authorization:`ArchiveTicket ${ticket}`,"x-archive-access-scope":"DOWNLOAD"},
      });
      if(!response.ok) throw new Error(await fileErrorMessage(response,"Asıl belge indirilemedi."));
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement("a");
      link.href=url;link.download=detail.document.originalName;
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),60_000);
    } catch(reason) {
      setError(reason instanceof Error?reason.message:"İndirme bileti alınamadı.");
    }
  };
  const load=useCallback(async()=>{
    setLoading(true);
    setError("");
    setPreviewRetry(0);
    try {
      const response=await fetch(`/api/documents/${documentId}`);
      const payload=await response.json() as DetailPayload&{error?:string};
      if(!response.ok) throw new Error(payload.error||"Belge alınamadı.");
      setDetail(payload);
      setDrafts(Object.fromEntries(payload.fields.map(value=>[value.id,value.value])));
      setRejections({});
      setAdditions([]);
      setTextDrafts(Object.fromEntries(payload.pages.map(page=>[page.pageNumber,page.confirmedText??page.fullText])));
      setActiveValueId(current=>current&&payload.fields.some(value=>value.id===current)?current:payload.fields[0]?.id??null);
    } catch(reason) {
      setError(reason instanceof Error?reason.message:"Belge alınamadı.");
    } finally {
      setLoading(false);
    }
  },[documentId]);
  // Veri yüklemesi, belge kimliği değiştiğinde eşzamanlı olarak başlatılmalıdır.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{void load()},[load]);

  const process=async()=>{
    setProcessing(true);setError("");setNotice("");
    let failureMessage:string|null=null;
    try {
      const response=await fetch(`/api/jobs/process?documentId=${encodeURIComponent(documentId)}`,{method:"POST"});
      const payload=await response.json() as {error?:string;processed?:boolean;message?:string;suggestedRelations?:number};
      if(!response.ok) throw new Error(payload.error||"OCR işlemi başlatılamadı.");
      /*
       * `processed:false` da 200 döner: iş geri çekilme penceresindedir, zaten
       * sürmektedir ya da denemeleri tükenmiştir. Bunu başarı saymak personele
       * "OCR sonucu kaydedildi" dedirtir, oysa hiçbir şey işlenmemiştir; memur
       * metnin neden gelmediğini arar.
       */
      if(payload.processed===false) setNotice(payload.message??"OCR işi bu istekle tetiklenmedi.");
      else setNotice(payload.suggestedRelations
        ? `OCR sonucu kaydedildi; ${payload.suggestedRelations} parsel ilişkisi önerisi kontrol bekliyor.`
        : "OCR sonucu ve alan kanıtları kaydedildi.");
    } catch(reason) {
      failureMessage=reason instanceof Error?reason.message:"OCR işlemi başlatılamadı.";
    }
    /*
     * Başarısız koşu da sunucu durumunu değiştirir: deneme sayacı, iş durumu,
     * son hata ve tekrar deneme zamanı yazılır. Yalnız başarıda yenilemek
     * paneli bayat bırakır — memur eski deneme sayısını ve eski hatayı okur,
     * hiçbir şey olmamış sanır ve yanlış sebebi bildirir.
     *
     * Hata mesajı yenilemeden SONRA yazılır: `load` kendi başlangıcında
     * hatayı temizler ve önce yazılsaydı sessizce silinirdi.
     */
    await load().catch(()=>undefined);
    if(failureMessage){setNotice("");setError(failureMessage);}
    setProcessing(false);
  };

  /** Değer bazlı doğrulama isteği: onayla / düzelt / reddet ve yeni değer ekle. */
  const saveFields=async()=>{
    if(!detail) return;
    const values=detail.fields.flatMap<ValueOperation>(value=>{
      if(rejections[value.id]) {
        if(value.verificationStatus==="REJECTED") return [];
        const draft=rejectionDrafts[value.id];
        return [{id:value.id,action:"reject",reasonCode:draft?.code,reasonNote:draft?.note}];
      }
      const draft=(drafts[value.id]??value.value).trim();
      if(draft&&draft!==value.value) return [{id:value.id,action:"correct",value:draft}];
      if(value.verificationStatus==="SUGGESTED"&&draft!==MISSING_VALUE) return [{id:value.id,action:"confirm"}];
      return [];
    });
    const newValues=additions.filter(addition=>addition.value.trim()).map(addition=>({fieldName:addition.fieldName,value:addition.value.trim()}));
    if(!values.length&&!newValues.length){setError("Kaydedilecek bir doğrulama işlemi bulunmuyor.");return;}
    setSaving(true);setError("");setNotice("");
    try {
      const response=await fetch(`/api/documents/${documentId}/fields`,{
        method:"PATCH",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({values,additions:newValues}),
      });
      const payload=await response.json() as {error?:string;confirmed?:number;corrected?:number;rejected?:number;added?:number;warnings?:Array<{fieldName:string;message:string}>};
      if(!response.ok) throw new Error(payload.error||"Alanlar kaydedilemedi.");
      const parts=[
        payload.confirmed?`${payload.confirmed} onay`:null,
        payload.corrected?`${payload.corrected} düzeltme`:null,
        payload.rejected?`${payload.rejected} reddetme`:null,
        payload.added?`${payload.added} yeni değer`:null,
      ].filter(Boolean).join(", ");
      const warning=payload.warnings?.length?` Biçim uyarısı: ${payload.warnings.map(item=>item.message).join(" ")}`:"";
      setNotice(`${parts||"Değişiklik"} kaydedildi; denetim izi oluşturuldu.${warning}`);
      await load();
    } catch(reason) { setError(reason instanceof Error?reason.message:"Alanlar kaydedilemedi."); }
    finally { setSaving(false); }
  };

  const saveText=async()=>{
    if(!detail) return;
    setSavingText(true);setError("");setNotice("");
    try {
      const response=await fetch(`/api/documents/${documentId}/text`,{
        method:"PATCH",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({pages:detail.pages.map(page=>({pageNumber:page.pageNumber,text:textDrafts[page.pageNumber]??page.confirmedText??page.fullText}))}),
      });
      const payload=await response.json() as {error?:string;action?:string};
      if(!response.ok) throw new Error(payload.error||"Tam metin kaydedilemedi.");
      setNotice(payload.action==="text.corrected"?"Metin düzeltmeleri kaydedildi ve denetim zincirine eklendi.":"Tam metin personel onayıyla kaydedildi.");
      await load();
    } catch(reason) { setError(reason instanceof Error?reason.message:"Tam metin kaydedilemedi."); }
    finally { setSavingText(false); }
  };

  /*
   * §9.5 kararı: arşivleme, tasnif diyaloğundan geçer — dosya planı ve
   * saklama kuralı seçilmeden istek gönderilmez; sunucu da zaten reddeder.
   */
  const [archiveDialog,setArchiveDialog]=useState(false);
  const [filePlanCode,setFilePlanCode]=useState("");
  const [retentionRuleCode,setRetentionRuleCode]=useState("");
  const approve=async()=>{
    setSaving(true);setError("");setNotice("");
    try {
      const response=await fetch(`/api/documents/${documentId}/approve`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({filePlanCode,retentionRuleCode}),
      });
      const payload=await response.json() as {error?:string};
      if(!response.ok) throw new Error(payload.error||"Belge arşivlenemedi.");
      setArchiveDialog(false);
      setNotice("Belge arşivlendi ve özet zincirine yeni denetim olayı eklendi.");
      await load();
    } catch(reason) { setError(reason instanceof Error?reason.message:"Belge arşivlenemedi."); }
    finally { setSaving(false); }
  };

  /*
   * Arama vurgusu (kullanıcı isteği 2026-08-21): sonuç listesinden açılan
   * belgede aranan kelimenin YERİ gösterilir — "belge bulundu" demek 160+
   * sayfalık ciltte yetmez. Eşleşme sunucuyla aynı biçimle hesaplanır
   * (lib/search-highlight.ts); anahtarlı süzgeçler (`ada:32`) zaten hedefli
   * olduğundan yalnız serbest metin vurgulanır.
   */
  const activeSearch=useMemo(()=>parseQuickQuery(searchTerm??"").freeText,[searchTerm]);
  const activeTokens=useMemo(()=>searchTokens(activeSearch),[activeSearch]);
  const matchingPages=useMemo(()=>activeTokens.length
    ?(detail?.pages??[]).filter(page=>matchesAnyToken(page.confirmedText??page.fullText,activeTokens)).map(page=>page.pageNumber)
    :[],[detail,activeTokens]);
  const matchingFieldIds=useMemo(()=>activeTokens.length
    ?new Set((detail?.fields??[]).filter(value=>matchesAnyToken(
      `${value.value} ${value.normalizedValue??""} ${value.evidenceText}`,activeTokens)).map(value=>value.id))
    :new Set<string>(),[detail,activeTokens]);
  const jumpToPage=useCallback((pageNumber:number)=>{
    setPreviewMode("text");
    // Metin sekmesi henüz çizilmemiş olabilir; kaydırma bir sonraki kareye
    // bırakılır. Atlama ANINDA yapılır: 170+ sayfalık ciltte on binlerce
    // piksellik yumuşak kaydırma animasyonu yolculuk değil bekleme olur.
    setTimeout(()=>document.getElementById(`okuma-sayfa-${pageNumber}`)?.scrollIntoView({block:"start"}),90);
  },[]);
  /** Aramadan gelen memur ilk eşleşmeye kendisi tıklamak zorunda kalmaz. */
  const searchJumpKey=`${documentId}:${activeSearch}`;
  const lastSearchJumpRef=useRef<string|null>(null);
  useEffect(()=>{
    if(lastSearchJumpRef.current===searchJumpKey||loading||!matchingPages.length) return;
    lastSearchJumpRef.current=searchJumpKey;
    jumpToPage(matchingPages[0]);
  },[searchJumpKey,loading,matchingPages,jumpToPage]);

  const valuesById=useMemo(()=>new Map((detail?.fields??[]).map(value=>[value.id,value])),[detail]);
  const selected=activeValueId?valuesById.get(activeValueId)??null:null;
  const pageByNumber=useMemo(()=>new Map((detail?.pages??[]).map(page=>[page.pageNumber,page])),[detail]);
  const evidencePage=selected?pageByNumber.get(selected.pageNumber)??null:null;
  const isImage=detail?.document.mediaType.startsWith("image/")??false;
  const needsOcr=detail?.document.status==="queued"||detail?.document.status==="ocr_failed";
  /*
   * Okuma işinin durumu yalnız SÖYLENECEK BİR ŞEY VARKEN gösterilir: hiç
   * denenmemiş bir işin "Deneme 0/3" sayacı memura bilgi değil jargon taşır.
   * Not, önceki deneme başarısız olduğunda ya da iş azami denemeyi
   * tükettiğinde görünür ve eylem cümlesiyle biter.
   */
  const ocrJob=detail?.ocrJob??null;
  const ocrJobTroubled=Boolean(ocrJob&&(ocrJob.deadLettered||ocrJob.attempt>0||ocrJob.errorMessage));
  const ocrJobNote=ocrJob&&ocrJobTroubled?(ocrJob.deadLettered
    ?"Okuma tekrar tekrar başarısız oldu; yetkili, Gelen Evrak'taki Okuma arızaları panelinden yeniden kuyruğa alabilir."
    :`Önceki okuma denemesi başarısız oldu${ocrJob.nextAttemptAt&&ocrJob.status==="queued"
      ?`; sistem ${new Date(ocrJob.nextAttemptAt.replace(" ","T")+"Z").toLocaleString("tr-TR")} itibarıyla kendiliğinden yeniden deneyecek`
      :""}.`):null;
  const canProcess=Boolean(needsOcr&&permissions.includes("ocr.run"));
  const canReview=permissions.includes("document.review");
  const canArchive=permissions.includes("document.archive");
  // Görüntüleme ve indirme ayrı yetkilerdir; ikisi de denetim kaydı üretir.
  const canDownload=permissions.includes("document.download");
  const archived=detail?.document.status==="archived";
  const pendingValues=detail?.fields.filter(value=>value.verificationStatus==="SUGGESTED").length??0;
  const emptyRequired=detail?.fields.filter(value=>(drafts[value.id]??value.value)===MISSING_VALUE&&!rejections[value.id])??[];
  const hasFieldChanges=detail?.fields.some(value=>rejections[value.id]||(drafts[value.id]??value.value)!==value.value)??false;
  const hasAdditions=additions.some(addition=>addition.value.trim());
  const textPending=detail?.pages.some(page=>!page.confirmedText)??false;
  const hasTextChanges=detail?.pages.some(page=>(textDrafts[page.pageNumber]??page.confirmedText??page.fullText)!==(page.confirmedText??page.fullText))??false;
  const pendingRelations=detail?.relations.filter(relation=>relation.verificationStatus==="SUGGESTED").length??0;
  // Reddedilen değer arşive girmez; onun biçimi arşivlemeyi engellemez.
  /*
   * Gerekçesi tamamlanmamış ret, kaydetmeyi durdurur. Sunucu zaten reddeder;
   * burada da tutmak personelin sebebi tıkladıktan sonra değil, tıklamadan
   * önce görmesini sağlar.
   */
  const incompleteRejections=detail?.fields.filter(value=>rejections[value.id]
    &&value.verificationStatus!=="REJECTED"
    &&(!rejectionDrafts[value.id]?.code
      ||(rejectionDrafts[value.id]?.code===OTHER_REASON_CODE&&!rejectionDrafts[value.id]?.note.trim())))??[];
  /*
   * Profilde zorunlu olan bir alan, değeri reddedildiğinde ya da boş
   * bırakıldığında kullanılabilir değer olmadan kalır ve sunucu arşivlemeyi
   * durdurur. Ekran bunu saymazsa buton açık görünür, memur tıklar ve gerekçeyi
   * ancak 409 olarak öğrenir — oysa neyin eksik olduğu baştan bellidir.
   *
   * Sunucunun kuralı birebir izlenir: CONFIRMED ya da CORRECTED, ve değer
   * "Belirlenmedi" olmamalı. Kaydedilmemiş düzenleme zaten ayrı bir engel
   * olduğundan hesap kaydedilmiş durumdan yapılır.
   */
  const usableFieldNames=new Set((detail?.fields??[])
    .filter(value=>["CONFIRMED","CORRECTED"].includes(value.verificationStatus)&&value.value!==MISSING_VALUE)
    .map(value=>value.name));
  const missingRequired=(detail?.fieldGroups??[])
    .filter(group=>group.requirement!=="OPTIONAL"&&!usableFieldNames.has(group.name));
  const malformed=detail?.fields.filter(value=>value.formatViolation
    &&value.verificationStatus!=="REJECTED"&&!rejections[value.id])??[];
  const archiveBlocked=pendingValues>0||hasFieldChanges||hasAdditions||textPending
    ||hasTextChanges||pendingRelations>0||malformed.length>0||missingRequired.length>0;
  /**
   * Devre dışı arşivleme düğmesi neyin eksik olduğunu söyler. Sessizce
   * tıklanamayan bir düğme, kullanıcıya işlemin neden ilerlemediğini
   * anlatmaz; eksikler burada sayılıp başlıkta gösterilir.
   */
  const archiveBlockers=[
    pendingValues>0?`${pendingValues} bilgi kontrol bekliyor`:null,
    pendingRelations>0?`${pendingRelations} parsel/adres bağlantısı karar bekliyor`:null,
    malformed.length?`${malformed.length} bilgi biçim kuralına uymuyor (${[...new Set(malformed.map(value=>value.label))].join(", ")})`:null,
    incompleteRejections.length?`${incompleteRejections.length} ret gerekçesi seçilmedi`:null,
    missingRequired.length?`zorunlu alanda doğrulanmış bilgi yok (${missingRequired.map(group=>group.label).join(", ")})`:null,
    textPending?"belge metni onaylanmadı":null,
    hasFieldChanges||hasAdditions?"kaydedilmemiş alan düzenlemesi var":null,
    hasTextChanges?"kaydedilmemiş metin düzenlemesi var":null,
  ].filter(Boolean) as string[];

  /*
   * design.md §6 "kilit her zaman gerekçeli" + kullanıcı geri bildirimi:
   * memurun ekrana ilk bakışta göreceği şey, işin dört adımlık sırasıdır —
   * neyin bittiği, sıranın nerede olduğu. "Arşivlemeden önce: ..." gerekçe
   * listesi doğruydu ama iş sırası anlatmıyordu; memur alanları bitirip
   * bağlantı ve metin adımlarının varlığını kendisi keşfetmek zorundaydı.
   * Adımlar tıklanınca ilgili yere götürür.
   */
  const fieldsStepDone=pendingValues===0&&!hasFieldChanges&&!hasAdditions
    &&!malformed.length&&!missingRequired.length&&!incompleteRejections.length;
  const relationsStepDone=pendingRelations===0;
  const textStepDone=!textPending&&!hasTextChanges;
  const reviewSteps:[label:string,done:boolean,go:()=>void][]=[
    ["Bilgileri kontrol edin",fieldsStepDone,()=>setActiveTab("fields")],
    ["Bağlantıları karara bağlayın",relationsStepDone,()=>setActiveTab("relations")],
    ["Metni onaylayın",textStepDone,()=>{setActiveTab("fields");setPreviewMode("text");}],
    ["Tasnifleyip arşivleyin",archived,()=>{if(!archiveBlocked&&canArchive){setError("");setArchiveDialog(true);}}],
  ];

  /*
   * design.md ilke 2: makinenin doğru okuduğu alanlar katlanır, öne çıkmaz.
   * Kontrol bekleyen gruplar numaralı görev kartı olur; karara bağlananlar
   * katlanmış özete iner ama DÜZENLENEBİLİR kalır — personel önceden
   * onayladığı bir değeri düzeltebilmelidir.
   */
  const groupPending=(group:FieldGroup)=>group.valueIds.some(valueId=>{
    const value=valuesById.get(valueId);
    return value?.verificationStatus==="SUGGESTED"&&!rejections[valueId];
  });
  const pendingGroups=(detail?.fieldGroups??[]).filter(groupPending);
  const settledGroups=(detail?.fieldGroups??[]).filter(group=>!groupPending(group));
  const orderedGroups=[
    ...pendingGroups.map((group,index)=>({group,pending:true,taskNumber:index+1})),
    ...settledGroups.map(group=>({group,pending:false,taskNumber:0})),
  ];

  /*
   * design.md §3.8: karma değeri personel düzeninde gösterilmez, yerine
   * bütünlük ifadesi durur. İfade körü körüne yazılmaz — zincir bağları
   * burada ölçülür. Kopuk bir zincir sessizce "bozulmamış" diye
   * gösterilirse şerit güvence değil süs olur.
   *
   * Zincirin kanıtladığı şey KAYDIN değişmediğidir; asıl dosyanın
   * bozulmadığı ayrı bir denetimdir (kabul anındaki SHA doğrulaması ve
   * bütünlük mutabakatı işi). İfade bu yüzden kaydı anlatır.
   */
  const auditChain=[...(detail?.audit??[])].sort((a,b)=>a.eventNumber-b.eventNumber);
  const chainBroken=auditChain.some((event,index)=>
    index>0&&event.previousHash!==auditChain[index-1].eventHash);

  const addValue=(fieldName:string)=>setAdditions(current=>[...current,{key:crypto.randomUUID(),fieldName,value:""}]);

  if(loading)return <div className="detail-state"><LoaderCircle className="spin"/><b>Belge kaydı hazırlanıyor…</b></div>;
  if(!detail)return <div className="detail-state error"><AlertTriangle/><b>{error||"Belge bulunamadı."}</b><button className="outline" onClick={onBack}>Listeye dön</button></div>;

  /*
   * Grup çizimi tek yerde durur: bekleyen görev kartları ile katlanmış
   * özet aynı denetimleri gösterir, yalnız yerleşimleri farklıdır.
   * Karara bağlanmış değer düzenlenebilir kalır — personel önceden
   * onayladığı bir değeri düzeltebilmelidir.
   */
  const renderGroup=({group,pending,taskNumber}:{group:FieldGroup;pending:boolean;taskNumber:number})=>{
          const terms=group.vocabularyCode?detail.vocabularies[group.vocabularyCode]??null:null;
          const activeValues=group.valueIds.filter((valueId:string)=>{
            const value=valuesById.get(valueId);
            return value&&!rejections[valueId]&&value.verificationStatus!=="REJECTED";
          }).length;
          const canAdd=canReview&&!archived&&group.extractionPolicy!=="NONE"&&(group.multiValue||activeValues===0);
          return <div className={`field-group ${pending?"task-card":"settled"}`} key={group.name}>
            <div className="field-group-head">
              {pending?<i className="task-medallion">{taskNumber}</i>:null}
              <b>{group.label}</b>
              <span>
                {/* Memura gereken tek işaret alanın zorunlu olduğudur;
                    "kritik" ve "çok değerli" iç politika terimleridir ve
                    ekranda hiç gösterilmez. */}
                {group.required?<em className="tag-required">zorunlu</em>:null}
              </span>
            </div>
            {group.formatHint?<p className="field-hint">{group.formatHint}</p>:null}
            {group.valueIds.map(valueId=>{
              const value=valuesById.get(valueId)!;
              const rejected=Boolean(rejections[valueId])||value.verificationStatus==="REJECTED";
              return <label
                key={valueId}
                className={`${value.verificationStatus==="SUGGESTED"?"needs-review":""} ${activeValueId===valueId?"active":""} ${rejected?"rejected":""} ${matchingFieldIds.has(valueId)?"search-hit":""}`}
                onClick={()=>setActiveValueId(valueId)}
              >
                {/* Aranan kelime bu kayıtlı bilgide geçiyor; memur listede gözle taramaz. */}
                {matchingFieldIds.has(valueId)?<i className="field-hit">aramanızla eşleşiyor</i>:null}
                <span>
                  <b>{group.multiValue?`${group.label} ${value.valueIndex+1}`:group.label}</b>
                  {/* Memur yalnız düz Türkçe eylem cümlesini okur; renk risk
                      sınıfından türer — görsel uyarı kalır, jargon yoktur. */}
                  <em className={`risk-${value.riskLevel.toLowerCase()}`}>{confidencePhrase(value.confidence,value.origin)}</em>
                </span>
                {/* design.md §3.4: iddia kanıtıyla yan yana durur — değerin
                    belgede okunduğu yerin kırpması, girişin hemen üstünde.
                    §9.1 kararı: ayrı görsel üretilmez, görüntüleme türevinden
                    CSS ile anlık kırpılır (lib/evidence-crop.ts). */}
                {(()=>{
                  const page=pageByNumber.get(value.pageNumber);
                  const crop=isImage&&fileSrc&&page&&hasEvidenceBox(value.box)
                    ?evidenceCropStyle(value.box,page.width,page.height):null;
                  return crop?<i className="evidence-crop" role="img"
                    aria-label={`${group.label} kanıtının belge kırpması — sayfa ${value.pageNumber}`}
                    style={{backgroundImage:`url(${fileSrc})`,...crop}}/>:null;
                })()}
                {terms
                  ?<select
                    value={drafts[valueId]??value.value}
                    onChange={event=>setDrafts(current=>({...current,[valueId]:event.target.value}))}
                    onFocus={()=>setActiveValueId(valueId)}
                    disabled={archived||!canReview||rejected}
                  >
                    {/* Kayıtlı değer listede yoksa gösterimden düşmemeli. */}
                    {terms.some(term=>term.label===(drafts[valueId]??value.value))?null
                      :<option value={drafts[valueId]??value.value}>{(drafts[valueId]??value.value)||"— seçilmedi —"}</option>}
                    {terms.map(term=><option key={term.code} value={term.label}>{term.label}</option>)}
                  </select>
                  :<input
                    value={drafts[valueId]??value.value}
                    onChange={event=>setDrafts(current=>({...current,[valueId]:event.target.value}))}
                    onFocus={()=>setActiveValueId(valueId)}
                    disabled={archived||!canReview||rejected}
                  />}
                <small>
                  {valueStatusLabels[value.verificationStatus]} · {value.pageNumber}. sayfada
                  {value.verifiedBy?` · ${value.verifiedBy}`:""}
                </small>
                {canReview&&!archived&&group.multiValue?<div className="value-actions">
                  {rejected
                    ?<button type="button" onClick={event=>{event.preventDefault();setRejections(current=>({...current,[valueId]:false}));setRejectionDrafts(current=>{const next={...current};delete next[valueId];return next;});}} disabled={value.verificationStatus==="REJECTED"}><RotateCcw size={12}/> Geri al</button>
                    :<button type="button" className="value-reject" onClick={event=>{event.preventDefault();setRejections(current=>({...current,[valueId]:true}));setRejectionDrafts(current=>({...current,[valueId]:{code:"",note:""}}));}}><ThumbsDown size={12}/> Bu değeri reddet</button>}
                </div>:null}
                {/* Kaydedilmiş ret gerekçesi kararın yanında durur; personel
                    "Reddedildi" ibaresini sebepsiz okumamalıdır. */}
                {value.rejection?<small className="relation-rejection">
                  <ThumbsDown size={11}/> {value.rejection.label}
                  {value.rejection.note?` — ${value.rejection.note}`:""}
                </small>:null}
                {rejections[valueId]&&value.verificationStatus!=="REJECTED"?<div className="rejection-reason">
                  <select aria-label="Ret gerekçesi" value={rejectionDrafts[valueId]?.code??""}
                    onChange={event=>{const code=event.target.value;setRejectionDrafts(current=>({...current,[valueId]:{code,note:current[valueId]?.note??""}}));}}>
                    <option value="">Ret gerekçesi seçin…</option>
                    {fieldRejectionReasons.map(reason=><option key={reason.code} value={reason.code}>{reason.label}</option>)}
                  </select>
                  <input aria-label="Ret açıklaması" maxLength={300}
                    placeholder={rejectionDrafts[valueId]?.code===OTHER_REASON_CODE?"Açıklama zorunlu":"Açıklama (isteğe bağlı)"}
                    value={rejectionDrafts[valueId]?.note??""}
                    onChange={event=>{const note=event.target.value;setRejectionDrafts(current=>({...current,[valueId]:{code:current[valueId]?.code??"",note}}));}}/>
                </div>:null}
              </label>;
            })}
            {additions.filter(addition=>addition.fieldName===group.name).map(addition=><label className="field-addition" key={addition.key}>
              <span><b>Yeni {group.label}</b><em className="tag-new">personel girişi</em></span>
              {terms
                ?<select value={addition.value} onChange={event=>setAdditions(current=>current.map(item=>item.key===addition.key?{...item,value:event.target.value}:item))}>
                  <option value="">— seçin —</option>
                  {terms.map(term=><option key={term.code} value={term.label}>{term.label}</option>)}
                </select>
                :<input value={addition.value} onChange={event=>setAdditions(current=>current.map(item=>item.key===addition.key?{...item,value:event.target.value}:item))} placeholder={`${group.label} değeri`}/>}
              <div className="value-actions"><button type="button" onClick={event=>{event.preventDefault();setAdditions(current=>current.filter(item=>item.key!==addition.key));}}><Trash2 size={12}/> Kaldır</button></div>
            </label>)}
            {canAdd?<button type="button" className="field-add" onClick={()=>addValue(group.name)}><Plus size={13}/> {group.label} değeri ekle</button>:null}
          </div>;
          };


  return <div className="review">
    <div className="review-head">
      <button onClick={onBack}><ArrowLeft size={15}/> Belge listesi</button>
      <span><span className={`status ${archived||detail.document.status==="ready"?"success":detail.document.status==="processing"?"info":"warning"}`}><i/>{statusLabels[detail.document.status]||detail.document.status}</span><b>{detail.document.referenceNo}</b></span>
      <div>{needsOcr?
        canProcess?<button className="approve" onClick={process} disabled={processing}>{processing?<LoaderCircle className="spin" size={16}/>:<Play size={16}/>} Belgeyi okut</button>:<span className="archived-lock restricted"><LockKeyhole size={15}/> Belgeyi okutma yetkisi gerekli</span>:
        archived?<span className="archived-lock"><LockKeyhole size={15}/> Salt okunur</span>:
        <>{canReview?<button className="outline save-fields" onClick={saveFields} disabled={saving||incompleteRejections.length>0||(!pendingValues&&!hasFieldChanges&&!hasAdditions)} title={incompleteRejections.length?"Reddedilen her değer için gerekçe seçilmelidir.":undefined}>{saving?<LoaderCircle className="spin" size={15}/>:<Save size={15}/>} {pendingValues?"Alanları onayla":"Düzeltmeleri kaydet"}</button>:null}{canArchive?<button className="approve" onClick={()=>{setError("");setArchiveDialog(true);}} disabled={saving||savingText||archiveBlocked} title={archiveBlockers.length?`Arşivlemeden önce tamamlanmalı: ${archiveBlockers.join(", ")}.`:undefined}><CheckCircle2 size={17}/> Doğrula ve arşivle</button>:null}{!canReview&&!canArchive?<span className="archived-lock restricted"><LockKeyhole size={15}/> Görüntüleme yetkisi</span>:null}</>}
      </div>
      {ocrJobNote&&(needsOcr||ocrJob?.status==="failed")
        ?<p className={`ocr-job-note ${ocrJob?.deadLettered?"blocked":""}`}>
          <FileClock size={14}/>
          <span><b>{ocrJobNote}</b>{ocrJob?.errorMessage?<small>Son hata: {ocrJob.errorMessage}</small>:null}</span>
        </p>
        :null}
      {/* Dört adımlık iş sırası: memur neyin bittiğini ve sıranın nerede
          olduğunu ilk bakışta görür; adım tıklanınca ilgili yere götürür.
          Gerekçe listesi kaybolmaz — arşiv adımının ipucunda durur. */}
      {canReview&&!archived&&!needsOcr?<ol className="review-steps" aria-label="Doğrulama adımları">
        {reviewSteps.map(([label,done,go],index)=>{
          const current=!done&&reviewSteps.slice(0,index).every(([,previousDone])=>previousDone);
          return <li key={label}>
            <button type="button" className={done?"done":current?"current":""}
              onClick={go}
              title={index===3&&archiveBlockers.length?`Önce tamamlanmalı: ${archiveBlockers.join(", ")}.`:undefined}>
              <i>{done?<CheckCircle2 size={14}/>:index+1}</i> {label}
            </button>
          </li>;
        })}
      </ol>:null}
    </div>
    {error?<div className="inline-error"><AlertTriangle size={16}/>{error}</div>:null}
    {notice?<div className="inline-notice"><CheckCircle2 size={16}/>{notice}</div>:null}
    {/* §9.5 kararı: tasnif arşivleme ANINDA ve ZORUNLU istenir. Arşiv kaydı
        WORM'a girdikten sonra tasniflenemez; diyalog son kapıdır. */}
    {archiveDialog?<div className="archive-dialog-backdrop" role="dialog" aria-label="Arşivleme tasnifi">
      <div className="archive-dialog">
        <header><LockKeyhole size={16}/><span><b>Arşivleme tasnifi</b>
          <small>{detail.document.referenceNo} · arşivlendikten sonra kayıt salt okunur olur</small></span></header>
        <label>Dosya planı
          <select value={filePlanCode} onChange={event=>setFilePlanCode(event.target.value)}>
            <option value="">— dosya planı seçin —</option>
            {filePlanTerms.map(term=><option key={term.code} value={term.code}>{term.label}</option>)}
          </select>
        </label>
        <label>Saklama kuralı
          <select value={retentionRuleCode} onChange={event=>setRetentionRuleCode(event.target.value)}>
            <option value="">— saklama kuralı seçin —</option>
            {retentionRuleTerms.map(term=><option key={term.code} value={term.code}>{term.label}</option>)}
          </select>
        </label>
        <p>Saklama süresinin dolması otomatik imha değildir; tasfiye ayrı ve kurullu bir süreçtir.</p>
        <footer>
          <button type="button" onClick={()=>setArchiveDialog(false)} disabled={saving}>Vazgeç</button>
          <button type="button" className="approve" onClick={approve}
            disabled={saving||!filePlanCode||!retentionRuleCode}
            title={!filePlanCode||!retentionRuleCode?"Dosya planı ve saklama kuralı seçilmelidir.":undefined}>
            {saving?<LoaderCircle className="spin" size={15}/>:<CheckCircle2 size={15}/>} Tasnifle ve arşivle
          </button>
        </footer>
      </div>
    </div>:null}
    {/* design.md §3.2 sekme şeridi: doğrulama, ilişkiler ve denetim izi ayrılır. */}
    <nav className="review-tabs" aria-label="Belge bölümleri">
      {([["fields","Belge ve alanlar",pendingValues],
         ["relations","İlişkiler ve geçmiş",detail.relations.length],
         ["audit","İşlem kayıtları",detail.audit.length]] as const).map(([key,label,count])=>
        <button key={key} type="button" className={activeTab===key?"active":""}
          aria-current={activeTab===key?"page":undefined}
          onClick={()=>setActiveTab(key)}>
          {label}{count?<b>{count}</b>:null}
        </button>)}
    </nav>
    {/* Tek ve sade düzen: solda belge, sağda kararlar. Sahte sayfa şeridi ve
        uzman kipleri kaldırıldı (2026-08-20 kullanıcı kararı) — ekranda ne
        varsa gerçektir ve herkes için aynıdır. */}
    <div className="review-grid">
      <section className="document">
        {/* Aramadan gelindiyse ekran ilk sorusu sorulmadan cevabı gösterir:
            kelime nerede geçiyor. Çipler sayfaya atlar; alan eşleşmeleri
            sağdaki kartlarda ayrıca işaretlidir. */}
        {activeTokens.length&&(matchingPages.length||matchingFieldIds.size)?<div className="search-hitbar" role="status">
          <span>Aradığınız <b>&quot;{activeSearch}&quot;</b> bu belgede {matchingPages.length?`${matchingPages.length} sayfada`:""}
            {matchingPages.length&&matchingFieldIds.size?" ve ":""}
            {matchingFieldIds.size?`${matchingFieldIds.size} kayıtlı bilgide`:""} geçiyor.</span>
          {matchingPages.slice(0,10).map(pageNumber=><button key={pageNumber} type="button" onClick={()=>jumpToPage(pageNumber)}>Sayfa {pageNumber}</button>)}
          {matchingPages.length>10?<em>+{matchingPages.length-10} sayfa daha</em>:null}
        </div>:null}
        <div className="document-tools"><span>{detail.document.originalName}</span>{canDownload?<button className="download-original" onClick={()=>{void downloadOriginal()}} type="button"><Download size={14}/> Aslını indir</button>:null}<div className="preview-switch"><button className={previewMode==="image"?"active":""} onClick={()=>setPreviewMode("image")} aria-label="Belge görüntüsü"><ImageIcon size={15}/> Görüntü</button><button className={previewMode==="text"?"active":""} onClick={()=>setPreviewMode("text")} disabled={!detail.pages.length} aria-label="Okunabilir OCR metni"><FileText size={15}/> Okunabilir metin</button></div></div>
        {/* Aslı gösterilirken bunun söylenmesi dürüstlük gereğidir: memur
            "görüntüleme kopyası" ile "asıl" arasındaki farkı bilmek zorunda
            değildir ama ekran ne gösterdiğini gizlememelidir. */}
        {showingOriginal&&previewMode==="image"?<p className="original-note" role="status">
          <ShieldCheck size={13}/> Güvenli görüntüleme kopyası hazırlanıyor; bu sırada belgenin aslını görüyorsunuz.</p>:null}
        <div className="real-preview">{previewMode==="text"?<article className="ocr-transcript"><header><div><span><FileText size={17}/><b>Onaylı ve aranabilir belge metni</b><em className={textPending?"pending":"verified"}>{textPending?"Kontrol bekliyor":"Personel onaylı"}</em></span><small>Otomatik metni asıl belgeyle karşılaştırın. Kaydedilen her düzeltme sürüm ve SHA-256 denetim iziyle korunur.</small></div>{canReview&&!archived?<button className="text-confirm" onClick={saveText} disabled={savingText||(!textPending&&!hasTextChanges)}>{savingText?<LoaderCircle className="spin" size={15}/>:<ShieldCheck size={15}/>} {hasTextChanges?"Düzeltmeleri kaydet":"Metni onayla"}</button>:null}</header>{detail.pages.map(page=><section key={page.pageNumber} id={`okuma-sayfa-${page.pageNumber}`} className={activeTokens.length&&matchingPages.includes(page.pageNumber)?"search-match":undefined}><h3><span>Sayfa {page.pageNumber}{activeTokens.length&&matchingPages.includes(page.pageNumber)?<em className="page-hit">aramanızla eşleşiyor</em>:null}</span>{page.confirmedBy
                  ?<small>{page.confirmedBy} · {page.confirmedAt?new Date(page.confirmedAt).toLocaleString("tr-TR"):"Onaylandı"}{page.confirmedText!==null&&page.confirmedText!==page.fullText?" · personel düzeltmesi":" · olduğu gibi onaylandı"}</small>
                  :<small>Henüz personel onayı yok</small>}</h3>
                {/* Arşivlenen metin, insanların arayıp alıntılayacağı metindir.
                    Personelin değiştirdiği bir sayfa, yalnızca kontrol edilmiş
                    sayfadan maddi olarak farklıdır; ikisi aynı görünmemelidir.
                    Makinenin ne okuduğu da erişilebilir kalmalıdır. */}
                {page.confirmedText!==null&&page.confirmedText!==page.fullText
                  ?<details className="ocr-original"><summary>OCR&apos;ın okuduğu özgün metni göster</summary><p>{page.fullText||"OCR bu sayfada metin üretmedi."}</p></details>
                  :null}{(()=>{
                  /* Vurgu, düzenlenebilir alanda kutunun İÇİNE çizilemez
                     (textarea içinde işaretleme yoktur); eşleşen cümleler
                     kutunun üstünde kırpıntı olarak gösterilir. Salt-okunur
                     metinde vurgu satır içindedir. */
                  const display=textDrafts[page.pageNumber]??page.confirmedText??page.fullText;
                  const ranges=activeTokens.length&&matchingPages.includes(page.pageNumber)
                    ?findHighlightRanges(display,activeTokens):[];
                  const snippets=canReview&&!archived&&ranges.length?matchSnippets(display,ranges):[];
                  return <>
                    {snippets.length?<div className="match-snippets" aria-label="Aramanızla eşleşen satırlar">
                      {snippets.map((snippet,index)=><p key={index}>{snippet.leading?"… ":""}{renderMarks(snippet.text,snippet.ranges)}{snippet.trailing?" …":""}</p>)}
                    </div>:null}
                    {canReview&&!archived
                      ?<textarea value={display} onChange={event=>setTextDrafts(current=>({...current,[page.pageNumber]:event.target.value}))} aria-label={`Sayfa ${page.pageNumber} onaylı metni`}/>
                      :<p>{display?renderMarks(display,ranges):"Bu sayfada okunabilir metin bulunamadı."}</p>}
                  </>;
                })()}</section>)}</article>:!fileSrc?
          /*
           * Görüntü henüz yokken boş bir çerçeve göstermek memura "bozuk"
           * der. Kart, sürecin işlediğini söyler ve kopya hazır olunca ekran
           * kendiliğinden açar (previewRetry). Okunmuş belgede bu arada
           * metne geçiş önerilir; gerçek hatalar (yetki, kayıp nesne) ise
           * yeniden denenmez, açıkça gösterilir.
           */
          <div className="preview-pending" role="status" aria-live="polite">
            {previewError&&!previewError.includes("hazırlanıyor")
              ?<><AlertTriangle size={26}/><b>Belge görüntüsü açılamadı</b><p>{previewError}</p></>
              :<><LoaderCircle className="spin" size={26}/><b>Belge görüntüsü hazırlanıyor</b>
                <p>Güvenli görüntüleme kopyası üretiliyor; hazır olduğunda burada kendiliğinden açılacak. Beklemenize gerek yok — diğer işlerinize dönebilirsiniz.</p></>}
            {/* Görüntü beklerken belgeye bakmanın iki gerçek yolu: okunan
                metin ve (yetkiliyse) aslın kendisi. Kart çıkmaz sokak olmasın. */}
            <div className="preview-pending-actions">
              {detail.pages.length?<button type="button" className="outline" onClick={()=>setPreviewMode("text")}>
                <FileText size={14}/> Bu sırada okunabilir metne bakın</button>:null}
              {canDownload?<button type="button" className="outline" onClick={()=>{void downloadOriginal()}}>
                <Download size={14}/> Aslını indirip bilgisayarınızda açın</button>:null}
            </div>
          </div>
        :isImage?<div className="image-evidence"><img src={fileSrc} alt={`${detail.document.referenceNo} belge görüntüsü`}/>{selected&&evidencePage&&hasEvidenceBox(selected.box)?<span className="evidence-box" style={{left:`${selected.box[0]/evidencePage.width*100}%`,top:`${selected.box[1]/evidencePage.height*100}%`,width:`${(selected.box[2]-selected.box[0])/evidencePage.width*100}%`,height:`${(selected.box[3]-selected.box[1])/evidencePage.height*100}%`}}>{/* design.md §3.3: bitişik altın ad etiketi — yalnız alan adı, yüzde yok. */}<b>{selected.label}</b></span>:null}</div>:<object data={fileSrc} type="application/pdf" aria-label={`${detail.document.referenceNo} ${showingOriginal?"belge aslı":"güvenli görüntüleme kopyası"}`}><p>Belge görüntüsü bu tarayıcıda gösterilemiyor.</p></object>}</div>
        {/* §9.2 kararı: toplu karar paneli belge alanının üzerine kayar —
            geniş yer, bağlamdan kopmadan. Kapanınca belge yine görünür. */}
        {bulkOpen&&canReview&&!archived?<RelationBulkPanel
          documentId={documentId}
          suggestions={detail.relations.filter(relation=>relation.verificationStatus==="SUGGESTED")}
          rejectionReasons={relationRejectionReasons}
          fileSrc={isImage?fileSrc||null:null}
          pageDims={pageNumber=>{const page=pageByNumber.get(pageNumber);return page?{width:page.width,height:page.height}:null;}}
          onChanged={relations=>setDetail(current=>current?{...current,relations}:current)}
          onError={setError}
          onNotice={setNotice}
          onClose={()=>setBulkOpen(false)}
        />:null}
      </section>
      <aside className="fields">
        <header><Sparkles size={18}/><span><b>Belgeden okunan bilgiler</b><small>{detail.fields.length?`${detail.fields.length} bilgi · ${detail.fieldGroups.length} alan`:"Belge henüz okunmadı"}</small></span></header>
        {activeTab==="fields"?<div className="profile-strip">
          <FileCog size={15}/>
          <span>
            <b>{detail.profile.name}</b>
            {/* Profil kodu, sürümü ve yaşam döngüsü iç terimlerdir; memura
                belge türünün adı yeter (kullanıcı kararı 2026-08-20). */}
            <small>Bu belge türünde beklenen alanlar aşağıda listelendi</small>
            {/* §9.5: arşivlenmiş belgenin tasnifi karar anının anlık görüntüsüdür. */}
            {detail.document.filePlan?<small className="classification-line">
              {detail.document.filePlan.label} · {detail.document.retentionRule?.label??""}</small>:null}
          </span>
        </div>:null}
        {detail.fields.length?<>
          {activeTab==="fields"?<div className={`quality ${pendingValues?"":"quality-good"}`}><Gauge size={17}/><span><b>{archived?"Personel tarafından arşivlendi":pendingValues?`${pendingValues} bilgi kontrolünüzü bekliyor`:"Bütün bilgiler karara bağlandı"}</b>{/* §6: saklama tekniği değil yapılacak iş anlatılır. */}<small>{archived?"Kayıt salt okunur; düzeltme yeni sürüm açar.":"Her bilgiyi belgedeki yazıyla karşılaştırın; yanlışsa üzerine doğrusunu yazın."}</small></span></div>:null}
          {activeTab==="fields"&&emptyRequired.length?<div className="empty-required"><AlertTriangle size={15}/><span>{emptyRequired.map(value=>value.label).join(", ")} belgede okunamadı; belgeden bakıp elle girin.</span></div>:null}

          {activeTab==="fields"?<>
          {/* design.md §4.1: kolon tek bir soru sorar — "şimdi ne yapmam gerekiyor". */}
          {pendingGroups.length?<p className="task-heading">{pendingValues} bilgi onayınızı bekliyor</p>:null}
          <div className="evidence-fields">{orderedGroups.filter(entry=>entry.pending).map(renderGroup)}</div>

          {/* design.md §3.5: doğru okunan alanlar katlanır, öne çıkmaz. */}
          {settledGroups.length?<details className="read-summary">
            <summary><CheckCircle2 size={14}/> Doğru okunan {settledGroups.length} alan</summary>
            <div className="evidence-fields">{orderedGroups.filter(entry=>!entry.pending).map(renderGroup)}</div>
          </details>:null}
          </>:null}

          {activeTab==="fields"&&selected?<div className="evidence-detail"><b>Kanıt metni</b><p>{selected.evidenceText}</p><span><ScanLine size={14}/>Sayfa {selected.pageNumber}</span></div>:null}

          {activeTab==="relations"?<EntityRelations
            documentId={documentId}
            relations={detail.relations}
            rejectionReasons={relationRejectionReasons}
            canReview={canReview}
            archived={archived}
            onOpenBulk={()=>setBulkOpen(true)}
            onChanged={relations=>setDetail(current=>current?{...current,relations}:current)}
            onError={setError}
            onNotice={setNotice}
          />:null}

          {activeTab==="relations"?<section className="objects"><header><ShieldCheck size={15}/><span><b>Nesne kayıtları</b><small>Asıl dosya ve türevler</small></span></header>{detail.objects.map(object=><article key={object.id}><b>{object.objectClass}</b><small>{Math.max(1,Math.round(object.byteSize/1024))} KB</small><small>{object.generator??"—"} · {object.legalHoldStatus==="HELD"?"Yasal bekletme":object.retentionStatus}</small></article>)}</section>:null}

          {activeTab==="audit"?<section className="audit-trail"><header><History size={15}/><span><b>Değiştirilemez işlem kaydı</b><small>Her işlem eklendiği anda kilitlenir</small></span><ShieldCheck size={15}/></header>{detail.audit.length?detail.audit.map(event=><article key={event.eventNumber}><i/><span><b>{auditLabels[event.action]||event.action}</b><small>{event.actor} · {new Date(event.createdAt).toLocaleString("tr-TR")}</small></span></article>):<p>Henüz personel işlemi kaydedilmedi.</p>}
            {auditChain.length>1?<p className={`chain-state ${chainBroken?"broken":"intact"}`}>
              {chainBroken
                ?<><AlertTriangle size={14}/> İşlem kaydı zinciri kopuk; işletim ekibine bildirin.</>
                :<><ShieldCheck size={14}/> İşlem kaydı zinciri kopuksuz — kayıtlar eklendiği günden beri değişmedi.</>}
            </p>:null}
          </section>:null}
        </>:processing
          /*
           * design.md §5 "Yükleniyor / OCR sürüyor": çıkarım sürerken ekran
           * BEKLİYOR demez, OKUYOR der. Metin çıkarımı isteğin içinde koşar ve
           * belgeye göre bir dakikayı bulabilir; o süre boyunca "servis
           * çalıştığında görünecek" cümlesi ekranda kalırsa memur işin hiç
           * başlamadığını sanır ve haklı olarak "takıldı" der.
           */
          ?<div className="empty-ocr reading" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={26}/>
            <b>Belge okunuyor</b>
            <p>Yazılar çıkarılıyor, alan kanıtları ve görüntüleme kopyası hazırlanıyor.
              Belgenin yoğunluğuna göre bu işlem bir dakikayı bulabilir; ekranı açık bırakmanız yeterli.</p>
            <div className="ocr-skeletons" aria-hidden="true"><i/><i/><i/><i/></div>
          </div>
          :<div className="empty-ocr"><FileClock size={28}/><b>Belge henüz okunmadı</b><p>Asıl dosya güvenli kasada. Belge okunduğunda yazılar ve alan bilgileri burada görünecek.</p>{canProcess?<button className="primary" onClick={process}><Play size={16}/> Belgeyi okut</button>:null}</div>}
      </aside>
    </div>
  </div>;
}
