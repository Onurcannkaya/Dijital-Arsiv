# Drizzle göç dosyaları — 0.1 sürümünde donduruldu

`0000`–`0005` arası dosyalar şema sürümü 1'in (tek değerli `extracted_fields`)
geçmiş kaydıdır. Bu zincir **hiçbir zaman otomatik uygulanmadı**: `package.json`
içinde bir `db:migrate` adımı, `wrangler` tarafında da bir migrations
yapılandırması bulunmuyor. Şema, `lib/archive-schema.ts` tarafından kurulur,
`schema_state.version` ile sürümlenir ve korumalı `POST /api/admin/migrate` uç
noktasından uygulanır. Sites paketleyicisi bu tarihsel dizini dağıtım paketine
kopyalamaz.

## Neden donduruldu?

Şema sürümü 2'de `extracted_fields` çoklu değer modeline geçti; türetilebilir
`needs_review` kolonu kaldırıldı. `drizzle-kit generate` bu değişikliği
"kolon yeniden mi adlandırıldı?" sorusuyla etkileşimli olarak çözmek istiyor ve
TTY olmayan ortamlarda çalışamıyor. İki ayrı DDL kaynağını elle senkron tutmak,
kayıt yönetimi sisteminde sessiz sapma riski demektir.

## Bugünkü düzen

| Artefakt | Rolü |
|---|---|
| `lib/archive-schema.ts` | **Yetkili DDL kaynağı.** Tablolar, indeksler, kısıtlar, tetikleyiciler ve sürümlü göçler. |
| `db/schema.ts` | Drizzle tip tanımı ve kısıt niyetinin okunabilir kaydı. Sorgu üretiminde kullanılmıyor. |
| `drizzle/0000`–`0005` | Şema sürümü 1'in tarihsel kaydı. |

İki tanımın aynı tabloları içermesi `tests/schema-contract.test.mjs` ile
denetlenir. Yol haritası maddesi 12'de (PostgreSQL geçişi) tek kaynağa
indirilecek; o noktada göç zinciri baştan kurulacaktır.
