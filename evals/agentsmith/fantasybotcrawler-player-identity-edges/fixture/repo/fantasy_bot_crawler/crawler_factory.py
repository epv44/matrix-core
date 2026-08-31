from fantasy_bot_crawler.models.player import ExternalIdentity, Player
from fantasy_bot_crawler.repositories.player_repository import PlayerRepository


def build_player_repository() -> PlayerRepository:
    return PlayerRepository()


def materialize_identity(player: Player, identity: ExternalIdentity) -> tuple[str, str]:
    return player.id, identity.external_id

