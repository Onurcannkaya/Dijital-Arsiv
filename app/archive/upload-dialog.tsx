"use client";

import { CheckCircle2, Database, FileText, Fingerprint, LoaderCircle, Upload, X } from "lucide-react";
import { DragEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ACCEPTED_FILE_EXTENSIONS } from "../../lib/ingest-contract";

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

const PART_BYTES = 16 * 1024 * 1024;

async function sha256Hex(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function formatBytes(bytes: number) {
  // 1 KB'ın altı bayt olarak gösterilir: boş bir dosya "1 KB" görünürse
  // kullanıcı içeriği varmış sanır.
  if (bytes < 1024) return `${bytes} bayt`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadDialog({ open, onClose, onCreated }: UploadDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const idempotencyRef = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState(DEFAULT_TYPE_NAME);
  const [unit, setUnit] = useState(DEFAULT_UNIT_LABEL);
  const [phase, setPhase] = useState<"idle" | "uploading" | "done" | "duplicate" | "error">("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<StoredDocument | null>(null);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);

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

  if (!open) return null;

  const choose = (next: File | null) => {
    if (!next) return;
    setFile(next);
    setPhase("idle");
    setMessage("");
    setResult(null);
    idempotencyRef.current = crypto.randomUUID();
  };

  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    choose(event.dataTransfer.files.item(0));
  };

  const close = () => {
    if (phase === "uploading") return;
    setFile(null);
    setPhase("idle");
    setMessage("");
    setResult(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setPhase("error");
      setMessage("Önce bir belge seçin.");
      return;
    }
    setPhase("uploading");
    try {
      const idempotencyKey = idempotencyRef.current ?? crypto.randomUUID();
      idempotencyRef.current = idempotencyKey;
      setMessage("Güvenli yükleme oturumu hazırlanıyor…");
      const opened = await fetch("/api/uploads", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          originalName: file.name,
          documentType,
          unit,
          byteSize: file.size,
          mediaType: file.type || "application/octet-stream",
        }),
      });
      const openedPayload = await opened.json() as { session?: { id: string; missingParts: number[]; expectedPartCount: number }; error?: string };
      if (!opened.ok || !openedPayload.session) throw new Error(openedPayload.error || "Yükleme oturumu açılamadı.");
      const session = openedPayload.session;
      let uploaded = session.expectedPartCount - session.missingParts.length;
      for (let offset = 0; offset < session.missingParts.length; offset += 4) {
        const group = session.missingParts.slice(offset, offset + 4);
        await Promise.all(group.map(async (partNumber) => {
          const singlePart = session.expectedPartCount === 1;
          const start = singlePart ? 0 : (partNumber - 1) * PART_BYTES;
          const end = singlePart ? file.size : Math.min(start + PART_BYTES, file.size);
          const part = file.slice(start, end);
          const checksum = await sha256Hex(part);
          const response = await fetch(`/api/uploads/${session.id}/parts`, {
            method: "PUT",
            headers: { "x-part-number": String(partNumber), "x-content-sha256": checksum },
            body: part,
          });
          const payload = await response.json() as { error?: string };
          if (!response.ok) throw new Error(payload.error || `${partNumber}. parça yüklenemedi.`);
          uploaded += 1;
          setMessage(`${uploaded}/${session.expectedPartCount} parça doğrulandı…`);
        }));
      }
      setMessage("Parçalar tamamlandı; nesne karantina alanına aktarılıyor…");
      const completed = await fetch(`/api/uploads/${session.id}/complete`, { method: "POST" });
      const completedPayload = await completed.json() as { session?: { status: string }; error?: string };
      if (!completed.ok || !completedPayload.session) throw new Error(completedPayload.error || "Yükleme tamamlanamadı.");
      setPhase("done");
      setMessage("Belge karantinaya alındı; tür ve zararlı içerik taraması bekleniyor.");
      // Belge kaydı F1.5 terfisinde oluşur; karantina aşamasında listeye sahte bir
      // archive_documents kaydı eklenmez.
      void onCreated;
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Belge yüklenemedi.");
    }
  };

  return <div className="modal-layer" role="presentation">
    <button className="modal-scrim" type="button" onClick={close} aria-label="Yükleme penceresini kapat" />
    <section className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <header><div><span className="modal-icon"><Upload size={19}/></span><span><h2 id="upload-title">Yeni belge yükle</h2><p>Asıl dosya değişmeden korunur; OCR ayrı bir türev üretir.</p></span></div><button className="modal-close" type="button" onClick={close} disabled={phase === "uploading"} aria-label="Kapat"><X size={19}/></button></header>
      <form onSubmit={submit}>
        <input ref={inputRef} className="sr-only" type="file" accept={accepted} onChange={(event) => choose(event.target.files?.item(0) ?? null)} />
        <button className={`drop-zone ${file ? "has-file" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
          {file ? <><span className="file-symbol"><FileText size={24}/></span><span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.type || "Dosya"}</small></span><em>Değiştir</em></> : <><span className="upload-symbol"><Upload size={24}/></span><strong>Belgeyi buraya bırakın veya seçin</strong><small>PDF, JPEG, PNG, TIFF · En fazla 2 GiB</small></>}
        </button>
        <div className="upload-fields">
          <label><span>Belge türü</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
            {profiles.length
              ? profiles.map((profile) => <option key={profile.code} value={profile.name}>{profile.name}</option>)
              : <option value={DEFAULT_TYPE_NAME}>{DEFAULT_TYPE_NAME}</option>}
          </select></label>
          <label><span>İlgili müdürlük</span><select value={unit} onChange={(event) => setUnit(event.target.value)}>
            {units.length
              ? units.map((option) => <option key={option.code} value={option.label}>{option.label}</option>)
              : <option value={DEFAULT_UNIT_LABEL}>{DEFAULT_UNIT_LABEL}</option>}
          </select></label>
        </div>
        <div className="integrity-strip"><span><Fingerprint size={17}/><b>Bütünlük kontrolü</b><small>Aynı belge ikinci kez yüklenirse tanınır</small></span><span><Database size={17}/><b>Asıl dosya kasası</b><small>OCR türevinden ayrı saklama</small></span></div>
        {message ? <div className={`upload-message ${phase}`} role="status">{phase === "uploading" ? <LoaderCircle className="spin" size={17}/> : phase === "done" ? <CheckCircle2 size={17}/> : <Fingerprint size={17}/>}<span>{message}{result ? <small>{result.sha256.slice(0, 16)}… · {result.referenceNo}</small> : null}</span></div> : null}
        <footer><button className="outline" type="button" onClick={close} disabled={phase === "uploading"}>{phase === "done" ? "Kapat" : "Vazgeç"}</button><button className="primary" type="submit" disabled={!file || phase === "uploading" || phase === "done"}>{phase === "uploading" ? <><LoaderCircle className="spin" size={17}/> Yükleniyor</> : <><Upload size={17}/> Güvenli yükle</>}</button></footer>
      </form>
    </section>
  </div>;
}