#!/usr/bin/env python3
"""Controla a VM e o Minecraft usando Azure CLI no GitHub Actions."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STATUS_FILE = ROOT / "docs" / "status.json"
RESOURCE_GROUP = os.environ["AZURE_RESOURCE_GROUP"]
VM_NAME = os.environ["AZURE_VM_NAME"]
OPERATION = os.environ.get("OPERATION", "status").strip().lower()
REQUEST_ID = os.environ.get("REQUEST_ID", "")
PAYLOAD_B64 = os.environ.get("PAYLOAD_B64", "")

ALLOWED_OPERATIONS = {
    "start",
    "stop",
    "restart",
    "status",
    "apply",
    "command",
    "backup",
    "update",
}


def run(command: list[str], timeout: int = 600) -> str:
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"Comando falhou: {' '.join(command)}")
    return result.stdout.strip()


def azure(*arguments: str, timeout: int = 600) -> str:
    return run(["az", *arguments], timeout=timeout)


def load_previous() -> dict[str, Any]:
    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {
            "vm": {"state": "unknown"},
            "server": {
                "service": "unknown",
                "playersOnline": 0,
                "playersMax": 20,
                "plugins": [],
            },
            "settings": default_settings(),
        }


def default_settings() -> dict[str, Any]:
    return {
        "motd": "Mine-Etec - Java e Bedrock",
        "gamemode": "survival",
        "difficulty": "normal",
        "maxPlayers": 20,
        "spawnProtection": 16,
        "viewDistance": 16,
        "simulationDistance": 6,
        "pvp": True,
        "commandBlocks": False,
        "whitelist": False,
        "onlineMode": False,
        "idleEnabled": True,
        "idleMinutes": 30,
        "serverName": "Mine-Etec",
        "customHost": "",
        "iconBase64": "",
    }


def decode_payload() -> dict[str, Any]:
    if not PAYLOAD_B64:
        return {}
    try:
        decoded = base64.b64decode(PAYLOAD_B64, validate=True).decode("utf-8")
        payload = json.loads(decoded)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Os dados enviados pelo painel são inválidos.") from error
    if not isinstance(payload, dict):
        raise ValueError("Os dados enviados precisam ser um objeto.")
    return payload


def power_state() -> str:
    value = azure(
        "vm",
        "get-instance-view",
        "--resource-group",
        RESOURCE_GROUP,
        "--name",
        VM_NAME,
        "--query",
        "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]",
        "--output",
        "tsv",
    )
    return value.removeprefix("PowerState/").strip().lower() or "unknown"


def public_ip() -> str:
    return azure(
        "vm",
        "list-ip-addresses",
        "--resource-group",
        RESOURCE_GROUP,
        "--name",
        VM_NAME,
        "--query",
        "[0].virtualMachine.network.publicIpAddresses[0].ipAddress",
        "--output",
        "tsv",
    )


def start_vm() -> bool:
    if power_state() == "running":
        return False
    azure(
        "vm",
        "start",
        "--resource-group",
        RESOURCE_GROUP,
        "--name",
        VM_NAME,
        timeout=900,
    )
    return True


def invoke(script: str, timeout: int = 900) -> str:
    raw = azure(
        "vm",
        "run-command",
        "invoke",
        "--resource-group",
        RESOURCE_GROUP,
        "--name",
        VM_NAME,
        "--command-id",
        "RunShellScript",
        "--scripts",
        script,
        "--output",
        "json",
        timeout=timeout,
    )
    result = json.loads(raw)
    return "\n".join(
        str(item.get("message", ""))
        for item in result.get("value", [])
        if item.get("message")
    )


def marker_result(output: str) -> dict[str, Any]:
    match = re.search(r"PANEL_RESULT:([A-Za-z0-9+/=]+)", output)
    if not match:
        cleaned = re.sub(r"\x1b\[[0-9;]*m", "", output).strip()
        raise RuntimeError(
            "A VM não devolveu uma resposta reconhecível."
            + (f" Detalhes: {cleaned[-500:]}" if cleaned else "")
        )
    decoded = base64.b64decode(match.group(1)).decode("utf-8")
    return json.loads(decoded)


REMOTE_STATUS = r"""
set -Eeuo pipefail
python3 - <<'PY'
import base64
import json
import re
import subprocess
from pathlib import Path


def properties(path):
    values = {}
    try:
        for raw in Path(path).read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    except FileNotFoundError:
        pass
    return values


