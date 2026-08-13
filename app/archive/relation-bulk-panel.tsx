"use client";

/**
 * Toplu parsel onayı — design.md §9.2 kararı (2026-08-13): KAYAN PANEL.
 *
 * "68 parsel" senaryosu: bir encümen/imar kararı onlarca parsele dokunur ve
 * OCR her biri için ayrı ilişki önerisi üretir. Tek tek Doğrula tıklamak 68
 * istek, 68 bekleme demektir; ayrı bir ekran ise memuru belgenin bağlamından
 * (önizleme, alanlar) koparır. Panel belge alanının üzerine kayar: geniş yer
 * vardır, ekran değişmez.
 *
 * Her satır kanıtıyla gelir (ilke 3): değerin belgede okunduğu yerin
 * kırpması ve kanıt metni satırın içindedir — toplu onay, kanıtsız onay
 * değildir. Toplu ret tek ortak gerekçeyle yazılır; farklı gerekçe gereken
 * satır panelden çıkarılıp tekil akışla reddedilir.
 *
 * Sunucu PATCH ucu istek başına en çok 60 ilişki kabul eder; seçim daha
 * büyükse istemci 60'lık parçalara böler. Her parça sunucuda atomiktir ve
 * kendi denetim olayını yazar.
 */

import { CheckCircle2, ListChecks, LoaderCircle, MapPin, Signpost, ThumbsDown, X } from "lucide-react";
import { useState } from "react";
import { OTHER_REASON_CODE, type RejectionReason } from "../../lib/rejection-reasons";
import { confidencePhrase } from "../../lib/confidence-language";
import { evidenceCropStyle, hasEvidenceBox, type EvidenceBox } from "../../lib/evidence-crop";
import type { EntityRelation } from "./entity-relations";

/** Sunucudaki sınırla aynı (app/api/documents/[id]/relations PATCH). */
const BATCH_LIMIT = 60;

type Props = {
  documentId: string;
  suggestions: EntityRelation[];
  rejectionReasons: RejectionReason[];
  /** Güvenli görüntüleme türevi; kanıt kırpmaları bundan kesilir. */
  fileSrc: string | null;
  pageDims: (pageNumber: number) => { width: number; height: number } | null;
  onChanged: (relations: EntityRelation[]) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onClose: () => void;
};

/** OCR önerisinin kanıt gövdesini güvenle okur; biçimi bozuksa kanıt yok sayılır. */
function evidenceOf(relation: EntityRelation): { text: string | null; pageNumber: number | null; box: EvidenceBox | null } {
  const raw = relation.evidence;
  if (!raw || typeof raw !== "object") return { text: null, pageNumber: null, box: null };
  const record = raw as Record<string, unknown>;
  const text = typeof record.evidenceText === "string" && record.evidenceText.trim() ? record.evidenceText : null;
  const pageNumber = typeof record.pageNumber === "number" ? record.pageNumber : null;
  const box = Array.isArray(record.box) && record.box.length === 4 && record.box.every((v) => typeof v === "number")
    ? record.box as unknown as EvidenceBox : null;
  return { text, pageNumber, box };
}

