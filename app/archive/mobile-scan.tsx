"use client";

/* eslint-disable @next/next/no-img-element -- Önizleme yerel blob URL'sidir; Next Image iyileştirmesi uygulanamaz. */

/**
 * Mobil tarama akışı (`3a`) — design.md §4.4 / §9.4 kararı (2026-08-14).
 *
 * Tek görev, tek sütun: Çek → Kontrol et → Tanımla → Yükle. Sahadaki memur
 * telefon kamerasıyla TEK SAYFALIK belgeyi güvenli kabul hattına bırakır;
 * doğrulama ve arşivleme masaüstünde kalır — küçük ekranda alan kanıtı
 * karşılaştırmak yanlış onay üretir, akış bunu dürüstçe söyler.
 *
 * Kalite denetimi (lib/scan-quality.ts) uyarır ama ENGELLEMEZ: tek nüsha
 * kötü ışıkta da çekilmek zorunda kalabilir ve OCR ön işleme zayıf taramayı
 * kurtarmayı dener. Çok sayfalı belge için akış tarayıcı + PDF yolunu
 * gösterir; V1 bilinçli olarak tek fotoğraf = tek JPEG'dir.
 *
 * Yükleme zinciri masaüstü diyaloğuyla ORTAKTIR (`upload-core.ts`).
 */

