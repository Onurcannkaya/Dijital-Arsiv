#!/bin/sh
# İçerik tarama servisi girişi (kurum içi port P7).
#
# İmza tazeliği çalışma zamanı sorumluluğudur: servis, imza veritabanı 24
# saatten eskiyse fail-closed kapanır (app/main.py signature_state). İmajdaki
# derleme-anı imzaları yalnız ilk açılışı kurtarır; bu giriş betiği açılışta
# ve periyodik olarak freshclam çalıştırır. Kapalı ağda FRESHCLAM_MIRROR
# kurum içi imza aynasına (ör. cvdupdate beslemeli HTTP sunucusu) yöneltilir.
set -eu

CONFIG=/opt/scanner/freshclam.conf
MIRROR="${FRESHCLAM_MIRROR:-database.clamav.net}"
INTERVAL_HOURS="${FRESHCLAM_INTERVAL_HOURS:-6}"

cat > "$CONFIG" <<CONF
DatabaseDirectory /var/lib/clamav
DatabaseMirror ${MIRROR}
LogVerbose no
CONF

update() {
  if freshclam --config-file="$CONFIG" --stdout; then
    echo "freshclam: imza guncellemesi tamam"
  else
    # Guncelleme basarisizligi olumcul degildir: eldeki imzalar 24 saatten
    # gencse servis calismayi surdurur, degilse health/scan fail-closed olur.
    echo "freshclam: guncelleme basarisiz; mevcut imzalarla devam" >&2
  fi
}

update
(
  while true; do
    sleep "$((INTERVAL_HOURS * 3600))"
    update
  done
) &

exec "$@"
