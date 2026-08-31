from typing import Any

from fantasy_bot_crawler.models.player import ExternalIdentity, Player


def to_player(player: Any) -> Player:
    name = getattr(player, "name", "Unknown") or "Unknown"
    return Player(id=f"plr_{name.lower()}", name=name, name_key=name.lower().strip())


def to_external_identity(player: Any) -> ExternalIdentity:
    return ExternalIdentity(provider="ESPN", external_id=str(player.playerId))

