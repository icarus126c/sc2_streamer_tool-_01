import html
import importlib.machinery
import importlib.util
import json
import os
import re
import sys
import types


def install_imp_shim():
    shim = types.ModuleType("imp")

    def find_module(name, path=None):
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if not spec or not spec.loader:
            raise ImportError(name)
        return None, spec.origin, ("", "r", 1)

    def load_module(name, _fp, pathname, _description):
        if name in sys.modules:
            return sys.modules[name]
        spec = importlib.util.spec_from_file_location(name, pathname)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    shim.find_module = find_module
    shim.load_module = load_module
    sys.modules["imp"] = shim


install_imp_shim()

from mpyq import MPQArchive
from s2protocol.versions import build, latest
from s2protocol.s2_cli import read_contents


RESULTS = {
    1: "Win",
    2: "Loss",
    3: "Tie",
}


def clean_text(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    value = html.unescape(str(value))
    value = value.replace("<sp/>", " ")
    return re.sub(r"\s+", " ", value).strip()


def normalize_race(value):
    text = clean_text(value)
    mapping = {
        "星灵": "Protoss",
        "异虫": "Zerg",
        "人类": "Terran",
        "Prot": "Protoss",
        "Zerg": "Zerg",
        "Terr": "Terran",
        "Rand": "Random",
    }
    return mapping.get(text, text)


def load_protocol(archive):
    header = latest().decode_replay_header(archive.header["user_data_header"]["content"])
    base_build = header["m_version"]["m_baseBuild"]
    try:
        return build(base_build), base_build
    except Exception:
        return latest(), base_build


def parse_replay(replay_path, config):
    archive = MPQArchive(replay_path)
    protocol, base_build = load_protocol(archive)
    details = protocol.decode_replay_details(read_contents(archive, "replay.details"))
    metadata = {}
    try:
        metadata = json.loads(read_contents(archive, "replay.gamemetadata.json"))
    except Exception:
        metadata = {}

    meta_players = metadata.get("Players") or []
    players = []
    for index, player in enumerate(details.get("m_playerList", []), start=1):
        meta = meta_players[index - 1] if index - 1 < len(meta_players) else {}
        toon = player.get("m_toon") or {}
        result = meta.get("Result") or RESULTS.get(player.get("m_result"), "Unknown")
        selected_race = meta.get("SelectedRace") or player.get("m_race")
        players.append(
            {
                "slot": index,
                "name": clean_text(player.get("m_name", "")),
                "toonId": toon.get("m_id"),
                "region": toon.get("m_region"),
                "realm": toon.get("m_realm"),
                "teamId": player.get("m_teamId"),
                "result": result,
                "race": normalize_race(selected_race),
                "mmr": meta.get("MMR"),
                "apm": meta.get("APM"),
            }
        )

    folder_toon_id = infer_toon_id_from_path(replay_path)
    self_toon_ids = {int(item) for item in config.get("playerToonIds", []) if str(item).isdigit()}
    if config.get("preferReplayFolderToonId", True) and folder_toon_id:
        self_toon_ids = {folder_toon_id}
    self_names = [str(item).lower() for item in config.get("playerNames", []) if str(item).strip()]

    for player in players:
        name_lower = player["name"].lower()
        player["isSelf"] = (
            player.get("toonId") in self_toon_ids
            or any(token in name_lower for token in self_names)
        )

    self_players = [player for player in players if player.get("isSelf")]
    self_team_ids = {player.get("teamId") for player in self_players}
    opponents = [player for player in players if player.get("teamId") not in self_team_ids] if self_players else []

    self_result = None
    if self_players:
        first_result = self_players[0].get("result")
        if first_result == "Win":
            self_result = "W"
        elif first_result == "Loss":
            self_result = "L"

    map_name = metadata.get("Title") or clean_text(details.get("m_title") or os.path.basename(replay_path))
    duration = metadata.get("Duration")
    output = {
        "ok": True,
        "path": replay_path,
        "map": map_name,
        "durationSeconds": duration,
        "baseBuild": base_build,
        "gameVersion": metadata.get("GameVersion"),
        "folderToonId": folder_toon_id,
        "players": players,
        "selfPlayers": self_players,
        "opponents": opponents,
        "selfResult": self_result,
        "format": format_match(self_players, opponents, map_name, duration),
    }
    return output


def format_match(self_players, opponents, map_name, duration):
    if not self_players:
        return f"{map_name}：未识别本机玩家"
    result = self_players[0].get("result", "Unknown")
    self_mmr = "/".join(format_number(player.get("mmr")) for player in self_players)
    opponent_names = " / ".join(player.get("name", "对手") for player in opponents) or "对手"
    opponent_mmr = "/".join(format_number(player.get("mmr")) for player in opponents) if opponents else "--"
    minutes = ""
    if isinstance(duration, (int, float)):
        minutes = f" {int(duration // 60)}:{int(duration % 60):02d}"
    return f"{map_name}{minutes} {result} 自己MMR {self_mmr} 对手 {opponent_names}({opponent_mmr})"


def format_number(value):
    return "--" if value is None else str(value)


def infer_toon_id_from_path(replay_path):
    match = re.search(r"[\\/]\d+-S2-\d+-(\d+)[\\/]Replays[\\/]", replay_path, re.IGNORECASE)
    return int(match.group(1)) if match else None


def main():
    replay_path = sys.argv[1]
    config = {}
    if len(sys.argv) > 2 and os.path.exists(sys.argv[2]):
        with open(sys.argv[2], "r", encoding="utf-8-sig") as handle:
            config = json.load(handle)
    try:
        print(json.dumps(parse_replay(replay_path, config), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error), "path": replay_path}, ensure_ascii=False))
        sys.exit(2)


if __name__ == "__main__":
    main()
