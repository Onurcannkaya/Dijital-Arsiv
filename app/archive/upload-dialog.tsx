"use client";

import {
  AlertTriangle, CheckCircle2, ChevronRight, FileText, Files as FilesIcon,
  LoaderCircle, ScanLine, Send, Upload, X,
} from "lucide-react";
import { DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { ACCEPTED_FILE_EXTENSIONS } from "../../lib/ingest-contract";
import { confidenceBadge } from "../../lib/confidence-language";
import { uploadSecurely } from "./upload-core";

export type StoredDocument = {
  id: string;
  referenceNo: string;
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  documentType: string;
  unit: string;
  status: string;
  uploadedBy: string;
  createdAt: string;
  /** Çok değerli alanlar liste görünümünde ` / ` ile birleştirilmiş gelir. */
  neighborhood?: string;
  ada?: string;
  parcel?: string;
  confidence?: number;
  contentMatch?: boolean;
  /** Personel kararı bekleyen alan değeri sayısı. */
  pendingValues?: number;
  verifiedRelations?: number;
  suggestedRelations?: number;
};

type UploadDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (document: StoredDocument) => void;
};

// Liste yükleme sözleşmesinden gelir; arayüz ile sunucu ayrışmasın.
const accepted = ACCEPTED_FILE_EXTENSIONS.join(",");

/** Yükleme seçenekleri kontrollü listelerden gelir; arayüzde sabit liste tutulmaz. */
type ProfileOption = { code: string; name: string; status: string };
type UnitOption = { code: string; label: string };
const DEFAULT_TYPE_NAME = "Tasnif bekliyor";
const DEFAULT_UNIT_LABEL = "Belirlenmedi";
const MISSING_VALUE = "Belirlenmedi";

/*
 * Sihirbaz dört adımdır ve memur yalnız "İleri" der: 1 belgeler seçilir,
 * 2 yükleme + tarama + okuma tek şeritte izlenir, 3 OCR'ın yakaladığı
 * alanlar düzeltilir, 4 sonuç özetlenir. Toplu arşiv aktarımı düşünülerek
 * dosyalar SIRAYLA yüklenir (her dosyanın parçaları kendi içinde paralel):
 * elli dosyayı aynı anda başlatmak tarayıcıyı ve kabul hattını boğar.
 */
type FilePhase = "waiting" | "uploading" | "scanning" | "promoting" | "reading"
  | "review" | "submitted" | "skipped" | "duplicate" | "rejected" | "failed";
type QueuedFile = {
  key: string;
  file: File;
  idempotencyKey: string;
  phase: FilePhase;
  message: string;
  sessionId: string | null;
  documentId: string | null;
};

const TERMINAL_PHASES = new Set<FilePhase>(["review", "submitted", "skipped", "duplicate", "rejected", "failed"]);
const phaseLabels: Record<FilePhase, string> = {
  waiting: "Sırada",
  uploading: "Yükleniyor",
  scanning: "Güvenlik taraması",
  promoting: "Kasaya aktarılıyor",
  reading: "Belge okunuyor (OCR)",
  review: "Okundu — kontrole hazır",
  submitted: "Kontrol edildi",
  skipped: "Atlandı — Doğrulama listesinde bekliyor",
  duplicate: "Mükerrer — belge zaten arşivde",
  rejected: "Kabul edilmedi",
  failed: "Başarısız",
};

/** Sunucu oturum durumunun sihirbaz şeridindeki karşılığı. */
function phaseOfSession(status: string): FilePhase | null {
  if (status === "QUARANTINED" || status === "SCANNING") return "scanning";
  if (status === "VERIFIED" || status === "PROMOTING" || status === "ACCEPTED") return "promoting";
  if (status === "DUPLICATE") return "duplicate";
  if (status === "REJECTED" || status === "EXPIRED" || status === "FAILED") return "rejected";
  return null;
}

/** Kontrol adımının ihtiyaç duyduğu belge detayı kesiti; tam tip document-review'dadır. */
type WizardValue = {
  id: string; name: string; label: string; value: string; confidence: number;
  verificationStatus: string; origin: string;
};
type WizardGroup = {
  name: string; label: string; requirement: string;
  vocabularyCode: string | null; valueIds: string[];
};
type WizardDetail = {
  document: { id: string; referenceNo: string; documentType: string; status: string; originalName: string };
  vocabularies: Record<string, Array<{ code: string; label: string }> | null>;
  fields: WizardValue[];
  fieldGroups: WizardGroup[];
};

