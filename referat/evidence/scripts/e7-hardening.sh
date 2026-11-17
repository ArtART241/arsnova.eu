#!/usr/bin/env bash
# E7 (5C): Härtungs- und Erreichbarkeitsmatrix der laufenden Laborinstanz.
# Prüft nur lokal (Podman-Labor); gibt keine Secret-Werte aus, nur Schlüsselnamen und Statuscodes.
#   bash referat/evidence/scripts/e7-hardening.sh > referat/evidence/data/e7-hardening-<ref>.txt
set -u
APP=arsnova-v3-app
SIDECARS=(arsnova-v3-pdf-worker arsnova-v3-spacy arsnova-v3-open-weight-llm)

echo "# E7 Härtungsmatrix  $(date -u +%FT%TZ)"
echo "## Container-Konfiguration (podman inspect)"
for c in "$APP" "${SIDECARS[@]}"; do
  podman inspect -f "$c network={{.HostConfig.NetworkMode}} readOnly={{.HostConfig.ReadonlyRootfs}} capDrop={{.HostConfig.CapDrop}} capAdd={{.HostConfig.CapAdd}} secOpt={{.HostConfig.SecurityOpt}} pids={{.HostConfig.PidsLimit}} memMiB={{.HostConfig.Memory}} user={{.Config.User}}" "$c"
done

echo "## Effektive Capabilities (CapEff aus /proc/1/status)"
for c in "$APP" "${SIDECARS[@]}"; do
  printf '%s %s\n' "$c" "$(podman exec "$c" sh -c 'grep CapEff /proc/1/status' 2>&1)"
done

echo "## Schreibversuch ins Root-Dateisystem"
for c in "$APP" "${SIDECARS[@]}"; do
  printf '%s %s\n' "$c" "$(podman exec "$c" sh -c 'touch /e7-write-probe 2>&1 && echo WRITABLE || true' | head -1)"
done

echo "## Ausführung aus /tmp (tmpfs noexec)"
for c in "$APP" "${SIDECARS[@]}"; do
  printf '%s %s\n' "$c" "$(podman exec "$c" sh -c 'printf "#!/bin/sh\necho EXEC_OK\n" > /tmp/e7.sh && chmod +x /tmp/e7.sh && /tmp/e7.sh 2>&1; rm -f /tmp/e7.sh' | head -1)"
done

echo "## Ausgehende Verbindung aus Sidecars (network_mode: none erwartet Fehlschlag)"
NET_JS="$(cat <<'JS'
require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log('BLOCKED '+e.code);process.exit(0)}).on('timeout',()=>{console.log('BLOCKED timeout');process.exit(0)})
JS
)"
printf 'arsnova-v3-pdf-worker %s\n' "$(podman exec arsnova-v3-pdf-worker /usr/local/bin/node -e "$NET_JS" 2>&1 | head -1)"
for c in arsnova-v3-spacy arsnova-v3-open-weight-llm; do
  printf '%s %s\n' "$c" "$(podman exec "$c" python3 -c "
import socket
s=socket.socket(); s.settimeout(3)
try:
    s.connect(('1.1.1.1',443)); print('CONNECTED')
except Exception as e:
    print('BLOCKED', type(e).__name__, e)
" 2>&1 | head -1)"
done
printf 'arsnova-v3-app (Vergleich, im Bridge-Netz) %s\n' "$(podman exec "$APP" node -e "$NET_JS" 2>&1 | head -1)"

echo "## Umgebungsvariablen der Sidecars (nur Schlüsselnamen; Secrets erwartet: keine)"
for c in "${SIDECARS[@]}"; do
  printf '%s %s\n' "$c" "$(podman exec "$c" sh -c 'env | cut -d= -f1 | sort | tr "\n" " "')"
done
printf 'arsnova-v3-pdf-worker hat DATABASE_URL/ADMIN_SECRET/JWT_SECRET: %s\n' \
  "$(podman exec arsnova-v3-pdf-worker sh -c 'env | grep -cE "^(DATABASE_URL|ADMIN_SECRET|JWT_SECRET|REDIS_URL)="')"

echo "## llama-server über Unix-Socket aus dem App-Container (Token-Prüfung)"
podman exec -i "$APP" node - <<'NODE'
const http = require('node:http');
const sock = process.env.OPEN_WEIGHT_LLM_SOCKET_PATH;
const good = process.env.OPEN_WEIGHT_LLM_TOKEN;
const probe = (method, path, auth, body) =>
  new Promise((resolve) => {
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${auth}`;
    const req = http.request({ socketPath: sock, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (e) => resolve(`ERR ${e.code}`));
    if (body) req.write(body);
    req.end();
  });
(async () => {
  const chat = JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
  const rows = [
    ['GET', '/health', null, null, 'ohne Token'],
    ['GET', '/slots', null, null, 'ohne Token'],
    ['GET', '/slots', 'x'.repeat(43), null, 'falsches Token'],
    ['GET', '/slots', good, null, 'gültiges Token'],
    ['POST', '/v1/chat/completions', null, chat, 'ohne Token'],
    ['POST', '/v1/chat/completions', 'x'.repeat(43), chat, 'falsches Token'],
    ['GET', '/', null, null, 'Web-UI ohne Token'],
    ['GET', '/', good, null, 'Web-UI mit Token'],
    ['GET', '/props', good, null, 'props mit Token'],
    ['GET', '/metrics', good, null, 'metrics mit Token'],
  ];
  for (const [m, p, a, b, label] of rows) console.log(`${m} ${p} (${label}) -> ${await probe(m, p, a, b)}`);
  console.log(`Socket-Mount im App-Container schreibgeschützt: ${require('node:fs').statSync(require('node:path').dirname(sock)).mode.toString(8)}`);
})();
NODE

echo "## Veröffentlichte Ports"
podman port "$APP"
for c in "${SIDECARS[@]}"; do printf '%s: %s\n' "$c" "$(podman port "$c" | tr '\n' ' ')"; done
