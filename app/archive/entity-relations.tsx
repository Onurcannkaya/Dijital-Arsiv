"use client";

import { CheckCircle2, LoaderCircle, MapPin, Plus, ShieldCheck, Signpost, ThumbsDown, X } from "lucide-react";
import { useState } from "react";

export type EntityRelation = {
  id: string;
  entityId: string;
  entityType: "PARCEL" | "ADDRESS" | "BUILDING" | "BUILDING_UNIT";
  entityStatus: string;
  displayLabel: string;
  authoritySource: string;
  externalId: string | null;
  relationType: string;
  relationSource: string;
  relationConfidence: number | null;
  verificationStatus: "SUGGESTED" | "VERIFIED" | "REJECTED";
  verifiedBy: string | null;
  verifiedAt: string | null;
  parcel: { districtCode: string; cadastralNeighborhood: string; blockNo: string; parcelNo: string } | null;
  address: { neighborhood: string; street: string; doorNo: string; unitNo: string } | null;
};

const relationTypeLabels: Record<string, string> = {
  SUBJECT: "Ana konu", AFFECTS: "Etkilenen", ATTACHMENT_REFERENCE: "Ekte geçen", NEIGHBOR: "Komşu",
  PARTY: "Taraf", HISTORICAL_LINK: "Tarihsel bağ", SPATIAL_INTERSECTION: "Mekânsal kesişim", TEXT_MENTION: "Metinde geçen",
};
const sourceLabels: Record<string, string> = {
  GIS: "CBS", HUMAN: "Personel", OCR: "OCR önerisi", INTEGRATION: "Entegrasyon", SPATIAL: "Geometri",
};
const statusLabels: Record<string, string> = { SUGGESTED: "Öneri", VERIFIED: "Doğrulandı", REJECTED: "Reddedildi" };
const entityStatusLabels: Record<string, string> = {
  PROVISIONAL: "Geçici kimlik", ACTIVE: "Yetkili kimlik", HISTORICAL: "Tarihsel", MERGED: "Birleştirildi",
};

