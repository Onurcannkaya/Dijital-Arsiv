import type { Metadata } from "next";
import { ArchiveWorkspace } from "./workspace";
import "./archive.css";

export const metadata: Metadata = {
  title: "Sivas Arşiv | Çalışma Alanı",
  description: "Sivas Belediyesi dijital arşiv, OCR ve belge doğrulama çalışma alanı.",
};

export default function ArchivePage() {
  return <ArchiveWorkspace />;
}
