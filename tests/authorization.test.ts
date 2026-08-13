import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeRequest, canAccessUnit, normalizeEmail, roleLabel,
  type ArchivePermission, type ArchivePrincipal, type ArchiveRole,
} from "../lib/authorization.ts";

/**
 * Yetkilendirme davranış testleri.
 *
 * Bu testler dize araması yapmaz: `authorizeRequest` gerçekten çağrılır ve
 * kararı doğrulanır. Veritabanı yerine, çağrılan SQL'i tanıyan küçük bir D1
 * taklidi kullanılır.
 */

type UserRow = { email: string; display_name: string; role: ArchiveRole; unit: string; active: number };

function fakeDatabase(users: UserRow[]) {
  const rows = new Map(users.map((user) => [user.email, { ...user }]));
  const inserted: string[] = [];
  const database = {
    inserted,
    rows,
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async first<T>() {
          if (sql.includes("SELECT email, display_name, role, unit, active")) {
            return (rows.get(String(statement.args[0])) ?? null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (sql.includes("INSERT INTO archive_users")) {
            const email = String(statement.args[0]);
            inserted.push(email);
            rows.set(email, { email, display_name: String(statement.args[1]), role: "admin", unit: "*", active: 1 });
          }
          if (sql.includes("UPDATE archive_users SET display_name")) {
            const existing = rows.get(String(statement.args[1]));
            if (existing) existing.display_name = String(statement.args[0]);
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
  return database as unknown as D1Database & { inserted: string[]; rows: Map<string, UserRow> };
}

function requestFor(email: string | null, { host = "arsiv.sivas.bel.tr" } = {}) {
  const headers = new Headers();
  if (email) headers.set("oai-authenticated-user-email", email);
  return new Request(`https://${host}/api/documents`, { headers });
}

async function decide(
  users: UserRow[],
  email: string | null,
  permission: ArchivePermission = "document.read",
  options: { host?: string; admins?: string } = {},
) {
  const db = fakeDatabase(users);
  const result = await authorizeRequest(requestFor(email, { host: options.host }), db, permission, options.admins);
  return { result, db };
}

const everyPermission: ArchivePermission[] = [
  "document.read", "document.download", "document.upload",
  "document.review", "document.archive", "ocr.run", "users.manage",
  "technical.view",
];

/** ANA_SISTEM_TASARIM_BELGESI.md §5 rollerinin beklenen yetki kümesi.
 * `technical.view` design.md §9.3 kararıdır: teknik gösterimler (yüzde,
 * koordinat, SHA-256, sürüm) yalnız yönetici ve arşiv sorumlusuna erişilir;
 * doğrulayıcı/görüntüleyici ekranı eylem dilinde kalır. */
const expected: Record<ArchiveRole, ArchivePermission[]> = {
  admin: everyPermission,
  archive_manager: ["document.read", "document.download", "document.upload", "document.review", "document.archive", "ocr.run", "technical.view"],
  reviewer: ["document.read", "document.review"],
  viewer: ["document.read"],
};

function userWith(role: ArchiveRole, unit = "*"): UserRow {
  return { email: `${role}@sivas.bel.tr`, display_name: role, role, unit, active: 1 };
}

test("her rol yalnız kendi yetkisini kullanabilir", async () => {
  for (const role of Object.keys(expected) as ArchiveRole[]) {
    const user = userWith(role);
    for (const permission of everyPermission) {
      const { result } = await decide([user], user.email, permission);
      const allowed = expected[role].includes(permission);
      if (allowed) {
        assert.ok(!(result instanceof Response), `${role} için ${permission} reddedildi`);
        assert.equal((result as ArchivePrincipal).role, role);
      } else {
        assert.ok(result instanceof Response, `${role} için ${permission} izin verildi`);
        assert.equal((result as Response).status, 403, `${role}/${permission} yanlış durum kodu`);
      }
    }
  }
});

test("görüntüleyici belgeyi indiremez, doğrulayıcı arşivleyemez", async () => {
  const viewer = userWith("viewer");
  const download = await decide([viewer], viewer.email, "document.download");
  assert.ok(download.result instanceof Response);
  assert.equal((download.result as Response).status, 403);

  const reviewer = userWith("reviewer");
  const archive = await decide([reviewer], reviewer.email, "document.archive");
  assert.ok(archive.result instanceof Response);
  assert.equal((archive.result as Response).status, 403);
});

test("kimlik başlığı yoksa oturum reddedilir", async () => {
  const { result } = await decide([userWith("admin")], null);
  assert.ok(result instanceof Response);
  assert.equal((result as Response).status, 401);
});

test("kayıtlı olmayan kullanıcı erişemez", async () => {
  const { result } = await decide([], "bilinmeyen@sivas.bel.tr", "document.read");
  assert.ok(result instanceof Response);
  assert.equal((result as Response).status, 403);
});

test("pasif hesap erişemez", async () => {
  const passive: UserRow = { ...userWith("admin"), active: 0 };
  const { result } = await decide([passive], passive.email, "document.read");
  assert.ok(result instanceof Response);
  assert.equal((result as Response).status, 403);
});

test("Türkçe locale küçültmesi kimliği bozmamalıdır", async () => {
  // `"IBRAHIM"` değeri `tr` kuralıyla `"ıbrahim"` olur ve kayıtla eşleşmez.
  assert.equal(normalizeEmail("IBRAHIM@Sivas.Bel.TR"), "ibrahim@sivas.bel.tr");
  assert.notEqual("IBRAHIM@sivas.bel.tr".toLocaleLowerCase("tr"), "ibrahim@sivas.bel.tr");

  const user: UserRow = { email: "ibrahim@sivas.bel.tr", display_name: "İbrahim", role: "reviewer", unit: "*", active: 1 };
  const { result } = await decide([user], "IBRAHIM@sivas.bel.tr", "document.review");
  assert.ok(!(result instanceof Response), "büyük I içeren e-posta eşleşmedi");
  assert.equal((result as ArchivePrincipal).email, "ibrahim@sivas.bel.tr");
});

test("yalnız yapılandırılmış ilk yöneticiler kendiliğinden oluşturulur", async () => {
  const allowed = await decide([], "arsiv.yoneticisi@sivas.bel.tr", "users.manage", {
    admins: "arsiv.yoneticisi@sivas.bel.tr, baska@sivas.bel.tr",
  });
  assert.ok(!(allowed.result instanceof Response));
  assert.deepEqual(allowed.db.inserted, ["arsiv.yoneticisi@sivas.bel.tr"]);

  const refused = await decide([], "yabanci@sivas.bel.tr", "document.read", {
    admins: "arsiv.yoneticisi@sivas.bel.tr",
  });
  assert.ok(refused.result instanceof Response);
  assert.deepEqual(refused.db.inserted, []);
});

test("yerel pilot yöneticisi yalnız localhost üzerinde geçerlidir", async () => {
  const local = await decide([], null, "users.manage", { host: "localhost" });
  assert.ok(!(local.result instanceof Response), "localhost geri dönüşü çalışmadı");
  assert.equal((local.result as ArchivePrincipal).email, "yerel-pilot@sivas.bel.tr");

  const remote = await decide([], null, "users.manage", { host: "arsiv.sivas.bel.tr" });
  assert.ok(remote.result instanceof Response, "üretim ana bilgisayarında geri dönüş çalıştı");
  assert.equal((remote.result as Response).status, 401);
});

test("müdürlük kapsamı yalnız joker veya tam eşleşmeyle açılır", () => {
  const scoped = { email: "a@b", displayName: "a", role: "reviewer" as ArchiveRole, unit: "İtfaiye Müdürlüğü", permissions: [] };
  assert.equal(canAccessUnit(scoped, "İtfaiye Müdürlüğü"), true);
  assert.equal(canAccessUnit(scoped, "İmar ve Şehircilik Müdürlüğü"), false);
  assert.equal(canAccessUnit(scoped, "*"), false);
  assert.equal(canAccessUnit({ ...scoped, unit: "*" }, "İmar ve Şehircilik Müdürlüğü"), true);
});

test("rol etiketleri eksiksizdir", () => {
  for (const role of Object.keys(expected) as ArchiveRole[]) {
    assert.ok(roleLabel(role).length > 0, `${role} etiketi yok`);
  }
});
