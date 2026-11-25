"""Record two ZAP passive runs on ordinary requests to the local applicant UI."""
import http.client
import json
from pathlib import Path
import ssl
import subprocess

repo = Path(__file__).resolve().parents[3]
out = repo / "docs/lab5/after/zap-passive"
out.mkdir(exist_ok=True)
origin = "http://applicant-web:8080"
api = "/api/v1"


def auth(endpoint, body, token=None):
    tls = ssl.create_default_context(cafile=str(repo / "secrets/gateway.crt"))
    client = http.client.HTTPSConnection("localhost", 8443, context=tls, timeout=15)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        client.request("POST", api + "/auth/" + endpoint, json.dumps(body), headers)
        response = client.getresponse()
        data = response.read()
        if response.status not in (200, 204):
            raise RuntimeError(f"{endpoint}: HTTP {response.status}")
        return json.loads(data) if data else {}
    finally:
        client.close()


def scan(name, token=None):
    paths = [("/", 200), ("/api.js", 200), (api + "/applications", 200 if token else 401),
             (api + "/campaigns", 200 if token else 401)]
    requests = []
    for path, status in paths:
        request = {"url": origin + path, "method": "GET", "responseCode": status}
        if token and path.startswith(api):
            request["headers"] = ["Authorization: Bearer " + token]
        requests.append(request)
    plan = {
        "env": {"contexts": [{"name": "local", "urls": [origin]}]},
        "jobs": [{"type": "requestor", "requests": requests},
                 {"type": "passiveScan-wait", "parameters": {"maxDuration": 2}},
                 {"type": "report", "parameters": {"template": "traditional-json", "reportDir": "/zap/wrk",
                                                    "reportFile": name + ".json", "reportTitle": name}}],
    }
    command = ["docker", "run", "--rm", "-i", "--pull", "never", "--network", "scholarship_frontend",
               "-v", str(out) + ":/zap/wrk", "ghcr.io/zaproxy/zaproxy:stable",
               "sh", "-c", "umask 077; cat >/tmp/passive.yaml && zap.sh -silent -cmd -autorun /tmp/passive.yaml"]
    result = subprocess.run(command, input=json.dumps(plan).encode(), capture_output=True, timeout=180)
    log = (result.stdout + result.stderr).decode("utf-8", errors="replace")
    if token:
        log = log.replace(token, "[redacted]")
    (out / (name + ".txt")).write_text(log, encoding="utf-8")
    if result.returncode != 0 or not (out / (name + ".json")).exists():
        raise RuntimeError(f"ZAP {name}: exit {result.returncode}; see saved log")


if __name__ == "__main__":
    scan("guest")
    env = dict(line.split("=", 1) for line in (repo / ".env").read_text().splitlines()
               if line.strip() and not line.startswith("#") and "=" in line)
    token = auth("login", {"login": "stud002", "password": env["DEMO_USERS_PASSWORD"]})["access_token"]
    try:
        scan("applicant", token)
    finally:
        auth("logout", {}, token)