function formatBytes(bytes: number) {
  // 1 KB'ın altı bayt olarak gösterilir: boş bir dosya "1 KB" görünürse
  // kullanıcı içeriği varmış sanır.
  if (bytes < 1024) return `${bytes} bayt`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadDialog({ open, onClose, onCreated }: UploadDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [documentType, setDocumentType] = useState(DEFAULT_TYPE_NAME);
  const [unit, setUnit] = useState(DEFAULT_UNIT_LABEL);
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  /** 3. adımın belge detayı; kapatma sıfırlaması da eriştiği için burada tanımlı. */
  const [detail, setDetail] = useState<WizardDetail | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  /*
   * Yoklama döngüsü ve sıralı yükleme, çizimler arasında güncel listeyi
   * görmek zorundadır; state kapanışta bayatlar. Ref her zaman son hâli
   * taşır, setFiles yalnız çizimi tazeler.
   */
  const filesRef = useRef<QueuedFile[]>([]);
  const pollingRef = useRef(false);
  const advanceBusyRef = useRef(false);
  /** Diyalog kapanırsa sıradaki dosyalar arayüzsüz yüklenmeye devam etmesin. */
  const batchCancelledRef = useRef(false);
  const patchFiles = useCallback((updater: (current: QueuedFile[]) => QueuedFile[]) => {
    filesRef.current = updater(filesRef.current);
    setFiles(filesRef.current);
  }, []);
  const patchFile = useCallback((key: string, patch: Partial<QueuedFile>) => {
    patchFiles((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }, [patchFiles]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    fetch("/api/profiles")
      .then(async (response) => {
        const payload = await response.json() as { profiles?: ProfileOption[]; units?: UnitOption[] };
        if (!response.ok || !active) return;
        setProfiles(payload.profiles ?? []);
        setUnits(payload.units ?? []);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [open]);

  // Diyalog kapanınca yoklama durur; OCR sunucuda cron ile sürmeye devam eder.
  useEffect(() => {
    if (!open) pollingRef.current = false;
    return () => { pollingRef.current = false; };
  }, [open]);

  /**
   * Kabul hattını bekletmeden ilerletir. Çağrı uzun sürebilir (OCR dilimi);
   * bu yüzden yoklama turu ona KİLİTLENMEZ — süren bir ilerletme varken
   * yenisi başlatılmaz, durum okumaları ayrı ve hızlı isteklerle döner.
   */
  const kickAdvance = useCallback(() => {
    if (advanceBusyRef.current) return;
    advanceBusyRef.current = true;
    fetch("/api/pipeline/advance", { method: "POST" })
      .catch(() => undefined)
      .finally(() => { advanceBusyRef.current = false; });
  }, []);

  const pollOnce = useCallback(async () => {
    const ids = filesRef.current.map((item) => item.sessionId).filter(Boolean) as string[];
    if (ids.length) {
      try {
        const response = await fetch(`/api/uploads?ids=${encodeURIComponent(ids.join(","))}`);
        const payload = await response.json() as { sessions?: Array<{
          id: string; status: string; duplicateOfDocumentId: string | null;
          documentId: string | null; failureCode: string | null }> };
        if (response.ok) {
          for (const session of payload.sessions ?? []) {
            const item = filesRef.current.find((entry) => entry.sessionId === session.id);
            if (!item || TERMINAL_PHASES.has(item.phase)) continue;
            if (session.status === "DUPLICATE") {
              patchFile(item.key, { phase: "duplicate", message: phaseLabels.duplicate, documentId: session.duplicateOfDocumentId });
            } else if (session.documentId) {
              // Terfi tamam: artık oturum değil belge izlenir.
              if (item.phase !== "reading") patchFile(item.key, { phase: "reading", message: phaseLabels.reading, documentId: session.documentId });
            } else {
              const phase = phaseOfSession(session.status);
              if (phase === "rejected") {
                patchFile(item.key, { phase, message: session.failureCode ? `${phaseLabels.rejected} · ${session.failureCode}` : phaseLabels.rejected });
              } else if (phase && phase !== item.phase) {
                patchFile(item.key, { phase, message: phaseLabels[phase] });
              }
            }
          }
        }
      } catch { /* Ağ hatasında mevcut şerit korunur; sonraki tur yeniden dener. */ }
    }
    const watched = filesRef.current.filter((item) => item.documentId && item.phase === "reading");
    if (watched.length) {
      try {
        const response = await fetch(`/api/documents?limit=200`);
        const payload = await response.json() as { documents?: StoredDocument[] };
        if (response.ok) {
          for (const item of watched) {
            const document = (payload.documents ?? []).find((entry) => entry.id === item.documentId);
            if (!document) continue;
            if (document.status === "review" || document.status === "ready") {
              patchFile(item.key, { phase: "review", message: phaseLabels.review });
              onCreated(document);
            } else if (document.status === "ocr_failed") {
              patchFile(item.key, { phase: "failed", message: "Okuma başarısız — Gelen Evrak listesinden yeniden deneyin" });
            }
          }
        }
      } catch { /* Ağ hatasında mevcut şerit korunur. */ }
    }
  }, [patchFile, onCreated]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    void (async () => {
      while (pollingRef.current) {
        kickAdvance();
        await pollOnce();
        if (!filesRef.current.some((item) => !TERMINAL_PHASES.has(item.phase))) {
          pollingRef.current = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    })();
  }, [kickAdvance, pollOnce]);

  const choose = (list: FileList | null) => {
    if (!list?.length) return;
    setError("");
    patchFiles((current) => {
      const known = new Set(current.map((item) => `${item.file.name}|${item.file.size}`));
      const additions = Array.from(list)
        .filter((file) => !known.has(`${file.name}|${file.size}`))
        .map((file) => ({
          key: crypto.randomUUID(),
          file,
          idempotencyKey: crypto.randomUUID(),
          phase: "waiting" as const,
          message: phaseLabels.waiting,
          sessionId: null,
          documentId: null,
        }));
      return [...current, ...additions];
    });
  };

  const removeFile = (key: string) => patchFiles((current) => current.filter((item) => item.key !== key));

  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    choose(event.dataTransfer.files);
  };

  const uploadingNow = files.some((item) => item.phase === "uploading");
  const close = () => {
    if (uploadingNow) return;
    pollingRef.current = false;
    batchCancelledRef.current = true;
    filesRef.current = [];
    setFiles([]);
    setStep(1);
    setError("");
    setDetail(null);
    setDrafts({});
    onClose();
  };

  /** 2. adım: dosyalar sırayla kabul hattına verilir; hata tekil dosyada kalır. */
  const startBatch = async () => {
    if (!filesRef.current.length) { setError("Önce en az bir belge seçin."); return; }
    setError("");
    setStep(2);
    batchCancelledRef.current = false;
    startPolling();
    for (const item of filesRef.current) {
      if (batchCancelledRef.current) break;
      if (item.phase !== "waiting") continue;
      patchFile(item.key, { phase: "uploading", message: phaseLabels.uploading });
      try {
        const result = await uploadSecurely({
          file: item.file, documentType, unit,
          idempotencyKey: item.idempotencyKey,
          onProgress: (message) => patchFile(item.key, { message }),
        });
        patchFile(item.key, { phase: "scanning", message: phaseLabels.scanning, sessionId: result.sessionId });
      } catch (reason) {
        patchFile(item.key, { phase: "failed", message: reason instanceof Error ? reason.message : "Belge yüklenemedi." });
      }
    }
  };

  /* ---- 3. adım: OCR'ın yakaladığı alanların kontrolü ---- */
  const reviewQueue = files.filter((item) => item.phase === "review" && item.documentId);
  const stillWorking = files.filter((item) => !TERMINAL_PHASES.has(item.phase));
  const currentReview = step === 3 ? reviewQueue[0] ?? null : null;

  useEffect(() => {
    if (step !== 3 || !currentReview?.documentId) { return; }
    if (detail?.document.id === currentReview.documentId) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Detay yüklemesi, sıradaki belge değişince eşzamanlı başlatılır.
    setDetailLoading(true);
    setError("");
    fetch(`/api/documents/${currentReview.documentId}`)
      .then(async (response) => {
        const payload = await response.json() as WizardDetail & { error?: string };
        if (!active) return;
        if (!response.ok) throw new Error(payload.error || "Belge alınamadı.");
        setDetail(payload);
        setDrafts(Object.fromEntries(payload.fields.map((value) => [value.id, value.value === MISSING_VALUE ? "" : value.value])));
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Belge alınamadı."); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [step, currentReview?.documentId, detail?.document.id]);

  // Kontrol edilecek belge kalmadıysa ve okuma da sürmüyorsa özet adımına geçilir.
  useEffect(() => {
    if (step === 3 && !reviewQueue.length && !stillWorking.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Adım geçişi kuyruk boşalınca eşzamanlı yapılır.
      setStep(4);
    }
  }, [step, reviewQueue.length, stillWorking.length]);

  /**
   * Alan kararlarını kaydeder ve belgeyi onaya sunar: düzeltilen değer
   * `correct`, dokunulmayan öneri `confirm` olur. Ret ve yeni değer ekleme
   * sihirbazda yoktur — o kararlar gerekçe ister ve Doğrulama ekranındadır.
   */
  const submitCurrent = async () => {
    if (!detail || !currentReview) return;
    type FieldOperation = { id: string; action: "confirm" | "correct"; value?: string };
    const operations = detail.fields.flatMap<FieldOperation>((value) => {
      if (value.verificationStatus === "REJECTED") return [];
      const draft = (drafts[value.id] ?? "").trim();
      const original = value.value === MISSING_VALUE ? "" : value.value;
      if (draft && draft !== original) return [{ id: value.id, action: "correct", value: draft }];
      if (value.verificationStatus === "SUGGESTED" && original) return [{ id: value.id, action: "confirm" }];
      return [];
    });
    setSaving(true);
    setError("");
    try {
      if (operations.length) {
        const response = await fetch(`/api/documents/${detail.document.id}/fields`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values: operations }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Alanlar kaydedilemedi.");
      }
      /*
       * Doldurulmadan bırakılan zorunlu alan onaya engel değildir; belge
       * `review` durumunda kalır ve Doğrulama listesinde eksikleriyle görünür.
       * Sihirbaz bunu saklamaz, özetle söyler.
       */
      const leftover = detail.fields.some((value) =>
        value.verificationStatus === "SUGGESTED" && value.value === MISSING_VALUE
        && !(drafts[value.id] ?? "").trim());
      patchFile(currentReview.key, {
        phase: "submitted",
        message: leftover ? "Kaydedildi — eksik alanlar Doğrulama listesinde" : "Onaya sunuldu",
      });
      setDetail(null);
      setDrafts({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Alanlar kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  };

  const skipCurrent = () => {
    if (!currentReview) return;
    patchFile(currentReview.key, { phase: "skipped", message: phaseLabels.skipped });
    setDetail(null);
    setDrafts({});
  };

  if (!open) return null;

  const readyCount = files.filter((item) => item.phase === "review").length;
  const doneUploading = files.length > 0 && files.every((item) => item.phase !== "waiting" && item.phase !== "uploading");
  const summary = {
    submitted: files.filter((item) => item.phase === "submitted").length,
    review: files.filter((item) => item.phase === "review" || item.phase === "skipped").length,
    duplicate: files.filter((item) => item.phase === "duplicate").length,
    failed: files.filter((item) => item.phase === "rejected" || item.phase === "failed").length,
    working: stillWorking.length,
  };

  const phaseIcon = (phase: FilePhase) =>
    phase === "review" || phase === "submitted" ? <CheckCircle2 size={16} className="ok" />
      : phase === "duplicate" || phase === "rejected" || phase === "failed" ? <AlertTriangle size={16} className="warn" />
      : phase === "waiting" || phase === "skipped" ? <FileText size={16} />
      : <LoaderCircle size={16} className="spin" />;

  const fileStrip = <ul className="wizard-files">
    {files.map((item) => <li key={item.key} className={`file-${item.phase}`}>
      {phaseIcon(item.phase)}
      <b>{item.file.name}</b>
      <small>{formatBytes(item.file.size)}</small>
      <span>{item.message}</span>
      {step === 1 ? <button type="button" className="icon-btn" aria-label={`${item.file.name} dosyasını listeden çıkar`} onClick={() => removeFile(item.key)}><X size={15} /></button> : null}
    </li>)}
  </ul>;

  return <div className="modal-layer" role="presentation">
    <button className="modal-scrim" type="button" onClick={close} aria-label="Yükleme penceresini kapat" />
    <section className="upload-modal wizard" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <header><div><span className="modal-icon"><Upload size={19} /></span><span><h2 id="upload-title">Hızlı belge kabulü</h2><p>Yükle, okunmasını izle, alanları düzelt, onaya sun — hepsi bu pencerede.</p></span></div><button className="modal-close" type="button" onClick={close} disabled={uploadingNow} aria-label="Kapat"><X size={19} /></button></header>
      <ol className="wizard-steps" aria-label="Kabul adımları">
        {["Belgeler", "Yükleme ve okuma", "Kontrol", "Özet"].map((label, index) =>
          <li key={label} className={step === index + 1 ? "active" : step > index + 1 ? "done" : ""} aria-current={step === index + 1 ? "step" : undefined}><b>{index + 1}</b><span>{label}</span></li>)}
      </ol>
      <div className="wizard-body">
        {step === 1 ? <>
          <input ref={inputRef} className="sr-only" type="file" multiple accept={accepted} onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
          <button className={`drop-zone ${files.length ? "has-file" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
            {files.length
              ? <><span className="file-symbol"><FilesIcon size={24} /></span><span><strong>{files.length} belge seçildi</strong><small>Toplam {formatBytes(files.reduce((total, item) => total + item.file.size, 0))} · eklemek için tekrar tıklayın</small></span><em>Ekle</em></>
              : <><span className="upload-symbol"><Upload size={24} /></span><strong>Belgeleri buraya bırakın veya seçin</strong><small>Birden çok dosya seçebilirsiniz · PDF, JPEG, PNG, TIFF · Dosya başına en fazla 2 GiB</small></>}
          </button>
          {files.length ? fileStrip : null}
          <div className="upload-fields">
            <label><span>Belge türü (tümü için)</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
              {profiles.length
                ? profiles.map((profile) => <option key={profile.code} value={profile.name}>{profile.name}</option>)
                : <option value={DEFAULT_TYPE_NAME}>{DEFAULT_TYPE_NAME}</option>}
            </select></label>
            <label><span>İlgili müdürlük (tümü için)</span><select value={unit} onChange={(event) => setUnit(event.target.value)}>
              {units.length
                ? units.map((option) => <option key={option.code} value={option.label}>{option.label}</option>)
                : <option value={DEFAULT_UNIT_LABEL}>{DEFAULT_UNIT_LABEL}</option>}
            </select></label>
          </div>
        </> : null}

        {step === 2 ? <>
          <p className="wizard-hint"><ScanLine size={16} /> Dosyalar sırayla yüklenir; her biri güvenlik taramasından geçer, kasaya alınır ve OCR ile okunur. Bu pencereyi kapatsanız da okuma sunucuda devam eder.</p>
          {fileStrip}
        </> : null}

        {step === 3 ? <>
          {currentReview && detail ? <>
            <p className="wizard-hint"><FileText size={16} /> <b>{detail.document.referenceNo}</b> · {currentReview.file.name} — OCR&apos;ın yakaladığı değerleri kontrol edin, gerekiyorsa düzeltin.{reviewQueue.length > 1 ? ` Sırada ${reviewQueue.length - 1} belge daha var.` : ""}</p>
            <div className="wizard-fields">
              {detail.fieldGroups.map((group) => {
                const terms = group.vocabularyCode ? detail.vocabularies[group.vocabularyCode] ?? null : null;
                const values = group.valueIds
                  .map((valueId) => detail.fields.find((value) => value.id === valueId))
                  .filter((value): value is WizardValue => Boolean(value) && value!.verificationStatus !== "REJECTED");
                if (!values.length) return null;
                return values.map((value, index) => {
                  const badge = value.origin === "OCR" && value.confidence > 0 ? confidenceBadge(value.confidence) : null;
                  return <label key={value.id}>
                    <span>{group.label}{values.length > 1 ? ` (${index + 1})` : ""}{group.requirement !== "OPTIONAL" ? <i title="Zorunlu alan"> *</i> : null}
                      {badge ? <em className={badge.needsReview ? "low-confidence" : "confidence"}>{badge.label}</em> : null}</span>
                    {terms?.length
                      ? <select value={drafts[value.id] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [value.id]: event.target.value }))}>
                          <option value="">Seçin…</option>
                          {terms.map((term) => <option key={term.code} value={term.label}>{term.label}</option>)}
                          {(drafts[value.id] ?? "") && !terms.some((term) => term.label === drafts[value.id]) ? <option value={drafts[value.id]}>{drafts[value.id]}</option> : null}
                        </select>
                      : <input value={drafts[value.id] ?? ""} placeholder={value.value === MISSING_VALUE ? "OCR bulamadı — belgeden okuyup girin" : ""} onChange={(event) => setDrafts((current) => ({ ...current, [value.id]: event.target.value }))} />}
                  </label>;
                });
              })}
            </div>
          </> : detailLoading ? <p className="wizard-hint"><LoaderCircle size={16} className="spin" /> Belge alanları yükleniyor…</p>
            : stillWorking.length ? <p className="wizard-hint"><LoaderCircle size={16} className="spin" /> {stillWorking.length} belgenin okunması sürüyor; hazır olan burada açılacak. Beklemek istemezseniz Özet&apos;e geçebilirsiniz.</p>
            : null}
          {stillWorking.length && currentReview ? <p className="wizard-note">{stillWorking.length} belge daha arka planda okunuyor.</p> : null}
        </> : null}

        {step === 4 ? <div className="wizard-summary">
          {summary.submitted ? <p><CheckCircle2 size={16} className="ok" /> <b>{summary.submitted} belge</b> kontrol edildi ve onaya sunuldu.</p> : null}
          {summary.review ? <p><FileText size={16} /> <b>{summary.review} belge</b> okundu; kontrolü Doğrulama listesinde bekliyor.</p> : null}
          {summary.working ? <p><LoaderCircle size={16} className="spin" /> <b>{summary.working} belge</b> hâlâ okunuyor; bittiğinde Doğrulama listesine düşecek.</p> : null}
          {summary.duplicate ? <p><AlertTriangle size={16} className="warn" /> <b>{summary.duplicate} belge</b> mükerrer çıktı; asıl kayıt arşivde duruyor.</p> : null}
          {summary.failed ? <p><AlertTriangle size={16} className="warn" /> <b>{summary.failed} belge</b> kabul edilemedi; ayrıntı Gelen Evrak&apos;taki bekleyen yüklemeler şeridinde.</p> : null}
          {!files.length ? <p>Bu oturumda belge yüklenmedi.</p> : null}
        </div> : null}

        {error ? <div className="upload-message error" role="status"><AlertTriangle size={17} /><span>{error}</span></div> : null}
      </div>
      <footer>
        <button className="outline" type="button" onClick={close} disabled={uploadingNow}>{step === 4 ? "Kapat" : step === 2 ? "Arka planda sürsün" : "Vazgeç"}</button>
        {step === 1 ? <button className="primary" type="button" disabled={!files.length} onClick={() => { void startBatch(); }}><Upload size={17} /> İleri: Yükle{files.length ? ` (${files.length})` : ""}</button> : null}
        {step === 2 ? <button className="primary" type="button" disabled={!readyCount && !doneUploading} onClick={() => setStep(readyCount ? 3 : 4)}>
          {readyCount ? <><ChevronRight size={17} /> İleri: Kontrol ({readyCount} hazır)</> : <><ChevronRight size={17} /> İleri: Özet</>}
        </button> : null}
        {step === 3 && currentReview ? <>
          <button className="outline" type="button" onClick={skipCurrent} disabled={saving}>Atla</button>
          <button className="primary" type="button" onClick={() => { void submitCurrent(); }} disabled={saving || !detail}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} Kaydet ve onaya sun
          </button>
        </> : null}
        {step === 3 && !currentReview ? <button className="primary" type="button" onClick={() => setStep(4)}><ChevronRight size={17} /> İleri: Özet</button> : null}
      </footer>
    </section>
  </div>;
}
