"use client";

/* eslint-disable @next/next/no-img-element -- Özel R2 dosya rotası Next Image iyileştirmesine uygun değildir. */

import { AlertTriangle, ArrowLeft, CheckCircle2, FileClock, FileCog, FileText, Gauge, History, Image as ImageIcon, LoaderCircle, LockKeyhole, Play, Plus, RotateCcw, Save, ScanLine, ShieldCheck, Sparkles, ThumbsDown, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EntityRelation, EntityRelations } from "./entity-relations";

const MISSING_VALUE = "Belirlenmedi";

type VerificationStatus = "SUGGESTED" | "CONFIRMED" | "CORRECTED" | "REJECTED";

type DetailValue = {
  id:string; name:string; label:string; valueIndex:number; value:string; originalValue:string;
  normalizedValue:string|null; confidence:number; riskLevel:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL";
  verificationStatus:VerificationStatus; origin:"OCR"|"HUMAN"; pageNumber:number;
  box:[number,number,number,number]; evidenceText:string; model:string;
  verifiedBy:string|null; verifiedAt:string|null; corrected:boolean; correctedBy:string|null; correctedAt:string|null;
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
type DetailDocument = { id:string; referenceNo:string; originalName:string; mediaType:string; byteSize:number; sha256:string; documentType:string; unit:string; status:string; uploadedBy:string; createdAt:string; updatedAt:string; fileUrl:string };
type BinaryObject = { id:string; objectClass:string; objectKey:string; mediaType:string; byteSize:number; sha256:string; retentionStatus:string; legalHoldStatus:string; generator:string|null; createdAt:string };
type AuditEvent = { eventNumber:number; actor:string; action:string; details:unknown; previousHash:string|null; eventHash:string; createdAt:string };
type DetailPayload = { document:DetailDocument; profile:ProfileInfo; vocabularies:VocabularyMap; pages:DetailPage[]; fields:DetailValue[]; fieldGroups:FieldGroup[]; relations:EntityRelation[]; objects:BinaryObject[]; audit:AuditEvent[] };

type Addition = { key:string; fieldName:string; value:string };
type ValueOperation = { id:string; action:"confirm"|"correct"|"reject"; value?:string };

const statusLabels: Record<string,string> = { queued:"OCR kuyruğunda", processing:"OCR işleniyor", review:"Doğrulama bekliyor", ready:"Doğrulamaya hazır", archived:"Arşivlendi", ocr_failed:"OCR hatası" };
const auditLabels: Record<string,string> = {
  "document.received":"Belge kabul edildi", "ocr.completed":"OCR tamamlandı", "fields.confirmed":"Alanlar doğrulandı",
  "text.confirmed":"Tam metin onaylandı", "text.corrected":"Tam metin düzeltildi",
  "relation.verified":"Varlık ilişkisi doğrulandı", "relation.rejected":"Varlık ilişkisi reddedildi",
  "document.archived":"Belge arşivlendi",
};
const riskLabels: Record<string,string> = { LOW:"Düşük risk", MEDIUM:"Orta risk", HIGH:"Yüksek risk", CRITICAL:"Kritik" };
const profileStatusLabels: Record<string,string> = {
  HYPOTHESIS:"Hipotez", DISCOVERED:"Gözlendi", VALIDATED:"Doğrulandı",
  PILOT:"Pilot", ACTIVE:"Yürürlükte", RETIRED:"Kapatıldı",
};
const valueStatusLabels: Record<VerificationStatus,string> = { SUGGESTED:"Öneri", CONFIRMED:"Onaylı", CORRECTED:"Düzeltildi", REJECTED:"Reddedildi" };

export function DocumentReview({ documentId, onBack, permissions }: { documentId:string; onBack:()=>void; permissions:string[] }) {
  const [detail,setDetail]=useState<DetailPayload|null>(null);
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [rejections,setRejections]=useState<Record<string,boolean>>({});
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

  const load=useCallback(async()=>{
    setLoading(true);
    setError("");
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
    try {
      const response=await fetch(`/api/jobs/process?documentId=${encodeURIComponent(documentId)}`,{method:"POST"});
      const payload=await response.json() as {error?:string;suggestedRelations?:number};
      if(!response.ok) throw new Error(payload.error||"OCR işlemi başlatılamadı.");
      setNotice(payload.suggestedRelations
        ? `OCR sonucu kaydedildi; ${payload.suggestedRelations} parsel ilişkisi önerisi kontrol bekliyor.`
        : "OCR sonucu ve alan kanıtları kaydedildi.");
      await load();
    } catch(reason) { setError(reason instanceof Error?reason.message:"OCR işlemi başlatılamadı."); }
    finally { setProcessing(false); }
  };

  /** Değer bazlı doğrulama isteği: onayla / düzelt / reddet ve yeni değer ekle. */
  const saveFields=async()=>{
    if(!detail) return;
    const values=detail.fields.flatMap<ValueOperation>(value=>{
      if(rejections[value.id]) return value.verificationStatus==="REJECTED"?[]:[{id:value.id,action:"reject"}];
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

  const approve=async()=>{
    setSaving(true);setError("");setNotice("");
    try {
      const response=await fetch(`/api/documents/${documentId}/approve`,{method:"POST"});
      const payload=await response.json() as {error?:string};
      if(!response.ok) throw new Error(payload.error||"Belge arşivlenemedi.");
      setNotice("Belge arşivlendi ve özet zincirine yeni denetim olayı eklendi.");
      await load();
    } catch(reason) { setError(reason instanceof Error?reason.message:"Belge arşivlenemedi."); }
    finally { setSaving(false); }
  };

  const valuesById=useMemo(()=>new Map((detail?.fields??[]).map(value=>[value.id,value])),[detail]);
  const selected=activeValueId?valuesById.get(activeValueId)??null:null;
  const pageByNumber=useMemo(()=>new Map((detail?.pages??[]).map(page=>[page.pageNumber,page])),[detail]);
  const evidencePage=selected?pageByNumber.get(selected.pageNumber)??null:null;
  const isImage=detail?.document.mediaType.startsWith("image/")??false;
  const needsOcr=detail?.document.status==="queued"||detail?.document.status==="ocr_failed";
  const canProcess=Boolean(needsOcr&&permissions.includes("ocr.run"));
  const canReview=permissions.includes("document.review");
  const canArchive=permissions.includes("document.archive");
  const archived=detail?.document.status==="archived";
  const pendingValues=detail?.fields.filter(value=>value.verificationStatus==="SUGGESTED").length??0;
  const emptyRequired=detail?.fields.filter(value=>(drafts[value.id]??value.value)===MISSING_VALUE&&!rejections[value.id])??[];
  const hasFieldChanges=detail?.fields.some(value=>rejections[value.id]||(drafts[value.id]??value.value)!==value.value)??false;
  const hasAdditions=additions.some(addition=>addition.value.trim());
  const textPending=detail?.pages.some(page=>!page.confirmedText)??false;
  const hasTextChanges=detail?.pages.some(page=>(textDrafts[page.pageNumber]??page.confirmedText??page.fullText)!==(page.confirmedText??page.fullText))??false;
  const pendingRelations=detail?.relations.filter(relation=>relation.verificationStatus==="SUGGESTED").length??0;
  const archiveBlocked=pendingValues>0||hasFieldChanges||hasAdditions||textPending||hasTextChanges||pendingRelations>0;

  const addValue=(fieldName:string)=>setAdditions(current=>[...current,{key:crypto.randomUUID(),fieldName,value:""}]);

  if(loading)return <div className="detail-state"><LoaderCircle className="spin"/><b>Belge kaydı hazırlanıyor…</b></div>;
  if(!detail)return <div className="detail-state error"><AlertTriangle/><b>{error||"Belge bulunamadı."}</b><button className="outline" onClick={onBack}>Listeye dön</button></div>;

  return <div className="review">
    <div className="review-head">
      <button onClick={onBack}><ArrowLeft size={15}/> Belge listesi</button>
      <span><span className={`status ${archived||detail.document.status==="ready"?"success":detail.document.status==="processing"?"info":"warning"}`}><i/>{statusLabels[detail.document.status]||detail.document.status}</span><b>{detail.document.referenceNo}</b></span>
      <div>{needsOcr?
        canProcess?<button className="approve" onClick={process} disabled={processing}>{processing?<LoaderCircle className="spin" size={16}/>:<Play size={16}/>} OCR işlemini çalıştır</button>:<span className="archived-lock restricted"><LockKeyhole size={15}/> OCR yetkisi gerekli</span>:
        archived?<span className="archived-lock"><LockKeyhole size={15}/> Salt okunur</span>:
        <>{canReview?<button className="outline save-fields" onClick={saveFields} disabled={saving||(!pendingValues&&!hasFieldChanges&&!hasAdditions)}>{saving?<LoaderCircle className="spin" size={15}/>:<Save size={15}/>} {pendingValues?"Alanları onayla":"Düzeltmeleri kaydet"}</button>:null}{canArchive?<button className="approve" onClick={approve} disabled={saving||savingText||archiveBlocked}><CheckCircle2 size={17}/> Doğrula ve arşivle</button>:null}{!canReview&&!canArchive?<span className="archived-lock restricted"><LockKeyhole size={15}/> Görüntüleme yetkisi</span>:null}</>}
      </div>
    </div>
    {error?<div className="inline-error"><AlertTriangle size={16}/>{error}</div>:null}
    {notice?<div className="inline-notice"><CheckCircle2 size={16}/>{notice}</div>:null}
    <div className="review-grid">
      <aside className="thumbs">{(detail.pages.length?detail.pages:[{pageNumber:1}]).map((page,index)=><button className={index===0?"active":""} key={page.pageNumber}><span>{page.pageNumber}</span><i/></button>)}</aside>
      <section className="document">
        <div className="document-tools"><span>{detail.document.originalName}</span><div className="preview-switch"><button className={previewMode==="image"?"active":""} onClick={()=>setPreviewMode("image")} aria-label="Belge görüntüsü"><ImageIcon size={15}/> Görüntü</button><button className={previewMode==="text"?"active":""} onClick={()=>setPreviewMode("text")} disabled={!detail.pages.length} aria-label="Okunabilir OCR metni"><FileText size={15}/> Okunabilir metin</button></div></div>
        <div className="real-preview">{previewMode==="text"?<article className="ocr-transcript"><header><div><span><FileText size={17}/><b>Onaylı ve aranabilir belge metni</b><em className={textPending?"pending":"verified"}>{textPending?"Kontrol bekliyor":"Personel onaylı"}</em></span><small>Otomatik metni asıl belgeyle karşılaştırın. Kaydedilen her düzeltme sürüm ve SHA-256 denetim iziyle korunur.</small></div>{canReview&&!archived?<button className="text-confirm" onClick={saveText} disabled={savingText||(!textPending&&!hasTextChanges)}>{savingText?<LoaderCircle className="spin" size={15}/>:<ShieldCheck size={15}/>} {hasTextChanges?"Düzeltmeleri kaydet":"Metni onayla"}</button>:null}</header>{detail.pages.map(page=><section key={page.pageNumber}><h3><span>Sayfa {page.pageNumber}</span>{page.confirmedBy?<small>{page.confirmedBy} · {page.confirmedAt?new Date(page.confirmedAt).toLocaleString("tr-TR"):"Onaylandı"}</small>:<small>Henüz personel onayı yok</small>}</h3>{canReview&&!archived?<textarea value={textDrafts[page.pageNumber]??page.confirmedText??page.fullText} onChange={event=>setTextDrafts(current=>({...current,[page.pageNumber]:event.target.value}))} aria-label={`Sayfa ${page.pageNumber} onaylı metni`}/>:<p>{(page.confirmedText??page.fullText)||"Bu sayfada okunabilir metin bulunamadı."}</p>}</section>)}</article>:isImage?<div className="image-evidence"><img src={detail.document.fileUrl} alt={`${detail.document.referenceNo} asıl belge`}/>{selected&&evidencePage&&selected.box.some(value=>value>0)?<span className="evidence-box" style={{left:`${selected.box[0]/evidencePage.width*100}%`,top:`${selected.box[1]/evidencePage.height*100}%`,width:`${(selected.box[2]-selected.box[0])/evidencePage.width*100}%`,height:`${(selected.box[3]-selected.box[1])/evidencePage.height*100}%`}}/>:null}</div>:<object data={detail.document.fileUrl} type={detail.document.mediaType} aria-label={`${detail.document.referenceNo} asıl belge`}><a href={detail.document.fileUrl}>Asıl dosyayı aç</a></object>}</div>
      </section>
      <aside className="fields">
        <header><Sparkles size={18}/><span><b>OCR alan kanıtları</b><small>{detail.fields.length?`${detail.fields.length} değer · ${detail.fieldGroups.length} alan`:"Henüz OCR sonucu yok"}</small></span><em>{detail.pages[0]?.model||"PaddleOCR"}</em></header>
        <div className="profile-strip">
          <FileCog size={15}/>
          <span>
            <b>{detail.profile.name}</b>
            <small>
              Profil {detail.profile.code} · sürüm {detail.profile.version}
              {detail.profile.recordedVersion&&detail.profile.recordedVersion!==detail.profile.version?` (kayıt: ${detail.profile.recordedVersion})`:""}
              {" · "}{detail.profile.ownerDepartment}
            </small>
          </span>
          <em className={`profile-status ${detail.profile.status.toLowerCase()}`}>{profileStatusLabels[detail.profile.status]??detail.profile.status}</em>
        </div>
        {detail.fields.length?<>
          <div className={`quality ${pendingValues?"":"quality-good"}`}><Gauge size={17}/><span><b>{archived?"Personel tarafından arşivlendi":pendingValues?`${pendingValues} değer personel kontrolü bekliyor`:"Bütün değerler personel tarafından karara bağlandı"}</b><small>Güven, risk seviyesi, kanıt konumu ve doğrulayan birlikte saklanır.</small></span></div>
          {emptyRequired.length?<div className="empty-required"><AlertTriangle size={15}/><span>{emptyRequired.map(value=>value.label).join(", ")} OCR tarafından bulunamadı; onaylamak için değeri girin.</span></div>:null}

          <div className="evidence-fields">{detail.fieldGroups.map(group=>{
          const terms=group.vocabularyCode?detail.vocabularies[group.vocabularyCode]??null:null;
          const activeValues=group.valueIds.filter(valueId=>{
            const value=valuesById.get(valueId);
            return value&&!rejections[valueId]&&value.verificationStatus!=="REJECTED";
          }).length;
          const canAdd=canReview&&!archived&&group.extractionPolicy!=="NONE"&&(group.multiValue||activeValues===0);
          return <div className="field-group" key={group.name}>
            <div className="field-group-head">
              <b>{group.label}</b>
              <span>
                {group.critical?<em className="tag-critical">kritik</em>:null}
                {group.required?<em className="tag-required">zorunlu</em>:null}
                {group.multiValue?<em className="tag-multi">çok değerli</em>:null}
              </span>
            </div>
            {group.formatHint?<p className="field-hint">{group.formatHint}</p>:null}
            {group.valueIds.map(valueId=>{
              const value=valuesById.get(valueId)!;
              const rejected=Boolean(rejections[valueId])||value.verificationStatus==="REJECTED";
              return <label
                key={valueId}
                className={`${value.verificationStatus==="SUGGESTED"?"needs-review":""} ${activeValueId===valueId?"active":""} ${rejected?"rejected":""}`}
                onClick={()=>setActiveValueId(valueId)}
              >
                <span>
                  <b>{group.multiValue?`${group.label} ${value.valueIndex+1}`:group.label}</b>
                  <em className={`risk-${value.riskLevel.toLowerCase()}`}>{riskLabels[value.riskLevel]}{value.origin==="OCR"?` · %${Math.round(value.confidence*100)}`:" · personel"}</em>
                </span>
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
                  {valueStatusLabels[value.verificationStatus]} · Sayfa {value.pageNumber}
                  {value.box.some(coordinate=>coordinate>0)?` · [${value.box.map(coordinate=>Math.round(coordinate)).join(", ")}]`:""}
                  {value.verifiedBy?` · ${value.verifiedBy}`:""}
                </small>
                {canReview&&!archived&&group.multiValue?<div className="value-actions">
                  {rejected
                    ?<button type="button" onClick={event=>{event.preventDefault();setRejections(current=>({...current,[valueId]:false}));}} disabled={value.verificationStatus==="REJECTED"}><RotateCcw size={12}/> Geri al</button>
                    :<button type="button" className="value-reject" onClick={event=>{event.preventDefault();setRejections(current=>({...current,[valueId]:true}));}}><ThumbsDown size={12}/> Bu değeri reddet</button>}
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
          })}</div>

          {selected?<div className="evidence-detail"><b>Kanıt metni</b><p>{selected.evidenceText}</p><span><ScanLine size={14}/>{selected.model} · Sayfa {selected.pageNumber}</span></div>:null}

          <EntityRelations
            documentId={documentId}
            relations={detail.relations}
            canReview={canReview}
            archived={archived}
            onChanged={relations=>setDetail(current=>current?{...current,relations}:current)}
            onError={setError}
            onNotice={setNotice}
          />

          <section className="objects"><header><ShieldCheck size={15}/><span><b>Nesne kayıtları</b><small>Asıl dosya ve türevler</small></span></header>{detail.objects.map(object=><article key={object.id}><b>{object.objectClass}</b><small>{Math.max(1,Math.round(object.byteSize/1024))} KB · {object.sha256.slice(0,12)}…</small><small>{object.generator??"—"} · {object.legalHoldStatus==="HELD"?"Yasal bekletme":object.retentionStatus}</small></article>)}</section>

          <section className="audit-trail"><header><History size={15}/><span><b>Değiştirilemez denetim izi</b><small>Belge bazında SHA-256 özet zinciri</small></span><ShieldCheck size={15}/></header>{detail.audit.length?detail.audit.map(event=><article key={event.eventNumber}><i/><span><b>{auditLabels[event.action]||event.action}</b><small>{event.actor} · {new Date(event.createdAt).toLocaleString("tr-TR")}</small><code>#{event.eventNumber} · {event.eventHash.slice(0,12)}…</code></span></article>):<p>Henüz personel işlemi kaydedilmedi.</p>}</section>
        </>:<div className="empty-ocr"><FileClock size={28}/><b>OCR sonucu bekleniyor</b><p>Asıl dosya güvenli kasada. Yerel OCR servisi çalıştığında metin ve alan kanıtları burada görünecek.</p>{canProcess?<button className="primary" onClick={process} disabled={processing}>{processing?<LoaderCircle className="spin" size={16}/>:<Play size={16}/>} Kuyruğu işle</button>:null}</div>}
      </aside>
    </div>
  </div>;
}