def boolean(value, default=False):
    if value is None:
        return default
    return str(value).lower() == "true"


def integer(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def json_file(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def clean(value):
    value = re.sub(r"\x1b\[[0-9;]*m", "", value or "")
    return re.sub(r"§.", "", value)


server = properties("/opt/minecraft/server.properties")
idle = properties("/etc/minecraft/azure-idle.env")
panel = json_file("/etc/minecraft/panel.json", {})
service = subprocess.run(
    ["systemctl", "is-active", "minecraft.service"],
    capture_output=True,
    text=True,
).stdout.strip() or "unknown"

players_online = 0
players_max = integer(server.get("max-players"), 20)
plugins = []
online_names = []
if service == "active":
    listing = subprocess.run(
        ["/usr/local/bin/mc-rcon", "list"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    listing_text = clean(listing.stdout)
    match = re.search(
        r"There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online",
        listing_text,
        re.IGNORECASE,
    )
    if match:
        players_online = int(match.group(1))
        players_max = int(match.group(2))
        remainder = listing_text[match.end():]
        if ":" in remainder:
            online_names = [
                name.strip()
                for name in remainder.split(":", 1)[1].split(",")
                if name.strip()
            ]

    plugin_result = subprocess.run(
        ["/usr/local/bin/mc-rcon", "plugins"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    plugin_line = clean(plugin_result.stdout)
    if ":" in plugin_line:
        plugins = [
            item.strip().lstrip("*")
            for item in plugin_line.split(":", 1)[1].split(",")
            if item.strip()
        ]

known_names = {}
for item in json_file("/opt/minecraft/usercache.json", []):
    if isinstance(item, dict) and item.get("name"):
        known_names[item["name"].lower()] = item["name"]
for name in online_names:
    known_names[name.lower()] = name

ops = {
    item.get("name", "").lower()
    for item in json_file("/opt/minecraft/ops.json", [])
    if isinstance(item, dict)
}
whitelisted = {
    item.get("name", "").lower()
    for item in json_file("/opt/minecraft/whitelist.json", [])
    if isinstance(item, dict)
}
banned = {
    item.get("name", "").lower()
    for item in json_file("/opt/minecraft/banned-players.json", [])
    if isinstance(item, dict)
}
online = {name.lower() for name in online_names}
for collection in (ops, whitelisted, banned):
    for name in collection:
        known_names.setdefault(name, name)

players = [
    {
        "name": name,
        "online": key in online,
        "op": key in ops,
        "whitelisted": key in whitelisted,
        "banned": key in banned,
    }
    for key, name in sorted(known_names.items(), key=lambda item: item[1].lower())
][:100]

icon_base64 = ""
icon_path = Path("/opt/minecraft/server-icon.png")
if icon_path.exists() and icon_path.stat().st_size <= 100000:
    icon_base64 = "data:image/png;base64," + base64.b64encode(
        icon_path.read_bytes()
    ).decode("ascii")

result = {
    "server": {
        "service": service,
        "playersOnline": players_online,
        "playersMax": players_max,
        "plugins": plugins,
        "players": players,
    },
    "settings": {
        "motd": server.get("motd", "Mine-Etec - Java e Bedrock"),
        "gamemode": server.get("gamemode", "survival"),
        "difficulty": server.get("difficulty", "normal"),
        "maxPlayers": players_max,
        "spawnProtection": integer(server.get("spawn-protection"), 16),
        "viewDistance": integer(server.get("view-distance"), 16),
        "simulationDistance": integer(server.get("simulation-distance"), 6),
        "pvp": boolean(server.get("pvp"), True),
        "commandBlocks": boolean(server.get("enable-command-block"), False),
        "whitelist": boolean(server.get("white-list"), False),
        "onlineMode": boolean(server.get("online-mode"), False),
        "idleEnabled": boolean(idle.get("AZURE_IDLE_DEALLOCATE"), True),
        "idleMinutes": integer(idle.get("IDLE_MINUTES"), 30),
        "serverName": panel.get("serverName", "Mine-Etec"),
        "customHost": panel.get("customHost", ""),
        "iconBase64": icon_base64,
    },
}
encoded = base64.b64encode(
    json.dumps(result, ensure_ascii=False).encode("utf-8")
).decode("ascii")
print("PANEL_RESULT:" + encoded)
PY
"""


REMOTE_WAIT = r"""
set -Eeuo pipefail
for attempt in $(seq 1 90); do
  if /usr/local/bin/mc-rcon "list" >/dev/null 2>&1; then
    exit 0
  fi
  if ! systemctl is-active --quiet minecraft.service; then
    journalctl -u minecraft.service -n 60 --no-pager >&2 || true
    exit 1
  fi
  sleep 2
done
printf 'O Paper não ficou pronto dentro de 180 segundos.\n' >&2
exit 1
"""


def collect_status(state: str | None = None) -> dict[str, Any]:
    current_state = state or power_state()
    previous = load_previous()
    if current_state != "running":
        return {
            "vm": {"state": current_state, "publicIp": public_ip()},
            "server": {
                "service": "inactive",
                "playersOnline": 0,
                "playersMax": previous.get("server", {}).get("playersMax", 20),
                "plugins": previous.get("server", {}).get("plugins", []),
                "players": previous.get("server", {}).get("players", []),
            },
            "settings": previous.get("settings") or default_settings(),
        }
    remote = marker_result(invoke(REMOTE_STATUS))
    return {
        "vm": {"state": current_state, "publicIp": public_ip()},
        "server": remote["server"],
        "settings": remote["settings"],
    }


def validate_settings(payload: dict[str, Any]) -> dict[str, Any]:
    required = set(default_settings())
    missing = required - set(payload)
    if missing:
        raise ValueError(f"Configurações ausentes: {', '.join(sorted(missing))}")

    result = dict(payload)
    result["motd"] = str(result["motd"]).replace("\r", " ").replace("\n", " ")[:100]
    result["serverName"] = (
        str(result["serverName"]).replace("\r", " ").replace("\n", " ").strip()[:40]
    )
    if not result["serverName"]:
        raise ValueError("O nome do servidor não pode ficar vazio.")

    result["customHost"] = str(result["customHost"]).strip().lower().rstrip(".")
    if result["customHost"]:
        if len(result["customHost"]) > 253 or not re.fullmatch(
            r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
            result["customHost"],
        ):
            raise ValueError("O domínio personalizado é inválido.")

    icon_value = str(result["iconBase64"])
    if icon_value:
        prefix = "data:image/png;base64,"
        if not icon_value.startswith(prefix):
            raise ValueError("O ícone precisa ser uma imagem PNG.")
        try:
            icon_bytes = base64.b64decode(icon_value[len(prefix):], validate=True)
        except ValueError as error:
            raise ValueError("Os dados do ícone são inválidos.") from error
        if not icon_bytes.startswith(b"\x89PNG\r\n\x1a\n") or len(icon_bytes) > 100000:
            raise ValueError("O ícone PNG é inválido ou muito grande.")

    if result["gamemode"] not in {"survival", "creative", "adventure", "spectator"}:
        raise ValueError("Modo de jogo inválido.")
    if result["difficulty"] not in {"peaceful", "easy", "normal", "hard"}:
        raise ValueError("Dificuldade inválida.")

    ranges = {
        "maxPlayers": (1, 100),
        "spawnProtection": (0, 64),
        "viewDistance": (2, 32),
        "simulationDistance": (2, 16),
        "idleMinutes": (10, 240),
    }
    for key, (minimum, maximum) in ranges.items():
        value = result.get(key)
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{key} precisa ser um número inteiro.")
        if not minimum <= value <= maximum:
            raise ValueError(f"{key} precisa ficar entre {minimum} e {maximum}.")

    if result["simulationDistance"] > result["viewDistance"]:
        raise ValueError("A simulação não pode exceder a distância visível.")

    for key in {
        "pvp",
        "commandBlocks",
        "whitelist",
        "onlineMode",
        "idleEnabled",
    }:
        if not isinstance(result.get(key), bool):
            raise ValueError(f"{key} precisa ser verdadeiro ou falso.")
    return result


def apply_settings(settings: dict[str, Any]) -> None:
    encoded = base64.b64encode(
        json.dumps(settings, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    script = rf"""
set -Eeuo pipefail
python3 - <<'PY'
import base64
import json
import os
import pwd
import grp
from pathlib import Path

settings = json.loads(base64.b64decode("{encoded}").decode("utf-8"))
properties_path = Path("/opt/minecraft/server.properties")
idle_path = Path("/etc/minecraft/azure-idle.env")
panel_path = Path("/etc/minecraft/panel.json")
icon_path = Path("/opt/minecraft/server-icon.png")

updates = {{
    "motd": settings["motd"],
    "gamemode": settings["gamemode"],
    "difficulty": settings["difficulty"],
    "max-players": str(settings["maxPlayers"]),
    "spawn-protection": str(settings["spawnProtection"]),
    "view-distance": str(settings["viewDistance"]),
    "simulation-distance": str(settings["simulationDistance"]),
    "pvp": str(settings["pvp"]).lower(),
    "enable-command-block": str(settings["commandBlocks"]).lower(),
    "white-list": str(settings["whitelist"]).lower(),
    "enforce-whitelist": str(settings["whitelist"]).lower(),
    "online-mode": str(settings["onlineMode"]).lower(),
    "enforce-secure-profile": str(settings["onlineMode"]).lower(),
}}

lines = properties_path.read_text(encoding="utf-8").splitlines()
seen = set()
output = []
for line in lines:
    if line and not line.startswith("#") and "=" in line:
        key = line.split("=", 1)[0]
        if key in updates:
            output.append(f"{{key}}={{updates[key]}}")
            seen.add(key)
            continue
    output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{{key}}={{value}}")

temporary = properties_path.with_suffix(".properties.panel.tmp")
temporary.write_text("\n".join(output) + "\n", encoding="utf-8")
os.chown(
    temporary,
    pwd.getpwnam("minecraft").pw_uid,
    grp.getgrnam("minecraft").gr_gid,
)
os.chmod(temporary, 0o600)
temporary.replace(properties_path)

panel_path.parent.mkdir(parents=True, exist_ok=True)
panel_path.write_text(
    json.dumps(
        {{
            "serverName": settings["serverName"],
            "customHost": settings["customHost"],
        }},
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
os.chmod(panel_path, 0o644)

if settings["iconBase64"]:
    icon_data = base64.b64decode(settings["iconBase64"].split(",", 1)[1])
    icon_path.write_bytes(icon_data)
    os.chown(
        icon_path,
        pwd.getpwnam("minecraft").pw_uid,
        grp.getgrnam("minecraft").gr_gid,
    )
    os.chmod(icon_path, 0o644)
else:
    icon_path.unlink(missing_ok=True)

idle_path.write_text(
    "AZURE_IDLE_DEALLOCATE="
    + str(settings["idleEnabled"]).lower()
    + "\nIDLE_MINUTES="
    + str(settings["idleMinutes"])
    + "\n",
    encoding="utf-8",
)
os.chmod(idle_path, 0o600)
PY

if grep -q '^AZURE_IDLE_DEALLOCATE=true$' /etc/minecraft/azure-idle.env; then
  systemctl enable --now minecraft-idle-deallocate.timer
else
  systemctl disable --now minecraft-idle-deallocate.timer
fi

systemctl restart minecraft.service
{REMOTE_WAIT}
"""
    invoke(script, timeout=600)


def execute_command(command: str) -> str:
    if not command or len(command) > 200 or "\n" in command or "\r" in command:
        raise ValueError("Comando vazio ou inválido.")
    encoded = base64.b64encode(command.encode("utf-8")).decode("ascii")
    script = rf"""
set -Eeuo pipefail
python3 - <<'PY'
import base64
import json
import re
import subprocess

command = base64.b64decode("{encoded}").decode("utf-8")
result = subprocess.run(
    ["/usr/local/bin/mc-rcon", command],
    capture_output=True,
    text=True,
    timeout=30,
)
message = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout or result.stderr).strip()
payload = {{
    "returnCode": result.returncode,
    "message": message or "Comando executado sem resposta.",
}}
print(
    "PANEL_RESULT:"
    + base64.b64encode(
        json.dumps(payload, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
)
raise SystemExit(result.returncode)
PY
"""
    result = marker_result(invoke(script))
    return str(result["message"])[:1000]


def player_token(value: Any, label: str, maximum: int = 32) -> str:
    text = str(value or "").strip()
    if not text or len(text) > maximum or not re.fullmatch(r"[A-Za-z0-9_.-]+", text):
        raise ValueError(f"{label} inválido.")
    return text


def player_action(payload: dict[str, Any]) -> str:
    action = str(payload.get("playerAction", "")).strip().lower()
    player = player_token(payload.get("player"), "Nome do jogador")
    commands = {
        "op": f"op {player}",
        "deop": f"deop {player}",
        "whitelist-add": f"whitelist add {player}",
        "whitelist-remove": f"whitelist remove {player}",
        "pardon": f"pardon {player}",
        "skin-clear": f"skin clear {player}",
    }

    if action in commands:
        return execute_command(commands[action])

    if action == "gamemode":
        gamemode = str(payload.get("gamemode", "")).strip().lower()
        if gamemode not in {"survival", "creative", "adventure", "spectator"}:
            raise ValueError("Modo de jogo inválido.")
        return execute_command(f"gamemode {gamemode} {player}")

    if action == "skin-set":
        skin = player_token(payload.get("skin"), "Nome da skin")
        return execute_command(f"skin set {skin} {player}")

    if action in {"kick", "ban"}:
        reason = (
            str(payload.get("reason", ""))
            .replace("\r", " ")
            .replace("\n", " ")
            .strip()[:80]
        )
        if reason and not re.fullmatch(r"[\wÀ-ÿ .,!?:;()'/-]+", reason):
            raise ValueError("O motivo contém caracteres inválidos.")
        command = f"{action} {player}"
        if reason:
            command += f" {reason}"
        return execute_command(command)

    raise ValueError("Ação de jogador não permitida.")


def perform() -> tuple[dict[str, Any], str]:
    if OPERATION not in ALLOWED_OPERATIONS:
        raise ValueError(f"Operação não permitida: {OPERATION}")
    payload = decode_payload()

    if OPERATION == "start":
        started = start_vm()
        invoke(REMOTE_WAIT, timeout=600)
        return collect_status("running"), (
            "VM iniciada e Paper pronto para jogadores."
            if started
            else "A VM já estava ligada; Paper está pronto."
        )

    if OPERATION == "stop":
        state = power_state()
        if state == "running":
            invoke(
                "set -Eeuo pipefail\n"
                "/usr/local/sbin/minecraft-backup\n"
                "systemctl stop minecraft.service\n",
                timeout=900,
            )
        if state != "deallocated":
            azure(
                "vm",
                "deallocate",
                "--resource-group",
                RESOURCE_GROUP,
                "--name",
                VM_NAME,
                timeout=900,
            )
        message = (
            "Backup concluído e VM desalocada."
            if state == "running"
            else "VM desalocada."
        )
        return collect_status("deallocated"), message

    if OPERATION == "restart":
        started = start_vm()
        if started:
            invoke(REMOTE_WAIT, timeout=600)
            message = "VM iniciada e Paper pronto."
        else:
            invoke(
                "set -Eeuo pipefail\n"
                "systemctl restart minecraft.service\n"
                + REMOTE_WAIT,
                timeout=600,
            )
            message = "Paper reiniciado com sucesso."
        return collect_status("running"), message

    if OPERATION == "status":
        return collect_status(), "Status atualizado."

    if power_state() != "running":
        raise RuntimeError("A VM está desligada. Inicie o servidor primeiro.")

    if OPERATION == "apply":
        settings = validate_settings(payload)
        apply_settings(settings)
        return collect_status("running"), "Configurações salvas e Paper reiniciado."

    if OPERATION == "command":
        if payload.get("playerAction"):
            message = player_action(payload)
        else:
            message = execute_command(str(payload.get("command", "")).lstrip("/"))
        return collect_status("running"), message

    if OPERATION == "backup":
        output = invoke(
            "set -Eeuo pipefail\n/usr/local/sbin/minecraft-backup\n",
            timeout=900,
        )
        path = re.findall(r"/opt/minecraft/backups/[^\s]+", output)
        message = f"Backup criado: {path[-1]}" if path else "Backup criado com sucesso."
        return collect_status("running"), message

    if OPERATION == "update":
        invoke(
            "set -Eeuo pipefail\n/usr/local/sbin/minecraft-update\n",
            timeout=1200,
        )
        invoke(REMOTE_WAIT, timeout=600)
        return collect_status("running"), "Paper e plugins gerenciados foram atualizados."

    raise AssertionError("Operação sem implementação.")


def write_status(
    data: dict[str, Any],
    message: str,
    *,
    success: bool,
) -> None:
    data.update(
        {
            "requestId": REQUEST_ID,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "operation": OPERATION,
            "success": success,
            "message": message,
        }
    )
    STATUS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    try:
        data, message = perform()
        write_status(data, message, success=True)
        print(message)
        return 0
    except Exception as error:  # O status de falha precisa chegar ao painel.
        previous = load_previous()
        try:
            state = power_state()
        except Exception:
            state = previous.get("vm", {}).get("state", "unknown")
        previous["vm"] = {
            "state": state,
            "publicIp": previous.get("vm", {}).get("publicIp", ""),
        }
        message = str(error).strip() or error.__class__.__name__
        write_status(previous, message[-1200:], success=False)
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
