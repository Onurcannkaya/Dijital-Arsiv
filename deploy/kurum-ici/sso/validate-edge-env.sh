#!/bin/sh
set -eu

case "${APP_ENV:-}" in
  staging)
    if [ "${ARCHIVE_ACCEPTANCE_BYPASS_ENABLED:-}" != "enabled" ]; then
      echo "HATA: staging kabul geçidi açıkça enabled olmalıdır" >&2
      exit 1
    fi
    if [ "${#ACCEPTANCE_PROXY_TOKEN}" -lt 32 ]; then
      echo "HATA: staging kabul geçidi jetonu en az 32 karakter olmalıdır" >&2
      exit 1
    fi
    ;;
  production)
    if [ "${ARCHIVE_ACCEPTANCE_BYPASS_ENABLED:-}" != "disabled" ]; then
      echo "HATA: production kabul geçidi kapalı olmalıdır" >&2
      exit 1
    fi
    if [ -n "${ACCEPTANCE_PROXY_TOKEN:-}" ]; then
      echo "HATA: production kabul geçidi jetonu tanımlanamaz" >&2
      exit 1
    fi
    ;;
  *)
    echo "HATA: SSO vekili yalnız staging veya production ortamında açılır" >&2
    exit 1
    ;;
esac

exec /docker-entrypoint.sh "$@"
