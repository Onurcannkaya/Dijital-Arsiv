# SSO Katmanı (P5): oauth2-proxy + Keycloak

Kimlik sınırı sözleşmesi: uygulama `oai-authenticated-user-email` başlığına
güvenir ve bu başlığı YALNIZ ters vekil verebilir. Bu kaplama, vekile OIDC
doğrulaması (oauth2-proxy ↔ Keycloak ↔ Active Directory) bağlar.

## Akış

```
Kullanıcı ──> nginx (8080)
               ├─ /oauth2/*  ────────────> oauth2-proxy ↔ Keycloak (↔ AD/LDAP)
               ├─ diğer yollar: auth_request /oauth2/auth
               │    doğrulandı  → oai-authenticated-user-email = SSO e-postası → api
               │    doğrulanmadı→ 302 /oauth2/start (giriş sayfası)
               └─ X-Acceptance-Proxy-Token eşleşirse (yalnız staging):
                    istemcinin sentetik oai-* başlığı AYNEN geçer → api
```

Kabul geçidi fail-closed'dur: `ACCEPTANCE_PROXY_TOKEN` boşsa nginx şablon
üretimi çift map anahtarıyla bozulur ve vekil hiç açılmaz; jeton yalnız
staging kabul koşusuna dağıtılır, üretim .env'inde rastgele tutulup kimseye
verilmez. Yürütücüler jetonu `ACCEPTANCE_PROXY_TOKEN` ortam değişkeninden
otomatik gönderir (scripts/acceptance-executors/contract.mjs).

## Kurulum

1. `.env` dosyasına SSO bölümünü doldurun (`../.env.example` şablonundan):

```bash
openssl rand -hex 32                       # ACCEPTANCE_PROXY_TOKEN
openssl rand -base64 32 | tr -- '+/' '-_'  # SSO_COOKIE_SECRET
```

2. Kimlik sağlayıcısını seçin:

   **A) Kurumda Keycloak zaten varsa** — `keycloak/sivas-arsiv-realm.json`
   dosyasını mevcut sunucuya içe aktarın (Realm settings → Partial import),
   `arsiv-vekil` istemci sırrını yeniden üretin ve `.env` içindeki
   `SSO_ISSUER_URL`'i gerçek realm adresine çevirin. Bu durumda `keycloak`
   servisi hiç başlatılmaz.

   **B) Pilot Keycloak** — kaplamayı `kimlik-yerel` profiliyle açın:

```bash
docker compose -f docker-compose.yml -f docker-compose.sso.yml --profile kimlik-yerel up -d --build
```

   İlk açılışta realm otomatik içe aktarılır; yönetim arayüzü
   `http://<makine>:8081` (bootstrap yöneticisi .env'den). Realm'deki istemci
   sırrı YER TUTUCUDUR: Clients → arsiv-vekil → Credentials'tan yeniden
   üretip `.env` `SSO_CLIENT_SECRET` değerine yazın.

3. Active Directory federasyonu (kurumsal): Keycloak → User federation →
   "ldap" sağlayıcısı ekleyin (AD vendor), bind hesabı olarak salt-okunur bir
   servis hesabı kullanın, e-posta özniteliğinin (`mail`) eşlendiğini
   doğrulayın. Uygulama kullanıcıyı e-postayla eşler (`archive_users`);
   AD'deki hesap adı değil E-POSTA yetkili anahtardır.

4. Üretimde kurum sertifikasının ve anahtarının mutlak yollarını `.env`
   `ARCHIVE_TLS_CERT_FILE/_KEY_FILE` alanlarına yazın. Anahtar world-readable
   olmamalıdır. SSO + TLS kaplamalarını birlikte başlatın:

```bash
docker compose -f docker-compose.yml -f docker-compose.sso.yml \
  -f docker-compose.tls.yml up -d --build proxy oauth2-proxy tls-edge
curl -k -s -o /dev/null -w '%{http_code}\n' \
  https://127.0.0.1/api/documents   # 302 (girişe yönlendirme)
```

   Tarayıcıdan `https://arsiv.sivas.bel.tr` → Keycloak giriş ekranı → başarılı
   girişte `/api/me` kullanıcı e-postasını göstermelidir.

## Yetkilendirme modeli

SSO yalnız KİMLİĞİ doğrular; yetki uygulamadadır (`archive_users` rolleri).
İlk yönetici `ARCHIVE_ADMIN_EMAILS` listesinden bootstrap olur; sonrası
uygulama içinden rol atamasıyla yürür. AD grubu → arşiv rolü eşlemesi
istenirse Keycloak group-mapper + uygulama tarafı senkronu ayrı bir iştir ve
bilinçli olarak bu kaplamanın dışındadır.

## Üretim notları

- `SSO_COOKIE_SECURE=true` ve `ARCHIVE_EXTERNAL_SCHEME=https` kalmalıdır.
  Yönlendirme şeması istemcinin `X-Forwarded-Proto` başlığından alınmaz;
  dağıtım kapısı TLS/SSO dosyalarını ve kanonik callback adresini doğrular.
- oauth2-proxy ve Keycloak imaj sürümleri sabitlenmiştir; güncellemeler
  değişiklik yönetimiyle yapılır.
- Kabul koşusu bittiğinde `ACCEPTANCE_PROXY_TOKEN` döndürülür (rotate);
  jeton kanıt dosyalarına ve loglara yazılmaz.
