# Kurum içi port P6 — Node API sunucusu imajı.
#
# Sunucu grafiği yalnız node: yerleşiklerini ve depo içi modülleri kullanır;
# npm bağımlılığı ve derleme adımı YOKTUR (Node 22.18+ TS tiplerini soyar).
# İmaj bu yüzden yalnız kaynak kopyasıdır: küçük yüzey, hızlı yeniden üretim.
#
# Derleme (depo kökünden):
#   docker build -f server/Dockerfile -t sivas-arsiv-api .
#
# Çalıştırma yapılandırması lib/node-runtime.ts başlığındaki ortam
# değişkenleriyle verilir; SQLite verisi /veri birimindedir ve yedeklenmelidir.

FROM node:22-slim

# Sağlık probu ve saat dilimi dışında ek paket gerekmez.
ENV NODE_ENV=production \
    ARCHIVE_DB_PATH=/veri/arsiv.db \
    ARCHIVE_HTTP_HOST=0.0.0.0 \
    ARCHIVE_HTTP_PORT=8788

WORKDIR /app
COPY package.json ./package.json
COPY lib ./lib
COPY app/api ./app/api
COPY server ./server

# SQLite birimi konteynerden bağımsız yaşar; node kullanıcısı yazabilmeli.
RUN mkdir -p /veri && chown -R node:node /veri /app
USER node
VOLUME /veri
EXPOSE 8788

# Canlılık: süreç HTTP yanıtı veriyor mu (dış servisler kapalıyken 503 normaldir).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8788/api/health').then((r)=>process.exit(r.status<600?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/main.ts"]
