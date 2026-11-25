# Хук для zap-api-scan.py: прогон «с токеном обычного пользователя».
# Токен доступа живёт 10 минут, а активное сканирование идёт дольше, поэтому хук
# входит под заявителем (stud001) и каждые 4 минуты обновляет правило Replacer,
# которое добавляет заголовок Authorization ко всем запросам сканера.
# Выход (OP-15) исключён: он завершил бы сессию самого сканера — проверен вручную.
import json, os, ssl, threading, time, urllib.request

LOGIN_URL = os.environ.get("ZAP_LOGIN_URL", "https://api-gateway:8443/api/v1/auth/login")
CA_FILE = os.environ.get("ZAP_CA_FILE", "/zap/wrk/gateway.crt")
RULE = "lab5-bearer"


def _token():
    ctx = ssl.create_default_context(cafile=CA_FILE)   # проверка сертификата шлюза не отключается
    body = json.dumps({"login": os.environ["ZAP_USER"], "password": os.environ["ZAP_PASSWORD"]}).encode()
    req = urllib.request.Request(LOGIN_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
        return json.load(r)["access_token"]


def _install(zap):
    tok = _token()
    try:
        zap.replacer.remove_rule(RULE)
    except Exception:
        pass
    zap.replacer.add_rule(description=RULE, enabled="true", matchtype="REQ_HEADER", matchregex="false",
                          matchstring="Authorization", replacement="Bearer " + tok,
                          url="^(?!.*/auth/logout).*$")
    print("[lab5-hook] токен доступа обновлён", time.strftime("%H:%M:%S"), flush=True)


def zap_started(zap, target):
    _install(zap)
    zap.ascan.exclude_from_scan(".*/auth/logout.*")

    def loop():
        while True:
            time.sleep(240)
            try:
                _install(zap)
            except Exception as e:  # noqa: BLE001
                print("[lab5-hook] не удалось обновить токен:", e, flush=True)

    threading.Thread(target=loop, daemon=True).start()