import { AlertTriangle, Camera, CheckCircle2, FileStack, Image as ImageIcon, LoaderCircle, RotateCcw, ShieldCheck, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { assessScanQuality, type ScanWarning } from "../../lib/scan-quality";
import { uploadSecurely } from "./upload-core";

type ProfileOption = { code: string; name: string; status: string };
type UnitOption = { code: string; label: string };
const DEFAULT_TYPE_NAME = "Tasnif bekliyor";
const DEFAULT_UNIT_LABEL = "Belirlenmedi";

type Props = { open: boolean; onClose: () => void };

/** Fotoğrafın kalite ölçümü: küçültülmüş tuvalden ortalama parlaklık. */
async function measure(file: File): Promise<{ url: string; width: number; height: number; warnings: ScanWarning[] }> {
  const bitmap = await createImageBitmap(file);
  const sample = document.createElement("canvas");
  const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
  sample.width = Math.max(1, Math.round(bitmap.width * scale));
  sample.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = sample.getContext("2d");
  let meanLuminance = 128; // ölçülemezse nötr: uydurma uyarı üretme
  if (context) {
    context.drawImage(bitmap, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      sum += 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
    }
    meanLuminance = sum / (pixels.length / 4);
  }
  return {
    url: URL.createObjectURL(file),
    width: bitmap.width,
    height: bitmap.height,
    warnings: assessScanQuality({ width: bitmap.width, height: bitmap.height, meanLuminance }),
  };
}

export function MobileScan({ open, onClose }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const idempotencyRef = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; warnings: ScanWarning[] } | null>(null);
  const [documentType, setDocumentType] = useState(DEFAULT_TYPE_NAME);
  const [unit, setUnit] = useState(DEFAULT_UNIT_LABEL);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [phase, setPhase] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    fetch("/api/profiles").then(async (response) => {
      const payload = await response.json() as { profiles?: ProfileOption[]; units?: UnitOption[] };
      if (!response.ok || !active) return;
      setProfiles(payload.profiles ?? []);
      setUnits(payload.units ?? []);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [open]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  if (!open) return null;

  const choose = async (next: File | null) => {
    if (!next) return;
    if (preview) URL.revokeObjectURL(preview.url);
    setFile(next);
    setPhase("idle");
    setMessage("");
    idempotencyRef.current = crypto.randomUUID();
    try {
      setPreview(await measure(next));
    } catch {
      // Önizleme üretilemese de yükleme yolu açık kalır; kalite denetimi
      // kolaylıktır, kabul koşulu değil.
      setPreview({ url: URL.createObjectURL(next), width: 0, height: 0, warnings: [] });
    }
  };

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setFile(null); setPreview(null); setPhase("idle"); setMessage("");
  };

  const close = () => {
    if (phase === "uploading") return;
    reset(); onClose();
  };

  const submit = async () => {
    if (!file) return;
    setPhase("uploading");
    try {
      const idempotencyKey = idempotencyRef.current ?? crypto.randomUUID();
      idempotencyRef.current = idempotencyKey;
      await uploadSecurely({ file, documentType, unit, idempotencyKey, onProgress: setMessage });
      setPhase("done");
      setMessage("Belge karantinaya alındı; tür ve zararlı içerik taraması bekleniyor. Denetimden geçince Gelen Evrak'ta görünecek.");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Belge yüklenemedi.");
    }
  };

  return <div className="mobile-scan" role="dialog" aria-modal="true" aria-label="Belge tara">
    <header>
      <span><Camera size={18} /><b>Belge tara</b></span>
      <button type="button" onClick={close} disabled={phase === "uploading"} aria-label="Kapat"><X size={18} /></button>
    </header>

    <div className="mobile-scan-body">
      {/* Adım 1 — Çek. Kamera arka lensi açar; galeri yolu izin yoksa da çalışır. */}
      <input ref={cameraRef} className="sr-only" type="file" accept="image/*" capture="environment"
        onChange={(event) => void choose(event.target.files?.item(0) ?? null)} />
      <input ref={galleryRef} className="sr-only" type="file" accept="image/*"
        onChange={(event) => void choose(event.target.files?.item(0) ?? null)} />

      {!file ? <>
        <button type="button" className="scan-capture" onClick={() => cameraRef.current?.click()}>
          <Camera size={26} /> Belgeyi çek
        </button>
        <button type="button" className="scan-gallery" onClick={() => galleryRef.current?.click()}>
          <ImageIcon size={16} /> Galeriden seç
        </button>
        <p className="scan-note"><FileStack size={14} /> Birden çok sayfa mı? Sayfaları tarayıcıdan geçirip
          tek PDF olarak masaüstünden yükleyin; mobil akış tek sayfa içindir.</p>
      </> : <>
        {/* Adım 2 — Kontrol et. Uyarı engel değildir; altın kart, kırmızı değil. */}
        {preview ? <img className="scan-preview" src={preview.url} alt="Çekilen belge önizlemesi" /> : null}
        {preview?.warnings.map((warning) => <p key={warning.code} className="scan-warning">
          <AlertTriangle size={15} /> {warning.message}
        </p>)}
        {phase !== "done" ? <button type="button" className="scan-retake" onClick={() => cameraRef.current?.click()} disabled={phase === "uploading"}>
          <RotateCcw size={15} /> Yeniden çek
        </button> : null}

        {/* Adım 3 — Tanımla. Tür bilinmiyorsa "Tasnif bekliyor" dürüst varsayılandır. */}
        {phase !== "done" ? <div className="scan-fields">
          <label>Belge türü<select value={documentType} onChange={(event) => setDocumentType(event.target.value)} disabled={phase === "uploading"}>
            {profiles.length
              ? profiles.map((profile) => <option key={profile.code} value={profile.name}>{profile.name}</option>)
              : <option value={DEFAULT_TYPE_NAME}>{DEFAULT_TYPE_NAME}</option>}
          </select></label>
          <label>İlgili müdürlük<select value={unit} onChange={(event) => setUnit(event.target.value)} disabled={phase === "uploading"}>
            {units.length
              ? units.map((option) => <option key={option.code} value={option.label}>{option.label}</option>)
              : <option value={DEFAULT_UNIT_LABEL}>{DEFAULT_UNIT_LABEL}</option>}
          </select></label>
        </div> : null}

        {message ? <p className={`scan-message ${phase}`} role="status">
          {phase === "uploading" ? <LoaderCircle className="spin" size={16} />
            : phase === "done" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{message}</span>
        </p> : null}

        {/* Adım 4 — Yükle; sonrası masaüstünün işi. */}
        {phase === "done"
          ? <button type="button" className="scan-submit" onClick={close}><CheckCircle2 size={17} /> Kapat</button>
          : <button type="button" className="scan-submit" onClick={() => void submit()} disabled={phase === "uploading"}>
            {phase === "uploading" ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />} Güvenli yükle
          </button>}
        <p className="scan-note"><ShieldCheck size={14} /> Asıl dosya değişmeden korunur; doğrulama ve
          arşivleme masaüstünde yapılır.</p>
      </>}
    </div>
  </div>;
}
