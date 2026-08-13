import { jsonError } from "./http.ts";

export type ArchiveRole = "admin" | "archive_manager" | "reviewer" | "viewer";
/**
 * `document.read` üst veriyi ve belge görüntülemeyi açar; `document.download`
 * dosyanın indirilmesini ayrı olarak yetkilendirir.
 * KENT_REHBERI_ENTEGRASYON_SOZLESMESI.md §11: "Belge listesi, özet alanları,
 * görüntüleme ve indirme ayrı yetkilerdir."
 */
export type ArchivePermission =
  | "document.read" | "document.download" | "document.upload"
  | "document.review" | "document.archive" | "ocr.run" | "users.manage"
  /*
   * design.md §9.3 kararı: teknik gösterimler (güven yüzdesi, kanıt
   * koordinatı, SHA-256, model/profil sürümü) yetkiyle ERİŞİLİR, tercihle
   * AÇILIR. Bu yetki erişim tarafıdır: kimlerin "Teknik görünüm" anahtarını
   * görebileceğini belirler; açık/kapalı durumu kullanıcı tercihidir ve
   * sunucuda tutulmaz. Doğrulayıcı ve görüntüleyici rollerine verilmez ki
   * personel ekranının eylem dili (§6) sayılarla sulanmasın.
   */
  | "technical.view";
export type ArchivePrincipal = { email:string; displayName:string; role:ArchiveRole; unit:string; permissions:ArchivePermission[] };

type UserRow = { email:string; display_name:string; role:ArchiveRole; unit:string; active:number };

/**
 * Rol-yetki eşlemesi kurumun görev ayrılığı kararıyla kesinleşir
 * (ANA_SISTEM_TASARIM_BELGESI.md §5). Buradaki dağılım en az ayrıcalık
 * varsayımıdır: indirme yalnız arşiv sorumluluğu olan rollere verilir;
 * doğrulayıcı belgeyi görüntüleyerek karşılaştırır.
 */
const permissionMap: Record<ArchiveRole, ArchivePermission[]> = {
  admin: ["document.read", "document.download", "document.upload", "document.review", "document.archive", "ocr.run", "users.manage", "technical.view"],
  archive_manager: ["document.read", "document.download", "document.upload", "document.review", "document.archive", "ocr.run", "technical.view"],
  reviewer: ["document.read", "document.review"],
  viewer: ["document.read"],
};

/**
 * E-posta adresini karşılaştırma için sadeleştirir.
 *
 * Türkçe locale küçültmesi kullanılmaz: `"IBRAHIM"` değeri `tr` kuralıyla
 * `"ıbrahim"` olur ve veritabanındaki `ibrahim@...` kaydıyla asla eşleşmez.
 * E-posta adresi ASCII'dir; locale bağımsız küçültme doğru olanıdır.
 */
export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function identityFromRequest(request: Request) {
  const rawEmail = request.headers.get("oai-authenticated-user-email");
  const emailHeader = rawEmail ? normalizeEmail(rawEmail) : undefined;
  const hostname = new URL(request.url).hostname;
  const localFallback = !emailHeader && (hostname === "localhost" || hostname === "127.0.0.1");
  const email = emailHeader || (localFallback ? "yerel-pilot@sivas.bel.tr" : "");
  if (!email) return null;
  let displayName = localFallback ? "Yerel Pilot Yönetici" : email.split("@")[0];
  const encodedName = request.headers.get("oai-authenticated-user-full-name")?.trim();
  if (encodedName && request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { displayName = decodeURIComponent(encodedName); } catch { /* E-posta adı güvenli geri dönüş olarak kalır. */ }
  }
  return { email, displayName, localFallback };
}

function bootstrapEmails(value?: string) {
  return new Set((value ?? "").split(",").map(normalizeEmail).filter(Boolean));
}

export async function authorizeRequest(request: Request, db: D1Database, permission: ArchivePermission, configuredAdmins?: string): Promise<ArchivePrincipal | Response> {
  const identity = identityFromRequest(request);
  if (!identity) return jsonError("Bu işlem için doğrulanmış oturum gereklidir.", 401);
  const mayBootstrap = identity.localFallback || bootstrapEmails(configuredAdmins).has(identity.email);
  let row = await db.prepare(`SELECT email, display_name, role, unit, active FROM archive_users WHERE email = ?`).bind(identity.email).first<UserRow>();
  if (!row && mayBootstrap) {
    await db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, ?, 'admin', '*', 1) ON CONFLICT(email) DO NOTHING`).bind(identity.email, identity.displayName).run();
    row = await db.prepare(`SELECT email, display_name, role, unit, active FROM archive_users WHERE email = ?`).bind(identity.email).first<UserRow>();
  }
  if (row && identity.localFallback && row.display_name !== identity.displayName) {
    await db.prepare("UPDATE archive_users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(identity.displayName, identity.email).run();
    row.display_name = identity.displayName;
  }
  if (!row || !row.active) return jsonError("Bu arşiv çalışma alanına erişim yetkiniz bulunmuyor.", 403);
  const permissions = permissionMap[row.role] ?? [];
  if (!permissions.includes(permission)) return jsonError("Bu işlem rolünüz için yetkili değildir.", 403);
  return { email:row.email, displayName:row.display_name, role:row.role, unit:row.unit, permissions };
}

export function canAccessUnit(principal: ArchivePrincipal, unit: string) {
  return principal.unit === "*" || principal.unit === unit;
}

export function roleLabel(role: ArchiveRole) {
  return ({ admin:"Sistem Yöneticisi", archive_manager:"Arşiv Yöneticisi", reviewer:"Belge Doğrulayıcı", viewer:"Arşiv Görüntüleyici" } as const)[role];
}