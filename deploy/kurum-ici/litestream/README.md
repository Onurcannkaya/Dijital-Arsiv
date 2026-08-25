# SQLite PITR ve güvenli geri yükleme tatbikatı

Bu profil, `/veri/arsiv.db` WAL akışını API makinesinden ve birincil MinIO'dan
bağımsız bir S3 uyumlu hata alanına çoğaltır. Varsayılan compose çalışmasında
kapalıdır; staging/üretim için `.env` içinde `COMPOSE_PROFILES=pitr` yazılır.

## Depolama kimliği

Çalışan Litestream kimliği yalnız hedef kovayı listeleme, konumunu okuma ve
LTX nesnelerini okuma/yazma yetkisi alır. `DeleteObject`, politika/retention ve
kova yönetimi verilmez. Sağlayıcı yaşam döngüsü ile kurumsal saklama kararı
ayrı yönetici kimliği tarafından uygulanır. Örnek politika:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::KURUM_SQLITE_PITR_KOVASI"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::KURUM_SQLITE_PITR_KOVASI/sivas-arsiv/*"]
    }
  ]
}
```

API ve Litestream aynı `api-veri` Docker birimini paylaşır. Bu birim yerel
Linux blok diski olmalıdır; NFS/SMB, Windows ana makine bind mount'u veya iki
ayrı makine arasında paylaşılan dosya sistemi desteklenen topoloji değildir.

## Zarar vermeyen geri yükleme tatbikatı

Tatbikat çalışan `/veri/arsiv.db` dosyasına hiçbir zaman yazmaz. Boş, ayrı bir
dizine en son nokta geri yüklenir:

```bash
cd /opt/sivas-arsiv/deploy/kurum-ici
export RESTORE_DRILL_DIR="/var/lib/sivas-arsiv/restore-drill/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$RESTORE_DRILL_DIR"

docker compose --env-file .env --profile pitr run --rm --no-deps \
  -v "$RESTORE_DRILL_DIR:/restore" \
  litestream restore -config /etc/litestream.yml -integrity-check full \
  -json -o /restore/arsiv-restore.db /veri/arsiv.db \
  > "$RESTORE_DRILL_DIR/litestream-result.json"

node ../../scripts/verify-sqlite-restore.mjs \
  "$RESTORE_DRILL_DIR/arsiv-restore.db" \
  > "$RESTORE_DRILL_DIR/application-verification.json"
sha256sum "$RESTORE_DRILL_DIR/arsiv-restore.db" \
  > "$RESTORE_DRILL_DIR/arsiv-restore.db.sha256"
```

Ardından son iş kayıtları ve seçilmiş belge üst verileri canlı sistemdeki
salt-okunur sorgu sonuçlarıyla karşılaştırılır. Çıktı dizini, koşu zamanı,
Litestream imaj özeti ve alarm heartbeat kaydı T-09 kanıt paketine alınır.
Temsili üretim boyutunda bu tatbikat başarılı olmadan
`SQLITE_PITR_RESTORE_DRILL_APPROVED=approved-representative-restore` yazılmaz;
üretim dağıtım kapısı aksi durumda kapanır.

Gerçek felaket geri dönüşü ayrı değişiklik/onay prosedürüdür. Tatbikat komutu
bilinçli olarak `-force` kullanmaz ve canlı dosyayı hedeflemez.