export function RelationBulkPanel({ documentId, suggestions, rejectionReasons, fileSrc, pageDims, onChanged, onError, onNotice, onClose }: Props) {
  /*
   * Bütün öneriler seçili başlar: panelin varlık sebebi "çoğu doğru, birkaçı
   * şüpheli" durumudur ve memurun işi şüphelileri seçimden ÇIKARMAKTIR.
   * Karar yine kanıt karşısında verilir — her satır kırpmasını taşır.
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suggestions.map((item) => item.id)));
  const [rejectMode, setRejectMode] = useState(false);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonIncomplete = !reasonCode || (reasonCode === OTHER_REASON_CODE && !reasonNote.trim());

  const toggle = (relationId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(relationId)) next.delete(relationId);
    else next.add(relationId);
    return next;
  });
  const allSelected = selected.size === suggestions.length;

  const submit = async (action: "verify" | "reject") => {
    const ids = suggestions.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (!ids.length) return;
    setBusy(true); onError(""); onNotice("");
    let verified = 0, rejected = 0;
    let latest: EntityRelation[] | null = null;
    try {
      for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
        const chunk = ids.slice(start, start + BATCH_LIMIT).map((id) => ({
          id, action,
          ...(action === "reject" ? { reasonCode, reasonNote } : {}),
        }));
        const response = await fetch(`/api/documents/${documentId}/relations`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ relations: chunk }),
        });
        const payload = await response.json() as { error?: string; verified?: number; rejected?: number; relations?: EntityRelation[] };
        if (!response.ok) throw new Error(payload.error || "Toplu karar kaydedilemedi.");
        verified += payload.verified ?? 0;
        rejected += payload.rejected ?? 0;
        if (payload.relations) latest = payload.relations;
      }
      if (latest) onChanged(latest);
      onNotice(action === "verify"
        ? `${verified} varlık ilişkisi personel onayıyla doğrulandı.`
        : `${rejected} varlık ilişkisi tek gerekçeyle reddedildi; her karar denetim izinde.`);
      // Karar bekleyen öneri kalmadıysa panelin işi bitmiştir.
      if (!latest || !latest.some((item) => item.verificationStatus === "SUGGESTED")) onClose();
      else setSelected(new Set(latest.filter((item) => item.verificationStatus === "SUGGESTED").map((item) => item.id)));
      setRejectMode(false); setReasonCode(""); setReasonNote("");
    } catch (reason) {
      // Parçalı gönderimde ilk hata koşuyu durdurur; o ana dek kaydedilen
      // kararlar sunucuda kalıcıdır ve liste son başarılı halden tazelenir.
      if (latest) onChanged(latest);
      onError(reason instanceof Error ? reason.message : "Toplu karar kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="bulk-panel" role="dialog" aria-label="Toplu ilişki onayı">
    <header>
      <ListChecks size={16} />
      <span>
        <b>{suggestions.length} ilişki önerisi — toplu karar</b>
        <small>Şüpheli satırları seçimden çıkarın; kalanlar tek işlemle karara bağlanır.</small>
      </span>
      <button type="button" className="bulk-select-all" disabled={busy}
        onClick={() => setSelected(allSelected ? new Set() : new Set(suggestions.map((item) => item.id)))}>
        {allSelected ? "Seçimi kaldır" : "Tümünü seç"}
      </button>
      <button type="button" className="bulk-close" onClick={onClose} aria-label="Paneli kapat"><X size={15} /></button>
    </header>
    <ul className="bulk-list">
      {suggestions.map((relation) => {
        const evidence = evidenceOf(relation);
        const dims = evidence.pageNumber !== null ? pageDims(evidence.pageNumber) : null;
        const crop = fileSrc && evidence.box && dims && hasEvidenceBox(evidence.box)
          ? evidenceCropStyle(evidence.box, dims.width, dims.height) : null;
        const checked = selected.has(relation.id);
        return <li key={relation.id} className={`bulk-row ${checked ? "selected" : ""}`}>
          <label>
            <input type="checkbox" checked={checked} disabled={busy} onChange={() => toggle(relation.id)} />
            <b>{relation.entityType === "PARCEL" ? <MapPin size={13} /> : <Signpost size={13} />}{relation.displayLabel}</b>
            <small>
              {relation.relationSource === "OCR" && relation.relationConfidence !== null
                ? confidencePhrase(relation.relationConfidence, "OCR") : relation.relationSource}
              {evidence.text ? <> · <q>{evidence.text}</q></> : null}
            </small>
            {crop ? <i className="evidence-crop" role="img"
              aria-label={`${relation.displayLabel} kanıtının belge kırpması — sayfa ${evidence.pageNumber}`}
              style={{ backgroundImage: `url(${fileSrc})`, ...crop }} /> : null}
          </label>
        </li>;
      })}
    </ul>
    <footer className="bulk-foot">
      {rejectMode
        ? <div className="rejection-reason bulk-rejection">
          <select aria-label="Ortak ret gerekçesi" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} disabled={busy}>
            <option value="">Ortak ret gerekçesi seçin…</option>
            {rejectionReasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.label}</option>)}
          </select>
          <input aria-label="Ret açıklaması" maxLength={300} value={reasonNote} disabled={busy}
            placeholder={reasonCode === OTHER_REASON_CODE ? "Açıklama zorunlu" : "Açıklama (isteğe bağlı)"}
            onChange={(event) => setReasonNote(event.target.value)} />
          <button type="button" onClick={() => setRejectMode(false)} disabled={busy}>Vazgeç</button>
          <button type="button" className="relation-reject" disabled={busy || reasonIncomplete || !selected.size}
            title={reasonIncomplete ? "Ret gerekçesi seçilmelidir." : undefined}
            onClick={() => void submit("reject")}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <ThumbsDown size={13} />} Reddi kaydet ({selected.size})
          </button>
        </div>
        : <>
          <button type="button" className="relation-verify" disabled={busy || !selected.size} onClick={() => void submit("verify")}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />} Doğrula ({selected.size})
          </button>
          <button type="button" className="relation-reject" disabled={busy || !selected.size} onClick={() => setRejectMode(true)}>
            <ThumbsDown size={13} /> Reddet ({selected.size})
          </button>
          <small>Her karar, gerekçesi ve kim tarafından verildiğiyle birlikte değişmez denetim izine yazılır.</small>
        </>}
    </footer>
  </div>;
}