type Props = {
  documentId: string;
  relations: EntityRelation[];
  canReview: boolean;
  archived: boolean;
  onChanged: (relations: EntityRelation[]) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

type FormMode = "none" | "parcel" | "address";

const emptyParcel = { blockNo: "", parcelNo: "", districtCode: "", cadastralNeighborhood: "", externalId: "" };
const emptyAddress = { neighborhood: "", street: "", doorNo: "", unitNo: "", externalId: "" };

export function EntityRelations({ documentId, relations, canReview, archived, onChanged, onError, onNotice }: Props) {
  const [mode, setMode] = useState<FormMode>("none");
  const [parcel, setParcel] = useState(emptyParcel);
  const [address, setAddress] = useState(emptyAddress);
  const [busy, setBusy] = useState(false);

  const pending = relations.filter((relation) => relation.verificationStatus === "SUGGESTED");
  const editable = canReview && !archived;

  const decide = async (relationId: string, action: "verify" | "reject") => {
    setBusy(true); onError(""); onNotice("");
    try {
      const response = await fetch(`/api/documents/${documentId}/relations`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relations: [{ id: relationId, action }] }),
      });
      const payload = await response.json() as { error?: string; unchanged?: boolean; message?: string; relations?: EntityRelation[] };
      if (!response.ok) throw new Error(payload.error || "İlişki güncellenemedi.");
      onChanged(payload.relations ?? []);
      // Durum zaten istenen durumdaysa karar kaydedilmez; bunu "doğrulandı"
      // diye bildirmek personele olmamış bir işlemi rapor eder.
      onNotice(payload.unchanged
        ? payload.message ?? "İlişki zaten bu durumdaydı."
        : action === "verify" ? "Varlık ilişkisi personel onayıyla doğrulandı." : "Varlık ilişkisi reddedildi; kayıt denetim izinde korunuyor.");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "İlişki güncellenemedi.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true); onError(""); onNotice("");
    try {
      const body = mode === "parcel"
        ? { parcel: { ...parcel, externalId: parcel.externalId || undefined }, relationType: "SUBJECT" }
        : { address: { ...address, externalId: address.externalId || undefined }, relationType: "SUBJECT" };
      const response = await fetch(`/api/documents/${documentId}/relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { error?: string; unchanged?: boolean; message?: string;
        relations?: EntityRelation[]; entity?: { displayLabel: string; created?: boolean } };
      if (!response.ok) throw new Error(payload.error || "İlişki eklenemedi.");
      onChanged(payload.relations ?? []);
      onNotice(payload.unchanged
        ? payload.message ?? "Bu ilişki zaten kurulmuştu."
        : `${payload.entity?.displayLabel ?? "Varlık"} belgeyle ilişkilendirildi${payload.entity?.created ? "" : " (var olan kayıt kullanıldı)"}.`);
      setParcel(emptyParcel); setAddress(emptyAddress); setMode("none");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "İlişki eklenemedi.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="relations">
    <header>
      <MapPin size={15} />
      <span>
        <b>Varlık ilişkileri</b>
        <small>{relations.length ? `${relations.length} ilişki · ${pending.length} öneri kontrol bekliyor` : "Parsel ve adres ilişkisi henüz kurulmadı"}</small>
      </span>
      <ShieldCheck size={15} />
    </header>

    {relations.length ? <ul className="relation-list">
      {relations.map((relation) => <li key={relation.id} className={`relation-${relation.verificationStatus.toLowerCase()}`}>
        <div className="relation-head">
          <b>{relation.entityType === "PARCEL" ? <MapPin size={13} /> : <Signpost size={13} />}{relation.displayLabel}</b>
          <em className={`relation-status ${relation.verificationStatus.toLowerCase()}`}>{statusLabels[relation.verificationStatus]}</em>
        </div>
        <small>
          {relationTypeLabels[relation.relationType] ?? relation.relationType} · {sourceLabels[relation.relationSource] ?? relation.relationSource}
          {relation.relationConfidence !== null ? ` · %${Math.round(relation.relationConfidence * 100)}` : ""}
          {" · "}{entityStatusLabels[relation.entityStatus] ?? relation.entityStatus}
          {relation.externalId ? ` · ${relation.authoritySource}:${relation.externalId}` : ""}
        </small>
        {relation.verifiedBy ? <small className="relation-actor">{relation.verifiedBy}{relation.verifiedAt ? ` · ${new Date(relation.verifiedAt).toLocaleString("tr-TR")}` : ""}</small> : null}
        {editable && relation.verificationStatus === "SUGGESTED" ? <div className="relation-actions">
          <button type="button" className="relation-verify" onClick={() => decide(relation.id, "verify")} disabled={busy}><CheckCircle2 size={13} /> Doğrula</button>
          <button type="button" className="relation-reject" onClick={() => decide(relation.id, "reject")} disabled={busy}><ThumbsDown size={13} /> Reddet</button>
        </div> : null}
      </li>)}
    </ul> : null}

    {editable ? <div className="relation-add">
      {mode === "none" ? <div className="relation-add-buttons">
        <button type="button" onClick={() => setMode("parcel")}><Plus size={13} /> Parsel ekle</button>
        <button type="button" onClick={() => setMode("address")}><Plus size={13} /> Adres ekle</button>
      </div> : null}

      {mode === "parcel" ? <form className="relation-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="relation-form-head"><b>Parsel ilişkisi</b><button type="button" onClick={() => setMode("none")} aria-label="Vazgeç"><X size={14} /></button></div>
        <div className="relation-grid">
          <label>Ada<input value={parcel.blockNo} onChange={(event) => setParcel({ ...parcel, blockNo: event.target.value })} placeholder="32" required /></label>
          <label>Parsel<input value={parcel.parcelNo} onChange={(event) => setParcel({ ...parcel, parcelNo: event.target.value })} placeholder="2 veya 12-A" required /></label>
          <label>İlçe<input value={parcel.districtCode} onChange={(event) => setParcel({ ...parcel, districtCode: event.target.value })} placeholder="Bilinmiyorsa boş" /></label>
          <label>Kadastro mahallesi<input value={parcel.cadastralNeighborhood} onChange={(event) => setParcel({ ...parcel, cadastralNeighborhood: event.target.value })} placeholder="Bilinmiyorsa boş" /></label>
          <label className="relation-wide">CBS parsel kimliği<input value={parcel.externalId} onChange={(event) => setParcel({ ...parcel, externalId: event.target.value })} placeholder="Kent Rehberi kimliği (varsa)" /></label>
        </div>
        <p className="relation-hint">İlçe, kadastro mahallesi veya CBS kimliği girilmezse varlık <b>geçici kimlikli</b> kaydedilir; hukuki parsel kimliği yerine geçmez.</p>
        <button className="relation-submit" type="submit" disabled={busy || !parcel.blockNo.trim() || !parcel.parcelNo.trim()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} İlişkiyi kaydet
        </button>
      </form> : null}

      {mode === "address" ? <form className="relation-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="relation-form-head"><b>Adres ilişkisi</b><button type="button" onClick={() => setMode("none")} aria-label="Vazgeç"><X size={14} /></button></div>
        <div className="relation-grid">
          <label>Mahalle<input value={address.neighborhood} onChange={(event) => setAddress({ ...address, neighborhood: event.target.value })} placeholder="Kandemir" /></label>
          <label>Yol<input value={address.street} onChange={(event) => setAddress({ ...address, street: event.target.value })} placeholder="Atatürk Caddesi" /></label>
          <label>Dış kapı<input value={address.doorNo} onChange={(event) => setAddress({ ...address, doorNo: event.target.value })} placeholder="17/A" /></label>
          <label>İç kapı<input value={address.unitNo} onChange={(event) => setAddress({ ...address, unitNo: event.target.value })} placeholder="Varsa" /></label>
          <label className="relation-wide">CBS adres kimliği<input value={address.externalId} onChange={(event) => setAddress({ ...address, externalId: event.target.value })} placeholder="Kent Rehberi kimliği (varsa)" /></label>
        </div>
        <p className="relation-hint">Mahalle, yol veya kapı numarasından en az biri gereklidir.</p>
        <button className="relation-submit" type="submit" disabled={busy || !(address.neighborhood.trim() || address.street.trim() || address.doorNo.trim())}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />} İlişkiyi kaydet
        </button>
      </form> : null}
    </div> : null}
  </section>;
}
